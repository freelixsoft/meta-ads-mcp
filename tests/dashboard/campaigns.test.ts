import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metaGetMock = vi.fn();
const metaGetPaginatedMock = vi.fn();

vi.mock("../../src/meta/client.js", () => ({
  metaApiClient: {
    get: (...args: unknown[]) => metaGetMock(...args),
    getPaginated: (...args: unknown[]) => metaGetPaginatedMock(...args),
  },
}));

const { getCampaignsWithMetrics, filterCampaigns } = await import(
  "../../src/dashboard/services/campaigns.js"
);
const { dashboardCache } = await import("../../src/dashboard/cache.js");
const { resolveRange } = await import("../../src/dashboard/schemas.js");

const CTX = { fbUserId: "1000000000001", tokenHash: "abc123abc123" };
const ACCOUNT = {
  id: "act_111",
  accountId: "111",
  name: "Acme TR",
  status: "ACTIVE" as const,
  statusCode: 1,
  currency: "TRY",
  timezone: "Europe/Istanbul",
  businessName: "Acme Holding",
};
const RANGE = resolveRange({ preset: "last_30d" });
const ALL = { status: "ALL" as const, q: undefined };

const CAMPAIGNS = [
  {
    id: "c1",
    name: "Kış Kampanyası",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    objective: "OUTCOME_SALES",
    daily_budget: "25000",
    lifetime_budget: undefined,
    created_time: "2026-08-01T00:00:00+0000",
  },
  {
    id: "c2",
    name: "Yaz İndirimi",
    status: "PAUSED",
    effective_status: "CAMPAIGN_PAUSED",
    objective: "OUTCOME_TRAFFIC",
    daily_budget: undefined,
    lifetime_budget: "500000",
    created_time: "2026-07-01T00:00:00+0000",
  },
  {
    id: "c3",
    name: "Test - No Delivery",
    status: "PAUSED",
    effective_status: "CAMPAIGN_PAUSED",
    objective: "OUTCOME_AWARENESS",
    created_time: "2026-06-01T00:00:00+0000",
  },
];

const INSIGHT_ROWS = [
  {
    campaign_id: "c1",
    spend: "1000",
    impressions: "50000",
    reach: "30000",
    clicks: "1500",
    actions: [
      { action_type: "omni_purchase", value: "40" },
      { action_type: "omni_add_to_cart", value: "180" },
    ],
    action_values: [{ action_type: "omni_purchase", value: "6000" }],
    cost_per_action_type: [{ action_type: "omni_purchase", value: "25" }],
  },
  {
    campaign_id: "c2",
    spend: "200",
    impressions: "20000",
    reach: "15000",
    clicks: "400",
    actions: [{ action_type: "omni_add_to_cart", value: "10" }],
  },
];

beforeEach(() => {
  dashboardCache.clear();
  metaGetPaginatedMock.mockImplementation(async (path: string) =>
    path.endsWith("/campaigns") ? CAMPAIGNS : INSIGHT_ROWS,
  );
  metaGetMock.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("campaign + insights merge", () => {
  it("joins metadata to metrics by campaign id", async () => {
    const result = await getCampaignsWithMetrics(CTX, ACCOUNT, RANGE, ALL);
    const byId = Object.fromEntries(result.campaigns.map((c) => [c.id, c]));

    expect(byId.c1.name).toBe("Kış Kampanyası");
    expect(byId.c1.metrics.spend).toBe(1000);
    expect(byId.c1.metrics.purchases).toBe(40);
    expect(byId.c1.metrics.addToCart).toBe(180);
    expect(byId.c1.metrics.costPerPurchase).toBe(25);
    expect(byId.c1.metrics.roas).toBeCloseTo(6, 10);
    expect(byId.c1.metrics.ctr).toBeCloseTo(3, 10);
  });

  it("keeps campaigns that had no delivery, with zeroed metrics", async () => {
    const result = await getCampaignsWithMetrics(CTX, ACCOUNT, RANGE, ALL);
    const c3 = result.campaigns.find((c) => c.id === "c3");

    expect(c3).toBeDefined();
    expect(c3?.metrics.spend).toBe(0);
    expect(c3?.metrics.impressions).toBe(0);
    expect(c3?.metrics.roas).toBeNull();
    expect(c3?.metrics.ctr).toBeNull();
  });

  it("leaves ROAS null for a campaign with no purchase value", async () => {
    const result = await getCampaignsWithMetrics(CTX, ACCOUNT, RANGE, ALL);
    const c2 = result.campaigns.find((c) => c.id === "c2");
    expect(c2?.metrics.purchases).toBe(0);
    expect(c2?.metrics.roas).toBeNull();
  });

  it("converts budgets from Meta's minor units", async () => {
    const result = await getCampaignsWithMetrics(CTX, ACCOUNT, RANGE, ALL);
    const byId = Object.fromEntries(result.campaigns.map((c) => [c.id, c]));

    expect(byId.c1.dailyBudget).toBe(250);
    expect(byId.c1.lifetimeBudget).toBeNull();
    expect(byId.c2.lifetimeBudget).toBe(5000);
  });

  it("returns only whitelisted campaign keys", async () => {
    const result = await getCampaignsWithMetrics(CTX, ACCOUNT, RANGE, ALL);
    expect(Object.keys(result.campaigns[0]).sort()).toEqual([
      "dailyBudget",
      "effectiveStatus",
      "id",
      "lifetimeBudget",
      "metrics",
      "name",
      "objective",
      "status",
    ]);
  });

  it("does not leak raw Meta fields such as created_time", async () => {
    const result = await getCampaignsWithMetrics(CTX, ACCOUNT, RANGE, ALL);
    expect(JSON.stringify(result)).not.toContain("created_time");
    expect(JSON.stringify(result)).not.toContain("effective_status");
  });

  it("carries the account currency so the browser never guesses", async () => {
    const result = await getCampaignsWithMetrics(CTX, ACCOUNT, RANGE, ALL);
    expect(result.account.currency).toBe("TRY");
  });

  it("orders by spend descending", async () => {
    const result = await getCampaignsWithMetrics(CTX, ACCOUNT, RANGE, ALL);
    expect(result.campaigns.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("filterCampaigns", () => {
  const rows = [
    { id: "a", name: "Kış Kampanyası", status: "ACTIVE" },
    { id: "b", name: "Yaz İndirimi", status: "PAUSED" },
    { id: "c", name: "ISTANBUL Retarget", status: "ACTIVE" },
  ] as Parameters<typeof filterCampaigns>[0];

  it("passes everything through for ALL with no search", () => {
    expect(filterCampaigns(rows, { status: "ALL", q: undefined })).toHaveLength(3);
  });

  it("filters by status", () => {
    expect(filterCampaigns(rows, { status: "PAUSED", q: undefined }).map((c) => c.id)).toEqual(["b"]);
  });

  it("searches case-insensitively", () => {
    expect(filterCampaigns(rows, { status: "ALL", q: "kış" }).map((c) => c.id)).toEqual(["a"]);
    expect(filterCampaigns(rows, { status: "ALL", q: "YAZ" }).map((c) => c.id)).toEqual(["b"]);
  });

  it("matches across the Turkish i-family in both directions", () => {
    // Turkish locale lowercasing turns "I" into dotless "ı", so a plain
    // toLocaleLowerCase("tr") would make none of these match.
    for (const needle of ["istanbul", "İSTANBUL", "ıstanbul", "Istanbul"]) {
      expect(filterCampaigns(rows, { status: "ALL", q: needle }).map((c) => c.id), needle).toEqual([
        "c",
      ]);
    }
    // Dotless ı in "Kış" folds to i, so "kiş" matches...
    expect(filterCampaigns(rows, { status: "ALL", q: "kiş" }).map((c) => c.id)).toEqual(["a"]);
    // ...but ş is left distinct on purpose: this is case folding, not
    // diacritic stripping, so "kis" is still a different word.
    expect(filterCampaigns(rows, { status: "ALL", q: "kis" })).toHaveLength(0);
  });

  it("combines status and search", () => {
    expect(filterCampaigns(rows, { status: "ACTIVE", q: "retarget" }).map((c) => c.id)).toEqual(["c"]);
  });

  it("ignores a whitespace-only search", () => {
    expect(filterCampaigns(rows, { status: "ALL", q: "   " })).toHaveLength(3);
  });
});
