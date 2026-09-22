import { describe, expect, it } from "vitest";

/**
 * The optimization decision engine.
 *
 * These tests exist because the engine is the one place in this feature that
 * decides what the user should do with their money. Every case below pins a
 * decision a model must not be allowed to make on its own: that a null is not
 * a zero, that a paused object is not an underperformer, that a CBO ad set has
 * no budget to raise, and that the ordering is money rather than opinion.
 */

import {
  analyze,
  computeBaselines,
  frequencyOf,
  metricLineOf,
  type Finding,
} from "../../src/claude/decision-engine.js";
import type { EntityRowDto, MetricsDto } from "../../src/dashboard/dto.js";

const EMPTY: MetricsDto = {
  spend: 0,
  impressions: 0,
  reach: 0,
  clicks: 0,
  ctr: null,
  cpc: null,
  cpm: null,
  purchases: 0,
  addToCart: 0,
  purchaseValue: null,
  costPerPurchase: null,
  roas: null,
};

function metrics(overrides: Partial<MetricsDto> = {}): MetricsDto {
  return { ...EMPTY, ...overrides };
}

function row(overrides: Partial<EntityRowDto> & { id: string }): EntityRowDto {
  return {
    level: "ad",
    name: `Ad ${overrides.id}`,
    status: "ACTIVE",
    effectiveStatus: "ACTIVE",
    objective: null,
    campaignId: "c1",
    campaignName: "Kış",
    adSetId: "s1",
    adSetName: "TR 25-45",
    creativeId: null,
    dailyBudget: null,
    lifetimeBudget: null,
    metrics: metrics(),
    ...overrides,
  };
}

function run(
  rows: EntityRowDto[],
  options: {
    previous?: Record<string, MetricsDto>;
    cbo?: string[];
    level?: "campaign" | "adset" | "ad";
  } = {},
) {
  return analyze({
    level: options.level ?? "ad",
    currency: "TRY",
    rows,
    previousById: new Map(Object.entries(options.previous ?? {})),
    cboCampaignIds: new Set(options.cbo ?? []),
  });
}

function kinds(findings: Finding[]): string[] {
  return findings.map((finding) => finding.kind);
}

/** A healthy account so the relative baselines have something to sit on. */
function backdrop(): EntityRowDto[] {
  return [
    row({
      id: "good1",
      name: "Statik Kış",
      metrics: metrics({
        spend: 4000, impressions: 200000, reach: 100000, clicks: 5000,
        ctr: 2.5, cpc: 0.8, cpm: 20, purchases: 100, addToCart: 300,
        purchaseValue: 16000, costPerPurchase: 40, roas: 4,
      }),
    }),
  ];
}

describe("baselines", () => {
  it("derives the account's own yardsticks from the rows it judges", () => {
    const baselines = computeBaselines(backdrop());
    expect(baselines.totalSpend).toBe(4000);
    expect(baselines.totalPurchases).toBe(100);
    expect(baselines.accountRoas).toBe(4);
    expect(baselines.accountCostPerPurchase).toBe(40);
  });

  it("reports no ROAS baseline at all when no row carries revenue", () => {
    const baselines = computeBaselines([
      row({ id: "a", metrics: metrics({ spend: 100, purchases: 2, purchaseValue: null, roas: null }) }),
    ]);
    // Not 0 — the account simply has no usable revenue figure.
    expect(baselines.accountRoas).toBeNull();
    expect(baselines.accountCostPerPurchase).toBe(50);
  });
});

describe("zero conversion spend", () => {
  it("flags real spend with no purchases and quotes the exact figures", () => {
    const result = run([
      ...backdrop(),
      row({
        id: "bad",
        name: "S2",
        metrics: metrics({
          spend: 1546, impressions: 60000, reach: 30000, clicks: 900,
          ctr: 1.5, cpc: 1.72, cpm: 25.77, purchases: 0, addToCart: 4,
        }),
      }),
    ]);

    const finding = result.findings.find((f) => f.objectId === "bad");
    expect(finding?.kind).toBe("zero_conversion_spend");
    expect(finding?.evidence).toContain("1.546,00 TRY");
    expect(finding?.evidence).toContain("0 satın alma");
    expect(finding?.facts.purchases).toBe(0);
    expect(finding?.facts.spend).toBe(1546);
    expect(finding?.writeTool).toBe("meta_update_ad");
    expect(finding?.risk).toContain("dönüşüm");
  });

  it("ignores a trickle of spend that acting on could not move the account", () => {
    const result = run([...backdrop(), row({ id: "tiny", metrics: metrics({ spend: 3, impressions: 100, purchases: 0 }) })]);
    expect(result.findings.some((f) => f.objectId === "tiny")).toBe(false);
  });
});

describe("ROAS signals", () => {
  it("flags a spender well below the account's own ROAS", () => {
    const result = run([
      ...backdrop(),
      row({
        id: "weak",
        metrics: metrics({
          spend: 2000, impressions: 80000, reach: 40000, clicks: 1000,
          ctr: 1.25, cpc: 2, cpm: 25, purchases: 10, addToCart: 30,
          purchaseValue: 2000, costPerPurchase: 200, roas: 1,
        }),
      }),
    ]);

    const finding = result.findings.find((f) => f.objectId === "weak");
    expect(finding?.kind).toBe("low_roas");
    expect(finding?.facts.roas).toBe(1);
    // (16000 + 2000) revenue over (4000 + 2000) spend.
    expect(finding?.facts.accountRoas).toBe(3);
  });

  it("flags a small spender well above it as somewhere to put more money", () => {
    const result = run([
      ...backdrop(),
      row({
        id: "star",
        dailyBudget: 50,
        metrics: metrics({
          spend: 150, impressions: 6000, reach: 4000, clicks: 200,
          ctr: 3.3, cpc: 0.75, cpm: 25, purchases: 12, addToCart: 25,
          purchaseValue: 2400, costPerPurchase: 12.5, roas: 16,
        }),
      }),
    ]);

    const finding = result.findings.find((f) => f.objectId === "star");
    expect(finding?.kind).toBe("high_roas_underfunded");
    expect(finding?.writeTool).toBe("meta_update_ad_set");
    expect(finding?.action).toContain("50,00 TRY");
  });

  it("says nothing about ROAS when the account has none to compare against", () => {
    const result = run([
      row({ id: "a", metrics: metrics({ spend: 1000, purchases: 5, purchaseValue: null, roas: null }) }),
      row({ id: "b", metrics: metrics({ spend: 900, purchases: 4, purchaseValue: null, roas: null }) }),
    ]);
    expect(kinds(result.findings)).not.toContain("low_roas");
    expect(kinds(result.findings)).not.toContain("high_roas_underfunded");
    expect(result.baselines.accountRoas).toBeNull();
    expect(result.metricsMissingOnEveryRow).toContain("roas");
    expect(result.metricsMissingOnEveryRow).toContain("purchaseValue");
  });
});

describe("trend signals", () => {
  const current = metrics({
    spend: 3000, impressions: 100000, reach: 50000, clicks: 800,
    ctr: 0.8, cpc: 3.75, cpm: 30, purchases: 10, addToCart: 20,
    purchaseValue: 6000, costPerPurchase: 300, roas: 2,
  });

  it("reports a rising CPA, a falling CTR and rising CPC/CPM with both figures", () => {
    const result = run([...backdrop(), row({ id: "drift", metrics: current })], {
      previous: {
        drift: metrics({
          spend: 3000, impressions: 100000, reach: 50000, clicks: 1600,
          ctr: 1.6, cpc: 1.88, cpm: 15, purchases: 30, addToCart: 60,
          purchaseValue: 9000, costPerPurchase: 100, roas: 3,
        }),
      },
    });

    const found = kinds(result.findings.filter((f) => f.objectId === "drift"));
    expect(found).toContain("cpa_rising");
    expect(found).toContain("ctr_falling");
    expect(found).toContain("cpc_rising");
    expect(found).toContain("cpm_rising");

    const cpa = result.findings.find((f) => f.objectId === "drift" && f.kind === "cpa_rising");
    expect(cpa?.facts.previous).toBe(100);
    expect(cpa?.facts.current).toBe(300);
    expect(cpa?.evidence).toContain("100");
    expect(cpa?.evidence).toContain("300");
  });

  it("stays quiet when the previous period has no value to compare against", () => {
    const result = run([...backdrop(), row({ id: "drift", metrics: current })], {
      previous: { drift: metrics({ spend: 3000, costPerPurchase: null, ctr: null, cpc: null, cpm: null }) },
    });
    const found = kinds(result.findings.filter((f) => f.objectId === "drift"));
    expect(found).not.toContain("cpa_rising");
    expect(found).not.toContain("ctr_falling");
  });

  it("reports a clear improvement so a working setup is not edited", () => {
    const result = run([...backdrop(), row({ id: "up", metrics: current })], {
      previous: { up: metrics({ ...current, roas: 1 }) },
    });
    const improving = result.findings.find((f) => f.objectId === "up" && f.kind === "improving");
    expect(improving).toBeDefined();
    expect(improving?.facts.previousRoas).toBe(1);
    expect(improving?.facts.roas).toBe(2);
    expect(improving?.writeTool).toBeNull();
  });
});

describe("structural states", () => {
  it("treats a paused object as an observation, never as a place to spend more", () => {
    const result = run([
      ...backdrop(),
      // Something genuinely actionable, so the ordering has two things to sort.
      row({ id: "bleeding", metrics: metrics({ spend: 2000, impressions: 70000, reach: 35000, clicks: 500, purchases: 0 }) }),
      row({ id: "off", status: "PAUSED", effectiveStatus: "PAUSED", metrics: metrics({ spend: 0 }) }),
    ]);

    const finding = result.findings.find((f) => f.objectId === "off");
    expect(finding?.kind).toBe("paused_not_spending");
    expect(finding?.writeTool).toBeNull();
    // It must not be a budget-increase candidate, and it must never outrank
    // something that is actually burning money.
    expect(finding?.spendAtStake).toBe(0);
    expect(result.findings[0]?.objectId).toBe("bleeding");
    expect(result.findings.at(-1)?.objectId).toBe("off");
    expect(kinds(result.findings.filter((f) => f.objectId === "off"))).not.toContain(
      "high_roas_underfunded",
    );
  });

  it("flags an active object that is not delivering at all", () => {
    const result = run([
      ...backdrop(),
      row({ id: "stuck", metrics: metrics({ spend: 0, impressions: 0 }) }),
    ]);
    const finding = result.findings.find((f) => f.objectId === "stuck");
    expect(finding?.kind).toBe("active_no_delivery");
    expect(finding?.writeTool).toBeNull();
  });
});

describe("CBO and ABO", () => {
  const star = (overrides: Partial<EntityRowDto>) =>
    row({
      id: "star",
      level: "adset",
      metrics: metrics({
        spend: 150, impressions: 6000, reach: 4000, clicks: 200,
        ctr: 3.3, cpc: 0.75, cpm: 25, purchases: 12, addToCart: 25,
        purchaseValue: 2400, costPerPurchase: 12.5, roas: 16,
      }),
      ...overrides,
    });

  it("never proposes an ad set budget when the campaign holds it", () => {
    const result = run([...backdrop(), star({ campaignId: "cbo1", dailyBudget: null })], {
      cbo: ["cbo1"],
      level: "adset",
    });

    const finding = result.findings.find((f) => f.objectId === "star");
    expect(finding?.kind).toBe("high_roas_underfunded");
    expect(finding?.budgetOwner).toBe("campaign");
    // No write is offered, and the action says why and what to ask.
    expect(finding?.writeTool).toBeNull();
    expect(finding?.action).toContain("CBO");
    expect(finding?.action).toContain("kampanya");
  });

  it("allows an ad set budget change when the ad set owns its budget", () => {
    const result = run([...backdrop(), star({ campaignId: "abo1", dailyBudget: 200 })], {
      cbo: [],
      level: "adset",
    });

    const finding = result.findings.find((f) => f.objectId === "star");
    expect(finding?.budgetOwner).toBe("adset");
    expect(finding?.writeTool).toBe("meta_update_ad_set");
    expect(finding?.action).toContain("200,00 TRY");
  });

  it("does not read a null budget as zero", () => {
    const result = run([...backdrop(), star({ campaignId: "unknown1", dailyBudget: null })], {
      cbo: [],
      level: "adset",
    });

    const finding = result.findings.find((f) => f.objectId === "star");
    expect(finding?.budgetOwner).toBe("unknown");
    expect(finding?.metrics.dailyBudget).toBeNull();
    expect(finding?.action).not.toContain("0,00 TRY");
    expect(finding?.writeTool).toBeNull();
  });

  it("keeps a campaign's own budget at campaign level", () => {
    const result = run(
      [
        ...backdrop(),
        row({
          id: "camp",
          level: "campaign",
          campaignId: "camp",
          dailyBudget: 500,
          metrics: metrics({
            spend: 150, impressions: 6000, reach: 4000, clicks: 200,
            ctr: 3.3, cpc: 0.75, cpm: 25, purchases: 12, addToCart: 25,
            purchaseValue: 2400, costPerPurchase: 12.5, roas: 16,
          }),
        }),
      ],
      { level: "campaign" },
    );

    const finding = result.findings.find((f) => f.objectId === "camp");
    expect(finding?.budgetOwner).toBe("campaign");
    expect(finding?.writeTool).toBe("meta_update_campaign");
    expect(finding?.action).toContain("500,00 TRY");
  });
});

describe("the recommendation shape", () => {
  it("gives every finding the seven fields the answer is built from", () => {
    const result = run([
      ...backdrop(),
      row({ id: "bad", metrics: metrics({ spend: 1546, impressions: 60000, reach: 30000, clicks: 900, purchases: 0 }) }),
    ]);

    for (const finding of result.findings) {
      expect(typeof finding.evidence).toBe("string");
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(typeof finding.action).toBe("string");
      expect(typeof finding.goal).toBe("string");
      expect(typeof finding.risk).toBe("string");
      expect(typeof finding.priorityBasis).toBe("string");
      expect(finding.objectId).toBeTruthy();
      expect(["campaign", "adset", "ad"]).toContain(finding.level);
      expect(["campaign", "adset", "unknown"]).toContain(finding.budgetOwner);
    }
  });

  it("ranks by money at stake and puts observations below actions", () => {
    const result = run([
      ...backdrop(),
      row({ id: "small", metrics: metrics({ spend: 500, impressions: 20000, reach: 10000, clicks: 200, purchases: 0 }) }),
      row({ id: "large", metrics: metrics({ spend: 3000, impressions: 90000, reach: 45000, clicks: 700, purchases: 0 }) }),
      row({ id: "off", status: "PAUSED", effectiveStatus: "PAUSED", metrics: metrics({ spend: 0 }) }),
    ]);

    const actionable = result.findings.filter((f) => f.kind !== "paused_not_spending");
    expect(actionable[0]?.objectId).toBe("large");
    expect(actionable[1]?.objectId).toBe("small");
    expect(result.findings.at(-1)?.kind).toBe("paused_not_spending");
    expect(result.findings[0]?.priorityBasis).toContain("TRY");
  });

  it("returns nothing rather than inventing something when the account is quiet", () => {
    const result = run([row({ id: "only", metrics: metrics({ spend: 0, impressions: 0, purchases: 0 }) })], {});
    expect(result.findings.every((f) => f.writeTool === null)).toBe(true);
    expect(result.findings.filter((f) => f.kind === "zero_conversion_spend")).toHaveLength(0);
  });
});

describe("no invented metrics", () => {
  it("passes nulls through the metric line instead of turning them into zeroes", () => {
    const line = metricLineOf(
      row({ id: "x", metrics: metrics({ spend: 100, roas: null, purchaseValue: null, costPerPurchase: null }) }),
    );
    expect(line.roas).toBeNull();
    expect(line.purchaseValue).toBeNull();
    expect(line.costPerPurchase).toBeNull();
    expect(line.spend).toBe(100);
  });

  it("computes frequency only when reach supports it", () => {
    expect(frequencyOf(metrics({ impressions: 1000, reach: 400 }))).toBeCloseTo(2.5, 5);
    expect(frequencyOf(metrics({ impressions: 1000, reach: 0 }))).toBeNull();
    expect(frequencyOf(metrics({ impressions: 1000, reach: null as unknown as number }))).toBeNull();
  });

  it("quotes in evidence only numbers that are present in facts", () => {
    const result = run([
      ...backdrop(),
      row({ id: "bad", metrics: metrics({ spend: 1546, impressions: 60000, reach: 30000, clicks: 900, purchases: 0 }) }),
    ]);
    const finding = result.findings.find((f) => f.objectId === "bad");

    // Every bare number in the sentence must be traceable to a fact or to the
    // object's own metric line; nothing is introduced by the prose.
    const quoted = (finding?.evidence.match(/\d[\d.,]*/g) ?? []).map((n) =>
      Number(n.replace(/\./g, "").replace(",", ".")),
    );
    const known = new Set(
      [...Object.values(finding?.facts ?? {}), ...Object.values(finding?.metrics ?? {})]
        .filter((v): v is number => typeof v === "number"),
    );
    for (const value of quoted) expect(known.has(value)).toBe(true);
  });
});
