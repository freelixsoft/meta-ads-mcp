import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ad → ad set → campaign, as the assistant sees it.
 *
 * The bug these pin down was not a bad write: it was a blind spot. The tools
 * reported that an ad lived in "SET2" without reporting SET2's id, so a model
 * asked to raise "this ad's budget" had no way to address the only object that
 * has one. It could see the relationship and not use it.
 *
 * Everything here is read-only. No case in this file reaches postForm, and the
 * one that plans a write asserts that it did not.
 */

const metaGetMock = vi.fn();
const metaGetPaginatedMock = vi.fn();
const metaPostFormMock = vi.fn();

vi.mock("../../src/meta/client.js", () => ({
  metaApiClient: {
    get: (...args: unknown[]) => metaGetMock(...args),
    getPaginated: (...args: unknown[]) => metaGetPaginatedMock(...args),
    postForm: (...args: unknown[]) => metaPostFormMock(...args),
  },
}));

const { READ_TOOLS_BY_NAME, WRITE_TOOLS_BY_NAME } = await import("../../src/claude/tools.js");
const { dashboardCache } = await import("../../src/dashboard/cache.js");
const { DashboardError } = await import("../../src/dashboard/errors.js");

import type { AdAccountDto } from "../../src/dashboard/dto.js";
import type { ToolExecutionContext } from "../../src/claude/types.js";

const ACCOUNT: AdAccountDto = {
  id: "act_111",
  accountId: "111",
  name: "Acme TR",
  status: "ACTIVE",
  statusCode: 1,
  currency: "TRY",
  timezone: "Europe/Istanbul",
  businessName: "Acme Holding",
};

const TOOLS: ToolExecutionContext = {
  ctx: { fbUserId: "1000000000001", tokenHash: "fixturehash1" },
  account: ACCOUNT,
};

// ─── The account under test ──────────────────────────────────────────────
//
//   SATIŞLAR REKLAMI (campaign 500)
//     └── SET2 (ad set 600, 1.200 TRY/gün)
//           ├── J3  (ad 700)
//           └── JJ3 (ad 701)   ← the near-miss name
//     └── SET3 (ad set 601, 800 TRY/gün)
//           └── B2  (ad 702)

const CAMPAIGN = {
  id: "500",
  name: "SATIŞLAR REKLAMI",
  account_id: "111",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  objective: "OUTCOME_SALES",
};

const SET2 = {
  id: "600",
  name: "SET2",
  account_id: "111",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  campaign_id: "500",
  campaign: { id: "500", name: "SATIŞLAR REKLAMI" },
  daily_budget: "120000",
};

const SET3 = {
  id: "601",
  name: "SET3",
  account_id: "111",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  campaign_id: "500",
  campaign: { id: "500", name: "SATIŞLAR REKLAMI" },
  daily_budget: "80000",
};

function ad(id: string, name: string, set: typeof SET2) {
  return {
    id,
    name,
    account_id: "111",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    adset_id: set.id,
    campaign_id: "500",
    adset: { id: set.id, name: set.name },
    campaign: { id: "500", name: "SATIŞLAR REKLAMI" },
    creative: { id: "900" },
  };
}

const J3 = ad("700", "J3", SET2);
const JJ3 = ad("701", "JJ3", SET2);
const B2 = ad("702", "B2", SET3);

const ENTITIES: Record<string, unknown> = {
  "500": CAMPAIGN,
  "600": SET2,
  "601": SET3,
  "700": J3,
  "701": JJ3,
  "702": B2,
};

/** Per-ad insight rows, so each ad has its own performance line. */
const AD_INSIGHTS = [
  {
    ad_id: "700",
    spend: "1800",
    impressions: "60000",
    reach: "30000",
    clicks: "1800",
    actions: [{ action_type: "omni_purchase", value: "12" }],
    action_values: [{ action_type: "omni_purchase", value: "9000" }],
  },
  {
    ad_id: "701",
    spend: "300",
    impressions: "9000",
    reach: "6000",
    clicks: "150",
    actions: [{ action_type: "omni_purchase", value: "1" }],
    action_values: [{ action_type: "omni_purchase", value: "400" }],
  },
  {
    ad_id: "702",
    spend: "900",
    impressions: "40000",
    reach: "22000",
    clicks: "500",
    actions: [{ action_type: "omni_purchase", value: "0" }],
  },
];

function read(name: string, input: unknown): Promise<unknown> {
  const tool = READ_TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`no read tool ${name}`);
  return tool.run(tool.schema.parse(input), TOOLS);
}

function plan(name: string, input: unknown) {
  const tool = WRITE_TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`no write tool ${name}`);
  return tool.plan(tool.schema.parse({ reason: "Test gerekçesi.", ...(input as object) }), TOOLS);
}

interface Row {
  id: string;
  name: string;
  campaignId: string | null;
  campaignName: string | null;
  adSetId: string | null;
  adSetName: string | null;
  metrics: Record<string, number | null>;
}

beforeEach(() => {
  dashboardCache.clear();

  metaGetMock.mockImplementation((path: string, params: Record<string, unknown>) => {
    const id = path.replace(/^\//, "").split("/")[0];
    if (path.endsWith("/insights")) {
      return Promise.resolve(
        params.time_increment
          ? { data: [] }
          : {
              data: [
                {
                  date_start: "2026-08-23",
                  date_stop: "2026-09-21",
                  spend: "1800",
                  impressions: "60000",
                  reach: "30000",
                  clicks: "1800",
                  actions: [{ action_type: "omni_purchase", value: "12" }],
                  action_values: [{ action_type: "omni_purchase", value: "9000" }],
                },
              ],
            },
      );
    }
    const entity = ENTITIES[id];
    return entity ? Promise.resolve(entity) : Promise.reject(new Error(`no entity ${id}`));
  });

  metaGetPaginatedMock.mockImplementation((path: string) => {
    if (path === "/act_111/ads") return Promise.resolve([J3, JJ3, B2]);
    if (path === "/act_111/adsets") return Promise.resolve([SET2, SET3]);
    if (path.endsWith("/campaigns")) return Promise.resolve([CAMPAIGN]);
    if (path.endsWith("/insights")) return Promise.resolve(AD_INSIGHTS);
    return Promise.resolve([]);
  });

  metaPostFormMock.mockResolvedValue({ id: "600" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("finding an ad by name", () => {
  it("finds J3 and reports the ad set and campaign it belongs to, with ids", async () => {
    const result = (await read("meta_get_ads", { preset: "last_30d", q: "J3" })) as {
      rows: Row[];
      totalRows: number;
    };

    const j3 = result.rows.find((row) => row.name === "J3");
    expect(j3).toBeDefined();
    expect(j3?.id).toBe("700");
    // The ids are the point: a name alone cannot be used to address anything.
    expect(j3?.adSetId).toBe("600");
    expect(j3?.adSetName).toBe("SET2");
    expect(j3?.campaignId).toBe("500");
    expect(j3?.campaignName).toBe("SATIŞLAR REKLAMI");
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("returns JJ3 as well, because 'J3' is a substring of it", async () => {
    const result = (await read("meta_get_ads", { preset: "last_30d", q: "J3" })) as { rows: Row[] };
    const names = result.rows.map((row) => row.name).sort();

    // Both, deliberately. Picking one here would be the tool guessing which ad
    // the user meant; the answer is supposed to ask.
    expect(names).toEqual(["J3", "JJ3"]);
    const jj3 = result.rows.find((row) => row.name === "JJ3");
    expect(jj3?.id).toBe("701");
    expect(jj3?.adSetId).toBe("600");
  });

  it("finds JJ3 alone when the full name is given", async () => {
    const result = (await read("meta_get_ads", { preset: "last_30d", q: "JJ3" })) as { rows: Row[] };
    expect(result.rows.map((row) => row.name)).toEqual(["JJ3"]);
  });

  it("finds B2 in a different ad set under the same campaign", async () => {
    const result = (await read("meta_get_ads", { preset: "last_30d", q: "B2" })) as { rows: Row[] };

    expect(result.rows).toHaveLength(1);
    const b2 = result.rows[0];
    expect(b2.id).toBe("702");
    expect(b2.adSetId).toBe("601");
    expect(b2.adSetName).toBe("SET3");
    // Same campaign as J3, different ad set — the distinction a budget change
    // has to get right.
    expect(b2.campaignId).toBe("500");
  });

  it("matches case-insensitively, like the drill-down table", async () => {
    const lower = (await read("meta_get_ads", { preset: "last_30d", q: "j3" })) as { rows: Row[] };
    expect(lower.rows.map((row) => row.name).sort()).toEqual(["J3", "JJ3"]);
  });

  it("returns nothing rather than a guess when no ad matches", async () => {
    const result = (await read("meta_get_ads", { preset: "last_30d", q: "Z9" })) as {
      rows: Row[];
      totalRows: number;
    };
    expect(result.rows).toHaveLength(0);
    expect(result.totalRows).toBe(0);
  });
});

describe("an ad's own performance", () => {
  it("reports J3's metrics and its parent chain", async () => {
    const result = (await read("meta_get_ad_detail", { preset: "last_30d", adId: "700" })) as {
      entity: Record<string, unknown>;
      summary: Record<string, number | null>;
    };

    expect(result.entity.id).toBe("700");
    expect(result.entity.level).toBe("ad");
    expect(result.entity.adSetId).toBe("600");
    expect(result.entity.adSetName).toBe("SET2");
    expect(result.entity.campaignId).toBe("500");
    expect(result.entity.campaignName).toBe("SATIŞLAR REKLAMI");
    // An ad carries no budget of its own; that is the whole point.
    expect(result.entity.dailyBudget).toBeNull();
    expect(result.entity.lifetimeBudget).toBeNull();

    for (const key of ["spend", "purchases", "purchaseValue", "roas", "costPerPurchase", "ctr", "cpc", "cpm"]) {
      expect(result.summary).toHaveProperty(key);
    }
    expect(result.summary.spend).toBe(1800);
    expect(result.summary.purchases).toBe(12);
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });
});

describe("a budget change asked for an ad lands on its ad set", () => {
  it("names the ad, the ad set and the campaign on the confirmation", async () => {
    const result = await plan("meta_update_ad_set", {
      adSetId: "600",
      becauseOfAdId: "700",
      dailyBudget: 2000,
    });

    const labelled = Object.fromEntries(result.fields.map((field) => [field.label, field.value]));
    expect(labelled["Reklam"]).toBe("J3");
    expect(labelled["Reklam seti"]).toBe("SET2");
    expect(labelled["Kampanya"]).toBe("SATIŞLAR REKLAMI");
    expect(labelled["Yeni günlük bütçe"]).toContain("2.000,00 TRY");
    // The old value travels with it, so the card reads X → Y.
    expect(labelled["Yeni günlük bütçe"]).toContain("önce 1.200,00 TRY");

    // The object actually written is the ad set, never the ad.
    expect(result.path).toBe("/600");
    expect(result.body).toEqual({ daily_budget: "200000" });
    expect(result.verify).toMatchObject({ level: "adset", id: "600" });
    // Planning is not writing.
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("refuses to claim an ad belongs to an ad set it does not", async () => {
    // B2 lives in SET3, not SET2.
    await expect(
      plan("meta_update_ad_set", { adSetId: "600", becauseOfAdId: "702", dailyBudget: 2000 }),
    ).rejects.toBeInstanceOf(DashboardError);
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("still works without an ad, naming only the ad set and campaign", async () => {
    const result = await plan("meta_update_ad_set", { adSetId: "601", dailyBudget: 1500 });
    const labels = result.fields.map((field) => field.label);

    expect(labels).not.toContain("Reklam");
    expect(labels).toContain("Reklam seti");
    expect(labels).toContain("Kampanya");
    expect(result.path).toBe("/601");
  });
});

describe("the ad write tool has no budget to offer", () => {
  it("rejects a budget on meta_update_ad at the schema", () => {
    const tool = WRITE_TOOLS_BY_NAME.get("meta_update_ad");
    const parsed = tool!.schema.parse({
      reason: "Test gerekçesi.",
      adId: "700",
      status: "PAUSED",
      dailyBudget: 2000,
    }) as Record<string, unknown>;

    // zod strips what the schema does not declare, so a budget aimed at an ad
    // cannot reach Meta even if the model sends one.
    expect(parsed).not.toHaveProperty("dailyBudget");
    expect(parsed).not.toHaveProperty("lifetimeBudget");
  });

  it("plans only name and status for an ad", async () => {
    const result = await plan("meta_update_ad", { adId: "700", status: "PAUSED" });
    expect(result.body).toEqual({ status: "PAUSED" });
    expect(result.verify).toMatchObject({ level: "ad", id: "700" });
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });
});
