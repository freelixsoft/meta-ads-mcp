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

/**
 * The live regression.
 *
 * "J3 reklamının bulunduğu reklam setinin günlük bütçesini 2.000 TL yapmayı
 * öner." J3 and SET2 resolved correctly, then meta_get_ad_set_detail hit
 * Meta's insights rate limit. Unable to read SET2, the model proposed a
 * campaign budget change instead — 1.500 → 2.000 on SATIŞLAR REKLAMI, an
 * object the user had not mentioned and one whose budget every ad set under it
 * shares. Nothing in the code stopped it, because up to that point nothing had
 * gone wrong: the ids were right and the write tool was a real tool.
 */
describe("regression: a failed ad set read must not become a campaign budget change", () => {
  it("reads SET2's budget from the list, which costs no insights call", async () => {
    const result = (await read("meta_get_ad_sets", { preset: "last_30d", q: "SET2" })) as {
      rows: Array<Row & { dailyBudget: number | null }>;
    };

    const set2 = result.rows.find((row) => row.name === "SET2");
    expect(set2?.id).toBe("600");
    expect(set2?.dailyBudget).toBe(1200);
    expect(set2?.campaignId).toBe("500");
    // The budget is on the row. Reaching for the detail tool to see it is what
    // spent the insights quota in production.
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("refuses a campaign budget change that the user did not ask for", async () => {
    // Exactly the call the model made after the failed read: the campaign id,
    // a budget, and no claim that the user asked about the campaign.
    await expect(
      plan("meta_update_campaign", { campaignId: "500", dailyBudget: 2000 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("says why, so the model is told to report the failed read instead", async () => {
    const error = await plan("meta_update_campaign", {
      campaignId: "500",
      dailyBudget: 2000,
    }).catch((caught: unknown) => caught as InstanceType<typeof DashboardError>);

    expect(error.message).toContain("campaignBudgetRequestedByUser");
    expect(error.message).toMatch(/shared by every ad set/i);
    expect(error.message).toMatch(/Do not\s+substitute a different object/i);
  });

  it("allows a campaign budget when the user really did ask for it", async () => {
    const result = await plan("meta_update_campaign", {
      campaignId: "500",
      dailyBudget: 2000,
      campaignBudgetRequestedByUser: true,
    });

    expect(result.path).toBe("/500");
    expect(result.body).toEqual({ daily_budget: "200000" });
    expect(result.verify).toMatchObject({ level: "campaign", id: "500" });
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("leaves campaign status and rename changes alone", async () => {
    // The flag guards budgets, not the tool: pausing a campaign never needed it.
    const result = await plan("meta_update_campaign", { campaignId: "500", status: "PAUSED" });
    expect(result.body).toEqual({ status: "PAUSED" });
  });

  it("keeps the ad set as the target when the ad set is what was asked about", async () => {
    const result = await plan("meta_update_ad_set", {
      adSetId: "600",
      becauseOfAdId: "700",
      dailyBudget: 2000,
    });

    // The whole point of the regression: the object written is SET2, and the
    // card names the chain that led to it.
    expect(result.path).toBe("/600");
    expect(result.verify).toMatchObject({ level: "adset", id: "600" });
    const labelled = Object.fromEntries(result.fields.map((field) => [field.label, field.value]));
    expect(labelled["Reklam"]).toBe("J3");
    expect(labelled["Reklam seti"]).toBe("SET2");
    expect(labelled["Kampanya"]).toBe("SATIŞLAR REKLAMI");
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });
});

/**
 * Object levels, and the rule that the assistant never picks a different one.
 *
 * Under CBO an ad set has no budget and an ad never has one. Both are dead
 * ends, and a dead end is a complete answer: "this object has no budget of its
 * own" is the truth the user asked for. What the assistant must not do is
 * treat the dead end as a prompt to find something it CAN change — the
 * campaign — because that is a different object, shared by every ad set under
 * it, and the user did not ask about it.
 */
describe("a CBO ad set is a dead end, not a detour to the campaign", () => {
  /** SET2, but under a campaign that holds the budget itself. */
  const CBO_CAMPAIGN = { ...CAMPAIGN, daily_budget: "150000" };
  const CBO_SET2 = { ...SET2, daily_budget: undefined as unknown as string };

  beforeEach(() => {
    ENTITIES["500"] = CBO_CAMPAIGN;
    ENTITIES["600"] = CBO_SET2;
  });

  afterEach(() => {
    ENTITIES["500"] = CAMPAIGN;
    ENTITIES["600"] = SET2;
  });

  it("refuses an ad set budget and produces no write plan", async () => {
    await expect(
      plan("meta_update_ad_set", { adSetId: "600", becauseOfAdId: "700", dailyBudget: 2000 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("states the fact without offering the campaign budget as an alternative", async () => {
    const error = await plan("meta_update_ad_set", {
      adSetId: "600",
      dailyBudget: 2000,
    }).catch((caught: unknown) => caught as InstanceType<typeof DashboardError>);

    // The fact the user is owed.
    expect(error.message).toMatch(/Campaign Budget Optimization|CBO/);
    expect(error.message).toMatch(/no budget of their own/i);

    // And the three things it must NOT do. These assertions exist because the
    // previous wording did all three: it told the model to ask whether the
    // user wanted the campaign budget changed "to the figure they named".
    expect(error.message).toMatch(/do not propose a campaign budget change/i);
    expect(error.message).toMatch(/do not ask the user whether/i);
    expect(error.message).not.toMatch(/ask whether they want the CAMPAIGN budget changed/i);
    expect(error.message).toMatch(/STOP HERE/);
  });

  it("still allows pausing the ad set, which CBO does not affect", async () => {
    const result = await plan("meta_update_ad_set", { adSetId: "600", status: "PAUSED" });
    expect(result.body).toEqual({ status: "PAUSED" });
    expect(result.path).toBe("/600");
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("does not let the refusal become a campaign budget change", async () => {
    // The move the model must not make next: same figure, parent object, no
    // claim that the user asked for the campaign.
    await expect(
      plan("meta_update_campaign", { campaignId: "500", dailyBudget: 2000 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("targets the campaign only when the user asked for the campaign budget", async () => {
    const result = await plan("meta_update_campaign", {
      campaignId: "500",
      dailyBudget: 2000,
      campaignBudgetRequestedByUser: true,
    });

    expect(result.path).toBe("/500");
    expect(result.verify).toMatchObject({ level: "campaign", id: "500" });
    expect(result.body).toEqual({ daily_budget: "200000" });
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });
});

describe("an ad has no budget at any time", () => {
  it("refuses a budget aimed at J3 and explains the level", async () => {
    // zod strips the budget, so the plan sees an ad with nothing to change —
    // which is exactly the shape a budget attempt arrives in.
    const error = await plan("meta_update_ad", {
      adId: "700",
      dailyBudget: 2000,
    }).catch((caught: unknown) => caught as InstanceType<typeof DashboardError>);

    expect(error).toBeInstanceOf(DashboardError);
    expect(error.message).toMatch(/an ad\s+has no budget at all/i);
    expect(error.message).toContain("J3");
    // It names the ad set as the level where a budget exists…
    expect(error.message).toContain("SET2");
    expect(error.message).toContain("600");
    // …and forbids moving there on its own.
    expect(error.message).toMatch(/Do NOT switch to the ad set or the campaign on your own/i);
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("still plans a status change on the ad", async () => {
    const result = await plan("meta_update_ad", { adId: "700", status: "PAUSED" });
    expect(result.body).toEqual({ status: "PAUSED" });
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });
});

/**
 * The four requests a user actually makes about this chain, and what each one
 * is allowed to produce. Together they say the same thing four ways: the
 * object the user named is the object the system acts on, and when that object
 * has nothing to change the answer is a sentence, not a different object.
 */
describe("A–D: what each request produces", () => {
  const CBO_CAMPAIGN = { ...CAMPAIGN, daily_budget: "150000" };
  const CBO_SET2 = { ...SET2, daily_budget: undefined as unknown as string };

  it("A) ad set budget under CBO → no write plan", async () => {
    ENTITIES["500"] = CBO_CAMPAIGN;
    ENTITIES["600"] = CBO_SET2;
    try {
      await expect(
        plan("meta_update_ad_set", { adSetId: "600", becauseOfAdId: "700", dailyBudget: 2000 }),
      ).rejects.toBeInstanceOf(DashboardError);
      expect(metaPostFormMock).not.toHaveBeenCalled();
    } finally {
      ENTITIES["500"] = CAMPAIGN;
      ENTITIES["600"] = SET2;
    }
  });

  it("B) the same request must not become a campaign change", async () => {
    ENTITIES["500"] = CBO_CAMPAIGN;
    ENTITIES["600"] = CBO_SET2;
    try {
      const refusal = await plan("meta_update_ad_set", {
        adSetId: "600",
        dailyBudget: 2000,
      }).catch((caught: unknown) => caught as InstanceType<typeof DashboardError>);
      expect(refusal.message).toMatch(/do not propose a campaign budget change/i);

      // The move the refusal forbids, attempted anyway.
      await expect(
        plan("meta_update_campaign", { campaignId: "500", dailyBudget: 2000 }),
      ).rejects.toBeInstanceOf(DashboardError);
      expect(metaPostFormMock).not.toHaveBeenCalled();
    } finally {
      ENTITIES["500"] = CAMPAIGN;
      ENTITIES["600"] = SET2;
    }
  });

  it("C) campaign budget asked for by name → a campaign-level plan", async () => {
    const result = await plan("meta_update_campaign", {
      campaignId: "500",
      dailyBudget: 2000,
      campaignBudgetRequestedByUser: true,
    });

    // The card the user should see.
    const labelled = Object.fromEntries(result.fields.map((field) => [field.label, field.value]));
    expect(labelled["Kampanya"]).toBe("SATIŞLAR REKLAMI");
    expect(labelled["Yeni günlük bütçe"]).toContain("2.000,00 TRY");

    // The object written, and the snapshot the stale check will compare.
    expect(result.path).toBe("/500");
    expect(result.verify).toMatchObject({ level: "campaign", id: "500" });
    expect(result.body).toEqual({ daily_budget: "200000" });
    // Planning is not writing, whatever the kill switch says.
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("C) shows the previous budget so the card reads X → Y", async () => {
    const withBudget = { ...CAMPAIGN, daily_budget: "150000" };
    ENTITIES["500"] = withBudget;
    try {
      const result = await plan("meta_update_campaign", {
        campaignId: "500",
        dailyBudget: 2000,
        campaignBudgetRequestedByUser: true,
      });
      const labelled = Object.fromEntries(result.fields.map((f) => [f.label, f.value]));
      expect(labelled["Yeni günlük bütçe"]).toContain("önce 1.500,00 TRY");
      expect(result.expected).toEqual({ daily_budget: 1500 });
    } finally {
      ENTITIES["500"] = CAMPAIGN;
    }
  });

  it("D) an ad budget → explained, and no silent move to another level", async () => {
    const error = await plan("meta_update_ad", { adId: "700", dailyBudget: 2000 }).catch(
      (caught: unknown) => caught as InstanceType<typeof DashboardError>,
    );

    expect(error.message).toMatch(/an ad\s+has no budget at all/i);
    expect(error.message).toContain("SET2");
    expect(error.message).toMatch(/Do NOT switch to the ad set or the campaign on your own/i);
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });
});

describe("a read that Meta refuses", () => {
  it("surfaces the real reason instead of hiding it", async () => {
    // The production failure verbatim: Meta's application request limit.
    metaGetMock.mockRejectedValue(
      Object.assign(new Error("Application request limit reached"), { code: 17 }),
    );

    const failure = await read("meta_get_ad_set_detail", {
      preset: "last_30d",
      adSetId: "600",
    }).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(DashboardError);
    // A throttle must keep its own classification. Collapsed into
    // account_forbidden it reads as a permanent verdict about the object —
    // which is what told the model SET2 was out of reach and sent it looking
    // for something else to change.
    expect((failure as InstanceType<typeof DashboardError>).code).toBe("meta_rate_limited");
    expect((failure as Error).message).not.toMatch(/not accessible/i);
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("classifies Meta's other throttle phrasings the same way", async () => {
    for (const phrase of [
      "(#4) Application request limit reached",
      "(#17) User request limit reached",
      "(#80004) There have been too many calls to this ad-account",
      "Please reduce the amount of data you're asking for, then retry your request",
    ]) {
      metaGetMock.mockRejectedValue(new Error(phrase));
      const failure = await read("meta_get_ad_set_detail", {
        preset: "last_30d",
        adSetId: "600",
      }).catch((caught: unknown) => caught as InstanceType<typeof DashboardError>);

      expect(failure.code, phrase).toBe("meta_rate_limited");
    }
  });

  it("does not let the ad set list fabricate a budget when Meta is unreachable", async () => {
    metaGetPaginatedMock.mockRejectedValue(new Error("Application request limit reached"));

    await expect(read("meta_get_ad_sets", { preset: "last_30d", q: "SET2" })).rejects.toThrow();
    expect(metaPostFormMock).not.toHaveBeenCalled();
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
