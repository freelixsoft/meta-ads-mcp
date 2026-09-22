import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage of the campaign → ad set → ad drill-down over real HTTP.
 * Same three mocked seams as the Phase 1 suite: session, token store, Meta client.
 */

const SESSION_HEADER = "x-test-session";

const getSessionMock = vi.fn();
const metaGetMock = vi.fn();
const metaGetPaginatedMock = vi.fn();

vi.mock("../../src/auth/session.js", () => ({
  getSession: (req: { headers: Record<string, string | undefined> }) =>
    getSessionMock(req.headers[SESSION_HEADER]),
  setSession: vi.fn(),
  clearSession: vi.fn(),
  configureSessionJtiStore: vi.fn(),
}));

vi.mock("../../src/store/meta-token-repo.js", () => ({
  getDecryptedToken: async () => META_TOKEN,
  listTokens: async () => [],
  getDefaultTokenName: async () => "personal",
}));

vi.mock("../../src/meta/client.js", () => ({
  metaApiClient: {
    get: (...args: unknown[]) => metaGetMock(...args),
    getPaginated: (...args: unknown[]) => metaGetPaginatedMock(...args),
  },
}));

const { default: express } = await import("express");
const { createDashboardApiRouter } = await import("../../src/dashboard/router.js");
const { dashboardCache } = await import("../../src/dashboard/cache.js");

const META_TOKEN = "EAAtest_never_leaves_the_server_0123456789";
const SESSION = { fbUserId: "1000000000001", email: "ops@example.com", name: "Ops User" };

const ACCOUNTS = [
  {
    id: "act_111",
    account_id: "111",
    name: "Acme TR",
    account_status: 1,
    currency: "TRY",
    timezone_name: "Europe/Istanbul",
    business_name: "Acme Holding",
  },
  {
    id: "act_222",
    account_id: "222",
    name: "Other TR",
    account_status: 1,
    currency: "TRY",
    timezone_name: "Europe/Istanbul",
  },
];

const CAMPAIGN = {
  id: "100",
  name: "Kış Kampanyası",
  account_id: "111",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  objective: "OUTCOME_SALES",
  daily_budget: "25000",
};

const ADSET = {
  id: "200",
  name: "TR - 25-45 - Retarget",
  account_id: "111",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  campaign_id: "100",
  campaign: { id: "100", name: "Kış Kampanyası" },
  daily_budget: "10000",
};

const AD = {
  id: "300",
  name: "Video - Kış 15sn",
  account_id: "111",
  status: "PAUSED",
  effective_status: "ADSET_PAUSED",
  adset_id: "200",
  campaign_id: "100",
  adset: { id: "200", name: "TR - 25-45 - Retarget" },
  campaign: { id: "100", name: "Kış Kampanyası" },
  creative: { id: "900900" },
};

/** An ad set that exists and the token can see, but in a different ad account. */
const FOREIGN_ADSET = { ...ADSET, id: "999", account_id: "222" };

const ADSET_ROWS = [
  {
    id: "200",
    name: "TR - 25-45 - Retarget",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    campaign_id: "100",
    daily_budget: "10000",
  },
  {
    id: "201",
    name: "TR - Lookalike",
    status: "PAUSED",
    effective_status: "CAMPAIGN_PAUSED",
    campaign_id: "100",
  },
];

const AD_ROWS = [
  {
    id: "300",
    name: "Video - Kış 15sn",
    status: "PAUSED",
    effective_status: "ADSET_PAUSED",
    adset_id: "200",
    campaign_id: "100",
    creative: { id: "900900" },
  },
  { id: "301", name: "Statik - Kış", status: "ACTIVE", adset_id: "200", campaign_id: "100" },
];

const ADSET_INSIGHT_ROWS = [
  {
    adset_id: "200",
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
];

const AD_INSIGHT_ROWS = [
  {
    ad_id: "300",
    spend: "400",
    impressions: "20000",
    reach: "12000",
    clicks: "500",
    actions: [{ action_type: "omni_purchase", value: "10" }],
    action_values: [{ action_type: "omni_purchase", value: "1500" }],
  },
];

let server: Server;
let baseUrl: string;

function request(path: string, options: { session?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.session !== false) headers[SESSION_HEADER] = "valid";
  return fetch(`${baseUrl}${path}`, { headers, redirect: "manual" });
}

/** Objects Meta can resolve by id, keyed exactly as the Graph path would be. */
let entitiesById: Record<string, unknown>;
let summaryByPath: (path: string, params: Record<string, unknown>) => unknown;

beforeAll(async () => {
  const app = express();
  app.use("/api/dashboard", createDashboardApiRouter(new URL("http://localhost:3000")));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  dashboardCache.clear();
  getSessionMock.mockImplementation(async (marker: string | undefined) =>
    marker === "valid" ? SESSION : null,
  );

  entitiesById = { "100": CAMPAIGN, "200": ADSET, "300": AD, "999": FOREIGN_ADSET };

  summaryByPath = (_path, params) =>
    params.time_increment
      ? {
          data: [
            { date_start: "2026-09-18", spend: "600", impressions: "30000", clicks: "900" },
            { date_start: "2026-09-19", spend: "400", impressions: "20000", clicks: "600" },
          ],
        }
      : {
          data: [
            {
              date_start: "2026-09-13",
              date_stop: "2026-09-19",
              spend: "1000",
              impressions: "50000",
              reach: "30000",
              clicks: "1500",
              actions: [
                { action_type: "omni_purchase", value: "40" },
                { action_type: "omni_add_to_cart", value: "180" },
              ],
              action_values: [{ action_type: "omni_purchase", value: "6000" }],
            },
          ],
        };

  metaGetMock.mockImplementation(async (path: string, params: Record<string, unknown> = {}) => {
    if (path.endsWith("/insights")) return summaryByPath(path, params);
    const id = path.replace(/^\//, "");
    const entity = entitiesById[id];
    if (!entity) throw new Error(`Unsupported get operation on object of type ... (Meta code 100)`);
    return entity;
  });

  metaGetPaginatedMock.mockImplementation(async (path: string) => {
    if (path === "/me/adaccounts") return ACCOUNTS;
    if (path.endsWith("/adsets")) return ADSET_ROWS;
    if (path.endsWith("/ads")) return AD_ROWS;
    if (path.endsWith("/insights")) {
      return path.startsWith("/100") ? ADSET_INSIGHT_ROWS : AD_INSIGHT_ROWS;
    }
    return [];
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("campaign → ad set drill-down", () => {
  it("returns ad sets for a campaign with metrics merged on", async () => {
    const response = await request("/api/dashboard/accounts/act_111/campaigns/100/adsets");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      parent: { level: string; id: string; name: string };
      account: { currency: string };
      rows: Array<Record<string, unknown>>;
    };

    expect(body.parent).toEqual({ level: "campaign", id: "100", name: "Kış Kampanyası" });
    expect(body.account.currency).toBe("TRY");
    expect(body.rows).toHaveLength(2);

    const delivered = body.rows.find((row) => row.id === "200") as {
      metrics: Record<string, number | null>;
      campaignName: string;
      dailyBudget: number;
    };
    expect(delivered.campaignName).toBe("Kış Kampanyası");
    expect(delivered.dailyBudget).toBe(100);
    expect(delivered.metrics.spend).toBe(1000);
    expect(delivered.metrics.purchases).toBe(40);
    expect(delivered.metrics.addToCart).toBe(180);
    expect(delivered.metrics.costPerPurchase).toBe(25);
    expect(delivered.metrics.roas).toBeCloseTo(6, 10);
    expect(delivered.metrics.ctr).toBeCloseTo(3, 10);
  });

  it("keeps ad sets with no delivery, zeroed rather than dropped", async () => {
    const response = await request("/api/dashboard/accounts/act_111/campaigns/100/adsets");
    const body = (await response.json()) as { rows: Array<{ id: string; metrics: Record<string, unknown> }> };
    const quiet = body.rows.find((row) => row.id === "201");

    expect(quiet).toBeDefined();
    expect(quiet?.metrics.spend).toBe(0);
    expect(quiet?.metrics.roas).toBeNull();
    expect(quiet?.metrics.ctr).toBeNull();
  });

  it("orders by spend descending", async () => {
    const response = await request("/api/dashboard/accounts/act_111/campaigns/100/adsets");
    const body = (await response.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((row) => row.id)).toEqual(["200", "201"]);
  });

  it("returns an empty row list rather than an error when the campaign has no ad sets", async () => {
    metaGetPaginatedMock.mockImplementation(async (path: string) => {
      if (path === "/me/adaccounts") return ACCOUNTS;
      return [];
    });
    const response = await request("/api/dashboard/accounts/act_111/campaigns/100/adsets");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: unknown[]; parent: unknown };
    expect(body.rows).toEqual([]);
    expect(body.parent).toBeTruthy();
  });
});

describe("ad set → ad drill-down", () => {
  it("returns ads carrying both parents and the creative id", async () => {
    const response = await request("/api/dashboard/accounts/act_111/adsets/200/ads");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      parent: { level: string; name: string };
      rows: Array<Record<string, unknown>>;
    };

    expect(body.parent.level).toBe("adset");
    const ad = body.rows.find((row) => row.id === "300") as Record<string, unknown>;
    expect(ad.name).toBe("Video - Kış 15sn");
    expect(ad.adSetId).toBe("200");
    expect(ad.adSetName).toBe("TR - 25-45 - Retarget");
    expect(ad.campaignId).toBe("100");
    expect(ad.campaignName).toBe("Kış Kampanyası");
    expect(ad.creativeId).toBe("900900");
    expect(ad.status).toBe("PAUSED");
    expect(ad.effectiveStatus).toBe("ADSET_PAUSED");
  });

  it("leaves the creative id null when Meta does not return one", async () => {
    const response = await request("/api/dashboard/accounts/act_111/adsets/200/ads");
    const body = (await response.json()) as { rows: Array<{ id: string; creativeId: unknown }> };
    expect(body.rows.find((row) => row.id === "301")?.creativeId).toBeNull();
  });

  it("filters by status", async () => {
    const response = await request("/api/dashboard/accounts/act_111/adsets/200/ads?status=ACTIVE");
    const body = (await response.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((row) => row.id)).toEqual(["301"]);
  });

  it("searches by name with Turkish-safe folding", async () => {
    const response = await request(
      `/api/dashboard/accounts/act_111/adsets/200/ads?q=${encodeURIComponent("kiş")}`,
    );
    const body = (await response.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((row) => row.id).sort()).toEqual(["300", "301"]);
  });
});

describe("hierarchy authorization", () => {
  it("rejects an ad set that belongs to another ad account", async () => {
    const response = await request("/api/dashboard/accounts/act_111/adsets/999/ads");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "account_forbidden" },
    });
  });

  it("never lists children of a foreign ad set", async () => {
    await request("/api/dashboard/accounts/act_111/adsets/999/ads");
    const listedAds = metaGetPaginatedMock.mock.calls.filter((call) =>
      String(call[0]).endsWith("/ads"),
    );
    expect(listedAds).toHaveLength(0);
  });

  it("rejects an id Meta cannot resolve, without distinguishing it from a foreign one", async () => {
    const unknown = await request("/api/dashboard/accounts/act_111/campaigns/123456/adsets");
    const foreign = await request("/api/dashboard/accounts/act_111/adsets/999/ads");
    expect(unknown.status).toBe(403);
    expect((await unknown.json()).error.code).toBe((await foreign.json()).error.code);
  });

  it("rejects a non-numeric entity id before any Meta call", async () => {
    metaGetMock.mockClear();
    for (const id of ["abc", "100;drop", "..%2F..", "act_100"]) {
      const response = await request(
        `/api/dashboard/accounts/act_111/campaigns/${encodeURIComponent(id)}/adsets`,
      );
      expect(response.status, id).toBe(400);
    }
    expect(metaGetMock).not.toHaveBeenCalled();
  });

  it("still enforces the account gate before the entity gate", async () => {
    const response = await request("/api/dashboard/accounts/act_999999/campaigns/100/adsets");
    expect(response.status).toBe(403);
    // Resolution of the campaign must never have been attempted.
    expect(metaGetMock).not.toHaveBeenCalled();
  });

  it("reports an expired token as a connection problem, not as a forbidden object", async () => {
    metaGetMock.mockImplementation(async (path: string) => {
      if (path === "/100") {
        throw new Error("Invalid or expired access token. Please provide a valid token. (Meta: ...)");
      }
      return { data: [] };
    });
    const response = await request("/api/dashboard/accounts/act_111/campaigns/100/adsets");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "meta_connection_expired" },
    });
  });
});

describe("entity insights", () => {
  it("returns summary, series and entity metadata for a campaign", async () => {
    const response = await request(
      "/api/dashboard/accounts/act_111/campaigns/100/insights?preset=last_7d",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entity: Record<string, unknown>;
      summary: Record<string, number | null>;
      series: Array<{ date: string }>;
      resolvedRange: { since: string; until: string };
      comparison: unknown;
    };

    expect(body.entity.level).toBe("campaign");
    expect(body.entity.name).toBe("Kış Kampanyası");
    expect(body.entity.objective).toBe("OUTCOME_SALES");
    expect(body.entity.dailyBudget).toBe(250);
    expect(body.summary.spend).toBe(1000);
    expect(body.summary.reach).toBe(30000);
    expect(body.summary.roas).toBeCloseTo(6, 10);
    expect(body.series.map((point) => point.date)).toEqual(["2026-09-18", "2026-09-19"]);
    expect(body.resolvedRange).toEqual({ since: "2026-09-13", until: "2026-09-19" });
    expect(body.comparison).toBeNull();
  });

  it("works at ad set and ad level", async () => {
    for (const [path, level] of [
      ["/api/dashboard/accounts/act_111/adsets/200/insights", "adset"],
      ["/api/dashboard/accounts/act_111/ads/300/insights", "ad"],
    ] as const) {
      const response = await request(path);
      expect(response.status, path).toBe(200);
      const body = (await response.json()) as { entity: { level: string } };
      expect(body.entity.level).toBe(level);
    }
  });

  it("exposes the creative id on ad-level insights", async () => {
    const response = await request("/api/dashboard/accounts/act_111/ads/300/insights");
    const body = (await response.json()) as { entity: { creativeId: string; adSetName: string } };
    expect(body.entity.creativeId).toBe("900900");
    expect(body.entity.adSetName).toBe("TR - 25-45 - Retarget");
  });

  it("does not request a comparison unless asked", async () => {
    await request("/api/dashboard/accounts/act_111/campaigns/100/insights");
    const withTimeRange = metaGetMock.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown> | undefined)?.time_range !== undefined,
    );
    expect(withTimeRange).toHaveLength(0);
  });
});

describe("previous-period comparison", () => {
  it("queries the equivalent window immediately before the resolved range", async () => {
    await request("/api/dashboard/accounts/act_111/campaigns/100/insights?preset=last_7d&compare=1");

    const comparisonCall = metaGetMock.mock.calls.find(
      (call) => (call[1] as Record<string, unknown> | undefined)?.time_range !== undefined,
    );
    expect(comparisonCall).toBeDefined();
    // Meta resolved the current period to 2026-09-13..19, so the previous
    // equivalent period is the seven days ending 2026-09-12.
    expect((comparisonCall![1] as Record<string, unknown>).time_range).toBe(
      JSON.stringify({ since: "2026-09-06", until: "2026-09-12" }),
    );
  });

  it("returns previous metrics, deltas and the lower-is-better hint", async () => {
    let call = 0;
    summaryByPath = (_path, params) => {
      if (params.time_increment) return { data: [] };
      call += 1;
      return call === 1
        ? {
            data: [
              {
                date_start: "2026-09-13",
                date_stop: "2026-09-19",
                spend: "1200",
                impressions: "50000",
                clicks: "1000",
                actions: [{ action_type: "omni_purchase", value: "40" }],
                action_values: [{ action_type: "omni_purchase", value: "6000" }],
              },
            ],
          }
        : {
            data: [
              {
                spend: "1000",
                impressions: "40000",
                clicks: "800",
                actions: [{ action_type: "omni_purchase", value: "25" }],
                action_values: [{ action_type: "omni_purchase", value: "4000" }],
              },
            ],
          };
    };

    const response = await request(
      "/api/dashboard/accounts/act_111/campaigns/100/insights?preset=last_7d&compare=1",
    );
    const body = (await response.json()) as {
      summary: Record<string, number>;
      comparison: {
        range: { since: string; until: string };
        previous: Record<string, number>;
        changes: Record<string, { absolute: number | null; percent: number | null }>;
        lowerIsBetter: string[];
      };
    };

    expect(body.comparison.range).toEqual({ since: "2026-09-06", until: "2026-09-12" });
    expect(body.comparison.previous.spend).toBe(1000);
    expect(body.comparison.previous.purchases).toBe(25);
    expect(body.comparison.changes.spend).toEqual({ absolute: 200, percent: 20 });
    expect(body.comparison.changes.purchases).toEqual({ absolute: 15, percent: 60 });
    expect(body.comparison.changes.roas.absolute).toBeCloseTo(1, 10);
    expect(body.comparison.lowerIsBetter).toContain("costPerPurchase");
  });

  it("still compares when the current period is empty, using the account timezone", async () => {
    summaryByPath = (_path, params) =>
      params.time_increment || !params.time_range
        ? { data: [] }
        : { data: [{ spend: "500", impressions: "10000", clicks: "100" }] };

    const response = await request(
      "/api/dashboard/accounts/act_111/campaigns/100/insights?preset=last_7d&compare=1",
    );
    const body = (await response.json()) as {
      summary: { spend: number };
      comparison: { previous: { spend: number }; changes: Record<string, { absolute: number }> };
    };

    expect(body.summary.spend).toBe(0);
    expect(body.comparison.previous.spend).toBe(500);
    expect(body.comparison.changes.spend.absolute).toBe(-500);
  });

  it("anchors a custom range's comparison to the requested dates", async () => {
    await request(
      "/api/dashboard/accounts/act_111/campaigns/100/insights?preset=custom&since=2026-08-01&until=2026-08-31&compare=1",
    );
    const calls = metaGetMock.mock.calls
      .map((call) => (call[1] as Record<string, unknown> | undefined)?.time_range)
      .filter(Boolean);
    // August 1-31 is 31 days, so the equivalent window before it is all of July.
    expect(calls).toContain(JSON.stringify({ since: "2026-07-01", until: "2026-07-31" }));
  });

  it("caches the compared and uncompared variants separately", async () => {
    await request("/api/dashboard/accounts/act_111/campaigns/100/insights?preset=last_7d");
    const afterPlain = metaGetMock.mock.calls.length;
    await request("/api/dashboard/accounts/act_111/campaigns/100/insights?preset=last_7d&compare=1");
    expect(metaGetMock.mock.calls.length).toBeGreaterThan(afterPlain);
  });
});

describe("hierarchy DTO whitelisting", () => {
  it("never leaks the token or raw Meta ownership fields", async () => {
    for (const path of [
      "/api/dashboard/accounts/act_111/campaigns/100/adsets",
      "/api/dashboard/accounts/act_111/adsets/200/ads",
      "/api/dashboard/accounts/act_111/ads/300/insights",
    ]) {
      const body = await (await request(path)).text();
      expect(body, path).not.toContain(META_TOKEN);
      expect(body, path).not.toContain("account_id");
      expect(body, path).not.toContain("effective_status");
      expect(body, path).not.toContain("daily_budget");
    }
  });

  it("maps drill-down rows to exactly the documented keys", async () => {
    const response = await request("/api/dashboard/accounts/act_111/campaigns/100/adsets");
    const body = (await response.json()) as { rows: Array<Record<string, unknown>> };
    expect(Object.keys(body.rows[0]).sort()).toEqual([
      "adSetId",
      "adSetName",
      "campaignId",
      "campaignName",
      "creativeId",
      "dailyBudget",
      "effectiveStatus",
      "id",
      "level",
      "lifetimeBudget",
      "metrics",
      "name",
      "objective",
      "status",
    ]);
  });

  it("converts budgets to major units at every level", async () => {
    const response = await request("/api/dashboard/accounts/act_111/campaigns/100/insights");
    const body = (await response.json()) as { entity: { dailyBudget: number } };
    // 25000 kuruş is ₺250, never ₺25000.
    expect(body.entity.dailyBudget).toBe(250);
  });
});

describe("Phase 1 endpoints stay intact", () => {
  it("still serves the account insights shape, now with an opt-in comparison", async () => {
    const plain = await request("/api/dashboard/accounts/act_111/insights?preset=last_7d");
    expect(plain.status).toBe(200);
    const body = (await plain.json()) as {
      account: { currency: string };
      range: { preset: string };
      summary: Record<string, unknown>;
      series: unknown[];
      comparison: unknown;
    };
    expect(body.account.currency).toBe("TRY");
    expect(body.range.preset).toBe("last_7d");
    expect(body.summary.spend).toBe(1000);
    expect(Array.isArray(body.series)).toBe(true);
    expect(body.comparison).toBeNull();
  });

  it("supports comparison at account level too", async () => {
    const response = await request("/api/dashboard/accounts/act_111/insights?compare=1");
    const body = (await response.json()) as { comparison: { range: unknown } | null };
    expect(body.comparison).not.toBeNull();
  });

  it("still serves the campaigns table", async () => {
    metaGetPaginatedMock.mockImplementation(async (path: string) => {
      if (path === "/me/adaccounts") return ACCOUNTS;
      if (path.endsWith("/campaigns")) return [CAMPAIGN];
      if (path.endsWith("/insights")) return [{ campaign_id: "100", spend: "1000" }];
      return [];
    });
    const response = await request("/api/dashboard/accounts/act_111/campaigns");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { campaigns: Array<{ id: string; metrics: unknown }> };
    expect(body.campaigns[0].id).toBe("100");
  });
});
