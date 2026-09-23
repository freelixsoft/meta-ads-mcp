import { describe, expect, it } from "vitest";

/**
 * The performance review engine.
 *
 * Everything here is about one distinction: "bu reklam kötü" and "bu reklam
 * kötüleşti" are different claims, they are supported by different arithmetic,
 * and an answer that merges them is wrong even when both happen to be true.
 * So the scenarios below are built in pairs — a metric falling while its
 * partner rises, a bad ad that is improving, a good ad that is deteriorating —
 * and each one asserts which list the object lands in, not just that some
 * signal fired.
 *
 * The second theme is restraint. One metric moving is one metric moving, and
 * the sentence the engine hands the model has to say so; corroboration is a
 * count, not a feeling; a paused ad is not a bad ad; and nothing in the result
 * is allowed to be advice.
 */

import {
  reviewPerformance,
  type ObjectReview,
  type ReviewMetric,
} from "../../src/claude/performance-review.js";
import type { EntityRowDto, MetricsDto } from "../../src/dashboard/dto.js";

/**
 * A coherent metric line: every rate is derived from the counters rather than
 * invented, so a fixture cannot assert a change the arithmetic would not
 * produce on real Meta data.
 */
function line(input: {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue?: number | null;
  reach?: number;
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

function row(id: string, name: string, metrics: MetricsDto, overrides: Partial<EntityRowDto> = {}): EntityRowDto {
  return {
    id,
    level: "ad",
    name,
    status: "ACTIVE",
    effectiveStatus: "ACTIVE",
    objective: null,
    campaignId: "c1",
    campaignName: "Kış",
    adSetId: "s1",
    adSetName: "SET1",
    creativeId: null,
    dailyBudget: null,
    lifetimeBudget: null,
    metrics,
    ...overrides,
  };
}

interface Fixture {
  row: EntityRowDto;
  previous?: MetricsDto;
}

function review(fixtures: Fixture[]) {
  return reviewPerformance({
    level: "ad",
    currency: "TRY",
    rows: fixtures.map((fixture) => fixture.row),
    previousById: new Map(
      fixtures
        .filter((fixture) => fixture.previous !== undefined)
        .map((fixture) => [fixture.row.id, fixture.previous as MetricsDto]),
    ),
  });
}

function pick(reviews: ObjectReview[], id: string): ObjectReview {
  const found = reviews.find((entry) => entry.objectId === id);
  if (!found) throw new Error(`no review for ${id}`);
  return found;
}

function ids(reviews: ObjectReview[]): string[] {
  return reviews.map((entry) => entry.objectId);
}

function signalKeys(reviews: ObjectReview[], id: string): ReviewMetric[] {
  return pick(reviews, id).deteriorationSignals.map((signal) => signal.metric);
}

function improvementKeys(reviews: ObjectReview[], id: string): ReviewMetric[] {
  return pick(reviews, id).improvementSignals.map((signal) => signal.metric);
}

/** A second ad with enough volume that the ad under test clears the spend-share floor. */
function ballast(spend = 1000, purchases = 20, purchaseValue = 5000): Fixture {
  const metrics = line({ spend, impressions: 100_000, clicks: 1000, purchases, purchaseValue });
  return { row: row("ballast", "Ballast", metrics), previous: metrics };
}

// ─── Two metrics moving the same way ─────────────────────────────

describe("a deterioration is counted, not felt", () => {
  it("reads a falling ROAS and a rising CPA as one corroborated signal, not two verdicts", () => {
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 5, purchaseValue: 2500 })),
        previous: line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 10, purchaseValue: 5000 }),
      },
    ]);

    const keys = signalKeys(result.reviews, "a1");
    expect(keys).toContain("roas");
    expect(keys).toContain("costPerPurchase");
    expect(keys).toContain("purchases");
    expect(pick(result.reviews, "a1").deteriorationStrength).toBe("corroborated");
    expect(ids(result.deteriorating)).toContain("a1");
    expect(pick(result.reviews, "a1").deteriorationStatement).toContain(
      "tek metriğe dayanmayan bir bozulma sinyali",
    );
  });

  it("names the combination when CPA, ROAS and purchases all move the wrong way", () => {
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 5, purchaseValue: 2500 })),
        previous: line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 10, purchaseValue: 5000 }),
      },
    ]);

    const patterns = pick(result.reviews, "a1").deteriorationPatterns.map((pattern) => pattern.key);
    expect(patterns).toContain("cost_and_return");
  });

  it("reads a falling CTR with a rising CPC as the traffic-side combination", () => {
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 10, purchaseValue: 2500 })),
        previous: line({ spend: 1000, impressions: 100_000, clicks: 2000, purchases: 20, purchaseValue: 5000 }),
      },
    ]);

    const keys = signalKeys(result.reviews, "a1");
    expect(keys).toContain("ctr");
    expect(keys).toContain("cpc");
    expect(keys).toContain("purchases");
    const patterns = pick(result.reviews, "a1").deteriorationPatterns.map((pattern) => pattern.key);
    expect(patterns).toContain("traffic_and_cost");
  });

  it("stays tentative, and says so in the sentence, when only one metric moved", () => {
    // CPM rises while CTR rises enough to keep CPC and conversion rate inside
    // the material threshold: exactly one signal, and the wording has to
    // survive being quoted on its own.
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 1000, impressions: 70_000, clicks: 1200, purchases: 20, purchaseValue: 5000 })),
        previous: line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 20, purchaseValue: 5000 }),
      },
    ]);

    const entry = pick(result.reviews, "a1");
    expect(signalKeys(result.reviews, "a1")).toEqual(["cpm"]);
    expect(entry.deteriorationStrength).toBe("single");
    expect(entry.deteriorationStatement).toContain("en belirgin olumsuz sinyal CPM tarafında");
    expect(entry.deteriorationStatement).toContain("tek sinyale dayanıyor");
    expect(entry.deteriorationStatement).not.toContain("tek metriğe dayanmayan");
    expect(entry.deteriorationPatterns).toEqual([]);
  });
});

// ─── The same metrics moving the right way ───────────────────────

describe("an improvement is not a deterioration wearing a different sign", () => {
  it("emits no deterioration when ROAS rises and CPA falls", () => {
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 1000, impressions: 50_000, clicks: 500, purchases: 10, purchaseValue: 6000 })),
        previous: line({ spend: 1000, impressions: 50_000, clicks: 500, purchases: 5, purchaseValue: 2500 }),
      },
    ]);

    const entry = pick(result.reviews, "a1");
    expect(entry.deteriorationSignals).toEqual([]);
    expect(entry.deteriorationStatement).toBeNull();
    expect(entry.trend).toBe("improving");
    expect(improvementKeys(result.reviews, "a1")).toEqual(
      expect.arrayContaining(["roas", "costPerPurchase", "purchases"]),
    );
    expect(ids(result.deteriorating)).not.toContain("a1");
  });

  it("treats spend as context, so a smaller budget with a better return is not a decline", () => {
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 1000, impressions: 50_000, clicks: 500, purchases: 10, purchaseValue: 4000 })),
        previous: line({ spend: 2000, impressions: 100_000, clicks: 1000, purchases: 10, purchaseValue: 4000 }),
      },
    ]);

    const entry = pick(result.reviews, "a1");
    const spendMove = entry.moves.find((move) => move.metric === "spend");
    expect(spendMove?.direction).toBe("context");
    expect(spendMove?.material).toBe(false);
    expect(spendMove?.changePercent).toBe(-50);
    expect(entry.deteriorationSignals).toEqual([]);
    expect(entry.trend).toBe("improving");
  });

  it("separates a falling purchase count from a rising basket", () => {
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 1000, impressions: 50_000, clicks: 500, purchases: 6, purchaseValue: 4500 })),
        previous: line({ spend: 1000, impressions: 50_000, clicks: 500, purchases: 10, purchaseValue: 5000 }),
      },
    ]);

    const entry = pick(result.reviews, "a1");
    expect(signalKeys(result.reviews, "a1")).toContain("purchases");
    expect(improvementKeys(result.reviews, "a1")).toContain("averageOrderValue");
    expect(entry.trend).toBe("mixed");
    // The basket rose 50% while revenue moved 10%; only the first is a signal.
    expect(signalKeys(result.reviews, "a1")).not.toContain("purchaseValue");
  });
});

// ─── The two lists ───────────────────────────────────────────────

describe("low performance and a decline are answered separately", () => {
  /**
   * One account, four ads, each built to land in a different place:
   * J3 is strong, B2 is strong-but-falling, ZAYIF is weak-but-rising, and the
   * baselines come from all of them together.
   */
  function account() {
    return review([
      {
        row: row("j3", "J3", line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 20, purchaseValue: 6290 })),
        previous: line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 20, purchaseValue: 6290 }),
      },
      {
        row: row("b2", "B2", line({ spend: 10_548.1, impressions: 900_000, clicks: 9000, purchases: 10, purchaseValue: 42_192.4 })),
        previous: line({ spend: 4685.5, impressions: 400_000, clicks: 4000, purchases: 10, purchaseValue: 18_742 }),
      },
      {
        row: row("zayif", "ZAYIF", line({ spend: 1000, impressions: 50_000, clicks: 500, purchases: 5, purchaseValue: 1000 })),
        previous: line({ spend: 1000, impressions: 50_000, clicks: 500, purchases: 2, purchaseValue: 300 }),
      },
    ]);
  }

  it("puts an ad that is weak now but rising in the current-performance list only", () => {
    const result = account();
    const entry = pick(result.reviews, "zayif");

    expect(ids(result.underperforming)).toContain("zayif");
    expect(ids(result.deteriorating)).not.toContain("zayif");
    expect(entry.trend).toBe("improving");
    expect(entry.weaknesses.map((weakness) => weakness.kind)).toContain("roas_below_account");
    expect(entry.improvementStatement).toContain(
      "önceki döneme göre bir kötüleşme değil",
    );
  });

  it("puts an ad that is still strong but falling in the decline list only", () => {
    const result = account();

    expect(ids(result.deteriorating)).toContain("b2");
    expect(ids(result.underperforming)).not.toContain("b2");
  });

  it("quotes both values and the percentage for the strongest signal", () => {
    const statement = pick(account().reviews, "b2").deteriorationStatement ?? "";

    expect(statement).toContain("468,55 TRY → 1.054,81 TRY");
    expect(statement).toContain("%125,1 artış");
    expect(statement).toContain("en belirgin olumsuz sinyal Satın alma maliyeti (CPA) tarafında");
  });

  it("never claims an ad is the only one with a problem, or names a cause", () => {
    const serialized = JSON.stringify(account());

    for (const banned of ["tek reklam", "ana sebep", "kesin sebep", "yüzünden", "nedeniyle"]) {
      expect(serialized.toLowerCase()).not.toContain(banned);
    }
  });

  it("does not count a high cost per purchase as a weakness when the basket pays for it", () => {
    const result = account();
    const b2 = pick(result.reviews, "b2");

    // B2 costs nearly three times the account's average per order and still
    // returns above the account's ROAS: the expensive order is a big one, not
    // a bad one, and reporting it as a second problem would double-count it.
    expect(b2.metrics.costPerPurchase).toBe(1054.81);
    expect(result.baselines.accountCostPerPurchase).toBeLessThan(500);
    expect(b2.weaknesses).toEqual([]);
  });

  it("does report a high cost per purchase when the return does not cover it", () => {
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 4, purchaseValue: 1200 })),
        previous: line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 4, purchaseValue: 1200 }),
      },
    ]);

    const kinds = pick(result.reviews, "a1").weaknesses.map((weakness) => weakness.kind);
    expect(kinds).toContain("cpa_above_account");
    expect(kinds).toContain("roas_below_account");
  });

  it("names the ids that belong to both lists instead of implying they are exclusive", () => {
    // A weak ad that is also falling: below the account average AND worse than
    // it was. Both readings are true and both are reported.
    const result = review([
      ballast(2000, 40, 20_000),
      {
        row: row("a1", "A1", line({ spend: 2000, impressions: 100_000, clicks: 1000, purchases: 4, purchaseValue: 1200 })),
        previous: line({ spend: 2000, impressions: 100_000, clicks: 1000, purchases: 12, purchaseValue: 6000 }),
      },
    ]);

    expect(ids(result.deteriorating)).toContain("a1");
    expect(ids(result.underperforming)).toContain("a1");
    expect(result.overlap).toContain("a1");
  });
});

// ─── What is not comparable ──────────────────────────────────────

describe("what cannot be judged is said rather than ranked", () => {
  it("keeps a paused ad out of both lists and states why", () => {
    const result = review([
      ballast(),
      {
        row: row("p1", "P1", line({ spend: 800, impressions: 60_000, clicks: 400, purchases: 0, purchaseValue: 0 }), {
          status: "PAUSED",
          effectiveStatus: "PAUSED",
        }),
        previous: line({ spend: 800, impressions: 60_000, clicks: 400, purchases: 8, purchaseValue: 4000 }),
      },
    ]);

    const entry = pick(result.reviews, "p1");
    expect(entry.active).toBe(false);
    expect(entry.excludedBecause).toBe("paused");
    expect(entry.weaknesses).toEqual([]);
    expect(ids(result.excluded)).toContain("p1");
    expect(ids(result.deteriorating)).not.toContain("p1");
    expect(ids(result.underperforming)).not.toContain("p1");
    expect(entry.exclusionStatement).toContain("duraklatılmış");
    expect(entry.exclusionStatement).toContain(
      "aktif performans karşılaştırmasına dahil edilmedi",
    );
    // The money it did spend before it stopped is still reported.
    expect(entry.exclusionStatement).toContain("800,00 TRY");
  });

  it("excludes an ad whose parent is paused, and an archived one, for their own reasons", () => {
    const result = review([
      ballast(),
      {
        row: row("p2", "P2", line({ spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0 }), {
          effectiveStatus: "CAMPAIGN_PAUSED",
        }),
      },
      {
        row: row("p3", "P3", line({ spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0 }), {
          effectiveStatus: "ARCHIVED",
        }),
      },
    ]);

    expect(pick(result.reviews, "p2").excludedBecause).toBe("paused");
    expect(pick(result.reviews, "p2").exclusionStatement).toContain("bağlı olduğu kampanya");
    expect(pick(result.reviews, "p3").excludedBecause).toBe("inactive");
    expect(pick(result.reviews, "p3").exclusionStatement).toContain("arşivlenmiş");
  });

  it("excludes an ad that is active but never delivered", () => {
    const result = review([
      ballast(),
      { row: row("n1", "N1", line({ spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0 })) },
    ]);

    const entry = pick(result.reviews, "n1");
    expect(entry.excludedBecause).toBe("no_delivery");
    expect(entry.exclusionStatement).toContain("hiç gösterim almadı");
    expect(ids(result.underperforming)).not.toContain("n1");
  });

  it("calls thin data thin instead of calling it bad", () => {
    const result = review([
      ballast(),
      {
        row: row("t1", "T1", line({ spend: 30, impressions: 2000, clicks: 20, purchases: 1, purchaseValue: 10 })),
        previous: line({ spend: 30, impressions: 2000, clicks: 20, purchases: 3, purchaseValue: 1500 }),
      },
    ]);

    const entry = pick(result.reviews, "t1");
    expect(entry.dataSufficiency).toBe("insufficient");
    expect(entry.dataSufficiencyReason).toContain("oranlar güvenilir değil");
    expect(ids(result.insufficientData)).toContain("t1");
    expect(ids(result.underperforming)).not.toContain("t1");
    expect(ids(result.deteriorating)).not.toContain("t1");
  });

  it("does not read a trend off two or three purchases", () => {
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 1, purchaseValue: 400 })),
        previous: line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 2, purchaseValue: 900 }),
      },
    ]);

    // ROAS halved on paper, but two purchases against one is not a reading.
    expect(signalKeys(result.reviews, "a1")).not.toContain("roas");
    expect(signalKeys(result.reviews, "a1")).not.toContain("purchases");
  });

  it("says a comparison is impossible when the previous period returned nothing", () => {
    const result = review([
      ballast(),
      { row: row("a1", "A1", line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 10, purchaseValue: 4000 })) },
    ]);

    const entry = pick(result.reviews, "a1");
    expect(entry.trend).toBe("unknown");
    expect(entry.previousMetrics).toBeNull();
    expect(entry.deteriorationSignals).toEqual([]);
    expect(entry.dataSufficiencyReason).toContain("Önceki dönemde veri yok");
  });
});

// ─── A strong result is a measurement ────────────────────────────

describe("a strong result is reported, not acted on", () => {
  it("states the ROAS and the account average, and nothing else", () => {
    const result = review([
      ballast(1000, 4, 1000),
      {
        row: row("j3", "J3", line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 20, purchaseValue: 6290 })),
        previous: line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 20, purchaseValue: 6290 }),
      },
    ]);

    const entry = pick(result.reviews, "j3");
    expect(entry.strong).toBe(true);
    expect(entry.strongStatement).toContain("6,29 ROAS ile güçlü performans gösteriyor");
    expect(ids(result.strong)).toContain("j3");
  });

  it("carries no action, no budget and no recommendation anywhere in the result", () => {
    const result = review([
      ballast(1000, 4, 1000),
      {
        row: row("j3", "J3", line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 20, purchaseValue: 6290 })),
        previous: line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 20, purchaseValue: 6290 }),
      },
    ]);

    const serialized = JSON.stringify(result).toLowerCase();
    for (const banned of ["bütçe", "artırmayı", "durdurmayı", "öneri", "değerlendirin", "kapatın"]) {
      expect(serialized).not.toContain(banned);
    }
    for (const field of ["action", "writeTool", "priorityBasis", "goal", "risk"]) {
      expect(Object.keys(pick(result.reviews, "j3"))).not.toContain(field);
    }
  });

  it("will not call a high ROAS strong on a handful of purchases", () => {
    const result = review([
      ballast(1000, 4, 1000),
      {
        row: row("a1", "A1", line({ spend: 100, impressions: 5000, clicks: 100, purchases: 2, purchaseValue: 3000 })),
        previous: line({ spend: 100, impressions: 5000, clicks: 100, purchases: 2, purchaseValue: 3000 }),
      },
    ]);

    expect(pick(result.reviews, "a1").strong).toBe(false);
  });
});

// ─── Shape of the result ─────────────────────────────────────────

describe("the result keeps the reader honest about what it covers", () => {
  it("counts each list and orders every one of them by spend", () => {
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 5000, impressions: 400_000, clicks: 4000, purchases: 5, purchaseValue: 2500 })),
        previous: line({ spend: 5000, impressions: 400_000, clicks: 4000, purchases: 20, purchaseValue: 10_000 }),
      },
      {
        row: row("a2", "A2", line({ spend: 2000, impressions: 200_000, clicks: 2000, purchases: 4, purchaseValue: 2000 })),
        previous: line({ spend: 2000, impressions: 200_000, clicks: 2000, purchases: 16, purchaseValue: 8000 }),
      },
    ]);

    expect(result.counts.reviewed).toBe(3);
    expect(result.counts.deteriorating).toBe(result.deteriorating.length);
    expect(ids(result.deteriorating)).toEqual(["a1", "a2"]);
    expect(result.counts.corroborated + result.counts.singleSignal).toBe(
      result.deteriorating.length,
    );
  });

  it("names a metric Meta reported for no row at all", () => {
    const noRevenue = line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 0, purchaseValue: null });
    const result = review([{ row: row("a1", "A1", noRevenue), previous: noRevenue }]);

    expect(result.metricsMissingOnEveryRow).toContain("purchaseValue");
    expect(result.metricsMissingOnEveryRow).toContain("roas");
  });

  it("reports zero-conversion spend against the account's own cost per purchase", () => {
    const result = review([
      ballast(),
      {
        row: row("a1", "A1", line({ spend: 900, impressions: 80_000, clicks: 800, purchases: 0, purchaseValue: 0 })),
        previous: line({ spend: 900, impressions: 80_000, clicks: 800, purchases: 0, purchaseValue: 0 }),
      },
    ]);

    const weakness = pick(result.reviews, "a1").weaknesses.find(
      (entry) => entry.kind === "zero_conversion_spend",
    );
    expect(weakness?.statement).toContain("0 satın alma üretti");
    expect(weakness?.statement).toContain("hesabın ortalama satın alma maliyeti");
    expect(ids(result.underperforming)).toContain("a1");
  });

  it("returns empty lists rather than a least-bad ad when nothing crossed a threshold", () => {
    const steady = line({ spend: 1000, impressions: 100_000, clicks: 1000, purchases: 20, purchaseValue: 5000 });
    const result = review([
      { row: row("a1", "A1", steady), previous: steady },
      { row: row("a2", "A2", steady), previous: steady },
    ]);

    expect(result.deteriorating).toEqual([]);
    expect(result.underperforming).toEqual([]);
    expect(pick(result.reviews, "a1").trend).toBe("flat");
  });
});
