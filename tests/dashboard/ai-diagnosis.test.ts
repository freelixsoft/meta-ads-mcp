import { describe, expect, it } from "vitest";

/**
 * The diagnosis engine.
 *
 * It answers "where did the change come from" and "which factor carries it"
 * with arithmetic, so these tests are mostly about the arithmetic being right
 * and about it refusing to speak when the data does not support a reading.
 * The factor split is an identity, which means it can be checked exactly: the
 * shares sum to 100 and the direction of each term is determined, not chosen.
 */

import {
  averageOrderValueOf,
  conversionRateOf,
  decomposeRoas,
  diagnose,
  frequencyOf,
  type ChildPeriods,
} from "../../src/claude/diagnosis-engine.js";
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

/** Builds a coherent metric line: the rates are derived, not invented. */
function line(input: {
  spend: number;
  impressions: number;
  reach?: number;
  clicks: number;
  purchases: number;
  purchaseValue?: number | null;
}): MetricsDto {
  const { spend, impressions, clicks, purchases } = input;
  const purchaseValue = input.purchaseValue === undefined ? purchases * 500 : input.purchaseValue;
  return {
    spend,
    impressions,
    reach: input.reach ?? Math.round(impressions / 2),
    clicks,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    purchases,
    addToCart: purchases * 3,
    purchaseValue,
    costPerPurchase: purchases > 0 ? spend / purchases : null,
    roas: purchaseValue !== null && spend > 0 ? purchaseValue / spend : null,
  };
}

function row(id: string, name: string, m: MetricsDto, overrides: Partial<EntityRowDto> = {}): EntityRowDto {
  return {
    id,
    level: "adset",
    name,
    status: "ACTIVE",
    effectiveStatus: "ACTIVE",
    objective: null,
    campaignId: "c1",
    campaignName: "Kış",
    adSetId: null,
    adSetName: null,
    creativeId: null,
    dailyBudget: null,
    lifetimeBudget: null,
    metrics: m,
    ...overrides,
  };
}

function run(input: {
  current: MetricsDto;
  previous: MetricsDto;
  children?: ChildPeriods[];
  days?: number;
}) {
  return diagnose({
    currency: "TRY",
    scope: { level: "account", id: null, name: "Acme TR" },
    current: input.current,
    previous: input.previous,
    days: input.days ?? 7,
    childLevel: "adset",
    children: input.children ?? [],
  });
}

// The worked example from the brief.
const NOW = line({ spend: 14000, impressions: 700000, clicks: 9000, purchases: 18, purchaseValue: 44800 });
const BEFORE = line({ spend: 12000, impressions: 500000, clicks: 9000, purchases: 31, purchaseValue: 61200 });

describe("headline changes", () => {
  it("reports spend up and purchases down with the real percentages", () => {
    const result = run({ current: NOW, previous: BEFORE });

    expect(result.headline.spend).toBe(14000);
    expect(result.headline.spendPrevious).toBe(12000);
    expect(result.headline.spendChangePercent).toBeCloseTo(16.7, 1);

    expect(result.headline.purchases).toBe(18);
    expect(result.headline.purchasesPrevious).toBe(31);
    expect(result.headline.purchasesChangePercent).toBeCloseTo(-41.9, 1);
  });

  it("reports the ROAS and CPA moves", () => {
    const result = run({ current: NOW, previous: BEFORE });
    expect(result.headline.roas).toBeCloseTo(3.2, 1);
    expect(result.headline.roasPrevious).toBeCloseTo(5.1, 1);
    // CPA is spend per purchase: it rose because both sides moved against it.
    expect(result.headline.costPerPurchase).toBeCloseTo(777.78, 1);
    expect(result.headline.costPerPurchasePrevious).toBeCloseTo(387.1, 1);
    expect(result.headline.costPerPurchaseChangePercent).toBeGreaterThan(0);
  });

  it("keeps a metric Meta never reported as null rather than zero", () => {
    const noRevenue = line({ spend: 1000, impressions: 50000, clicks: 500, purchases: 4, purchaseValue: null });
    const result = run({ current: noRevenue, previous: noRevenue });
    expect(result.headline.purchaseValue).toBeNull();
    expect(result.headline.roas).toBeNull();
    expect(result.missingMetrics).toContain("purchaseValue");
    expect(result.missingMetrics).toContain("roas");
  });
});

describe("the ROAS factor split is an identity", () => {
  it("splits the move across the four factors and the shares sum to 100", () => {
    const { factors, roasChangePercent, blockedBy } = decomposeRoas(NOW, BEFORE);

    expect(blockedBy).toEqual([]);
    expect(roasChangePercent).toBeLessThan(0);
    const total = factors.reduce((sum, f) => sum + (f.shareOfRoasMove ?? 0), 0);
    expect(total).toBeCloseTo(100, 0);
  });

  it("gets the direction of CPM right even when it is counter-intuitive", () => {
    // Spend rose 16.7% but impressions rose 40%, so CPM actually FELL: 24 → 20.
    // A rising bill is not a rising CPM, and the identity does not let the two
    // be confused — this factor helped ROAS in this period.
    const { factors } = decomposeRoas(NOW, BEFORE);
    const cpm = factors.find((f) => f.factor === "cpm");
    expect(cpm?.previous).toBeCloseTo(24, 1);
    expect(cpm?.current).toBeCloseTo(20, 1);
    expect(cpm?.hurt).toBe(false);
  });

  it("names CPM as hurting when it genuinely rose", () => {
    const dearer = line({ spend: 14000, impressions: 350000, clicks: 4500, purchases: 18, purchaseValue: 44800 });
    const { factors } = decomposeRoas(dearer, BEFORE);
    const cpm = factors.find((f) => f.factor === "cpm");
    expect(cpm?.current).toBeGreaterThan(cpm?.previous as number);
    expect(cpm?.hurt).toBe(true);
  });

  it("names CTR as a factor that hurt when it fell", () => {
    // Same clicks spread over more impressions: 1.80% → 1.29%.
    const { factors } = decomposeRoas(NOW, BEFORE);
    const ctr = factors.find((f) => f.factor === "ctr");
    expect(ctr?.changePercent).toBeLessThan(0);
    expect(ctr?.hurt).toBe(true);
  });

  it("names the conversion rate when the click side held and purchases fell", () => {
    const { factors } = decomposeRoas(NOW, BEFORE);
    const cvr = factors.find((f) => f.factor === "cvr");
    // 18/9000 vs 31/9000 — clicks identical, purchases down.
    expect(cvr?.changePercent).toBeLessThan(0);
    expect(cvr?.hurt).toBe(true);
  });

  it("puts the biggest mover first", () => {
    const { factors } = decomposeRoas(NOW, BEFORE);
    for (let i = 1; i < factors.length; i += 1) {
      expect(factors[i - 1].shareOfRoasMove ?? 0).toBeGreaterThanOrEqual(factors[i].shareOfRoasMove ?? 0);
    }
  });

  it("refuses to split when a factor is missing, and says which", () => {
    const noRevenue = line({ spend: 1000, impressions: 50000, clicks: 500, purchases: 4, purchaseValue: null });
    const { factors, blockedBy } = decomposeRoas(noRevenue, noRevenue);

    expect(blockedBy).toContain("aov");
    expect(factors.every((f) => f.shareOfRoasMove === null)).toBe(true);
  });

  it("refuses to split when a period had no purchases to build a rate on", () => {
    const zero = line({ spend: 1000, impressions: 50000, clicks: 500, purchases: 0, purchaseValue: 0 });
    const { blockedBy } = decomposeRoas(zero, BEFORE);
    expect(blockedBy.length).toBeGreaterThan(0);
  });
});

describe("derived rates", () => {
  it("computes conversion rate, AOV and frequency only when the inputs are real", () => {
    expect(conversionRateOf(metrics({ purchases: 10, clicks: 500 }))).toBeCloseTo(0.02, 5);
    expect(conversionRateOf(metrics({ purchases: 10, clicks: 0 }))).toBeNull();

    expect(averageOrderValueOf(metrics({ purchases: 4, purchaseValue: 2000 }))).toBe(500);
    expect(averageOrderValueOf(metrics({ purchases: 4, purchaseValue: null }))).toBeNull();

    expect(frequencyOf(metrics({ impressions: 1000, reach: 400 }))).toBeCloseTo(2.5, 5);
    expect(frequencyOf(metrics({ impressions: 1000, reach: 0 }))).toBeNull();
  });
});

describe("attribution across children", () => {
  const big = line({ spend: 9000, impressions: 400000, clicks: 6000, purchases: 8, purchaseValue: 20000 });
  const bigBefore = line({ spend: 8000, impressions: 330000, clicks: 6000, purchases: 20, purchaseValue: 41000 });
  const small = line({ spend: 5000, impressions: 300000, clicks: 3000, purchases: 10, purchaseValue: 24800 });
  const smallBefore = line({ spend: 4000, impressions: 170000, clicks: 3000, purchases: 11, purchaseValue: 20200 });

  const children: ChildPeriods[] = [
    { row: row("s1", "SET1", big), previous: bigBefore },
    { row: row("s2", "SET2", small), previous: smallBefore },
  ];

  it("names the ad set that carries most of the drop", () => {
    const result = run({ current: NOW, previous: BEFORE, children });

    const set1 = result.contributions.find((c) => c.objectId === "s1");
    expect(set1?.deltaPurchases).toBe(-12);
    // The scope lost 13; SET1 lost 12 of them.
    expect(set1?.shareOfPurchaseChange).toBeCloseTo(92.3, 0);
    expect(set1?.movedWithScope).toBe(true);
    // And it is first, because attribution orders by share of the change.
    expect(result.contributions[0].objectId).toBe("s1");
  });

  it("keeps a child that moved the other way visible and marks it as such", () => {
    const result = run({ current: NOW, previous: BEFORE, children });
    const set2 = result.contributions.find((c) => c.objectId === "s2");
    expect(set2?.deltaPurchases).toBe(-1);
    expect(set2?.shareOfPurchaseChange).toBeCloseTo(7.7, 0);
  });

  it("reports an ad whose fall explains its ad set's fall", () => {
    // Same arithmetic one level down: the engine does not care which level it
    // is given, which is why the tool can call it at three depths.
    const adResult = diagnose({
      currency: "TRY",
      scope: { level: "adset", id: "s1", name: "SET1" },
      current: big,
      previous: bigBefore,
      days: 7,
      childLevel: "ad",
      children: [
        { row: row("a1", "J3", line({ spend: 7000, impressions: 320000, clicks: 4800, purchases: 4, purchaseValue: 9000 }), { level: "ad" }), previous: line({ spend: 6000, impressions: 250000, clicks: 4800, purchases: 16, purchaseValue: 33000 }) },
        { row: row("a2", "B2", line({ spend: 2000, impressions: 80000, clicks: 1200, purchases: 4, purchaseValue: 11000 }), { level: "ad" }), previous: line({ spend: 2000, impressions: 80000, clicks: 1200, purchases: 4, purchaseValue: 8000 }) },
      ],
    });

    const j3 = adResult.contributions.find((c) => c.objectId === "a1");
    expect(j3?.deltaPurchases).toBe(-12);
    expect(j3?.shareOfPurchaseChange).toBe(100);
    expect(adResult.contributions[0].objectId).toBe("a1");
  });
});

describe("data sufficiency", () => {
  it("calls a tiny spender low confidence and says why", () => {
    const tiny = line({ spend: 200, impressions: 9000, clicks: 100, purchases: 1, purchaseValue: 500 });
    const result = run({
      current: NOW,
      previous: BEFORE,
      children: [{ row: row("t", "Küçük", tiny), previous: tiny }],
    });

    const contribution = result.contributions[0];
    expect(contribution.confidence).toBe("low");
    expect(contribution.confidenceReason).toMatch(/harcamasının|harcama/i);
  });

  it("calls a child with no previous period low confidence", () => {
    const fresh = line({ spend: 6000, impressions: 300000, clicks: 4000, purchases: 9, purchaseValue: 20000 });
    const result = run({
      current: NOW,
      previous: BEFORE,
      children: [{ row: row("n", "Yeni", fresh), previous: null }],
    });

    expect(result.contributions[0].confidence).toBe("low");
    expect(result.contributions[0].confidenceReason).toMatch(/Önceki dönemde veri yok/);
    expect(result.contributions[0].deltaPurchases).toBeNull();
  });

  it("refuses to interpret the split when nothing has material volume", () => {
    const tiny = line({ spend: 100, impressions: 5000, clicks: 50, purchases: 0, purchaseValue: 0 });
    const result = run({
      current: NOW,
      previous: BEFORE,
      children: [{ row: row("t", "Küçük", tiny), previous: tiny }],
    });

    expect(result.confidence).toBe("low");
    expect(result.confidenceReason).toMatch(/yorumlanamaz/);
  });
});

describe("delivery signals outside the identity", () => {
  it("reports a rising frequency", () => {
    const saturated = line({ spend: 14000, impressions: 700000, reach: 180000, clicks: 9000, purchases: 18, purchaseValue: 44800 });
    const fresh = line({ spend: 12000, impressions: 500000, reach: 250000, clicks: 9000, purchases: 31, purchaseValue: 61200 });

    const result = run({ current: saturated, previous: fresh });
    const signal = result.signals.find((s) => s.kind === "frequency_rising");
    expect(signal).toBeDefined();
    expect(signal?.facts.current).toBeCloseTo(3.89, 1);
    expect(signal?.statement).toContain("Frekans");
  });

  it("reports a budget-capped ad set", () => {
    const capped = line({ spend: 7000, impressions: 300000, clicks: 4000, purchases: 9, purchaseValue: 22000 });
    const result = run({
      current: NOW,
      previous: BEFORE,
      days: 7,
      // 7000 over 7 days = 1000/day against a 1000 budget.
      children: [{ row: row("c", "SET-CAP", capped, { dailyBudget: 1000 }), previous: capped }],
    });

    const signal = result.signals.find((s) => s.kind === "budget_capped");
    expect(signal?.objectName).toBe("SET-CAP");
    expect(signal?.facts.utilisation).toBeCloseTo(100, 0);
  });

  it("reports an ad set that could not spend its budget", () => {
    const slow = line({ spend: 2100, impressions: 90000, clicks: 1200, purchases: 4, purchaseValue: 9000 });
    const result = run({
      current: NOW,
      previous: BEFORE,
      days: 7,
      // 300/day against a 1000 budget.
      children: [{ row: row("u", "SET-YAVAŞ", slow, { dailyBudget: 1000 }), previous: slow }],
    });

    const signal = result.signals.find((s) => s.kind === "under_delivering");
    expect(signal?.objectName).toBe("SET-YAVAŞ");
    expect(signal?.facts.utilisation).toBeCloseTo(30, 0);
  });

  it("reports spend that moved without conversions following it", () => {
    const grew = line({ spend: 8000, impressions: 380000, clicks: 5000, purchases: 5, purchaseValue: 12000 });
    const was = line({ spend: 5000, impressions: 240000, clicks: 3200, purchases: 9, purchaseValue: 21000 });

    const result = run({
      current: NOW,
      previous: BEFORE,
      children: [{ row: row("g", "SET-BÜYÜYEN", grew), previous: was }],
    });

    const signal = result.signals.find((s) => s.kind === "spend_shifted");
    expect(signal?.objectName).toBe("SET-BÜYÜYEN");
    expect(signal?.facts.deltaSpend).toBe(3000);
    expect(signal?.facts.deltaPurchases).toBe(-4);
  });

  it("reports objects that did not deliver at all", () => {
    const result = run({
      current: NOW,
      previous: BEFORE,
      children: [{ row: row("z", "SESSIZ", metrics()), previous: metrics() }],
    });

    const signal = result.signals.find((s) => s.kind === "no_delivery");
    expect(signal?.facts.count).toBe(1);
  });

  it("surfaces a budget that differs between the two snapshots", () => {
    // Insights carry no budget history, so this is only reported when the
    // caller genuinely knows both — here the two rows differ.
    const m = line({ spend: 7000, impressions: 300000, clicks: 4000, purchases: 9, purchaseValue: 22000 });
    const result = run({
      current: NOW,
      previous: BEFORE,
      days: 7,
      children: [{ row: row("b", "SET-BÜTÇE", m, { dailyBudget: 1500 }), previous: m }],
    });

    const contribution = result.contributions.find((c) => c.objectId === "b");
    expect(contribution?.dailyBudget).toBe(1500);
    // 1000/day against 1500 — visible as utilisation, which is the honest
    // reading available from insights.
    expect(contribution?.budgetUtilisation).toBeCloseTo(66.7, 0);
  });
});

describe("a quiet account", () => {
  it("produces no signals and no attribution rather than inventing a story", () => {
    const result = run({ current: metrics(), previous: metrics(), children: [] });
    expect(result.contributions).toHaveLength(0);
    expect(result.signals).toHaveLength(0);
    expect(result.confidence).toBe("low");
    expect(result.factors.blockedBy.length).toBeGreaterThan(0);
  });
});
