import { describe, expect, it } from "vitest";
import {
  LOWER_IS_BETTER,
  METRIC_KEYS,
  compareMetrics,
  metricDelta,
} from "../../src/dashboard/services/comparison.js";
import { EMPTY_METRICS } from "../../src/dashboard/services/metrics.js";
import type { MetricsDto } from "../../src/dashboard/dto.js";

function metrics(overrides: Partial<MetricsDto>): MetricsDto {
  return { ...EMPTY_METRICS, ...overrides };
}

describe("metricDelta", () => {
  it("reports absolute and percentage change", () => {
    expect(metricDelta(150, 100)).toEqual({ absolute: 50, percent: 50 });
  });

  it("reports a decrease with a negative percentage", () => {
    expect(metricDelta(75, 100)).toEqual({ absolute: -25, percent: -25 });
  });

  it("reports no change as zero, not null", () => {
    expect(metricDelta(100, 100)).toEqual({ absolute: 0, percent: 0 });
  });

  it("returns a null percentage when the previous period was zero", () => {
    // 0 -> 5 is a real change, but "+Infinity%" is not a number to print.
    expect(metricDelta(5, 0)).toEqual({ absolute: 5, percent: null });
  });

  it("returns nulls when neither period has a value", () => {
    expect(metricDelta(null, null)).toEqual({ absolute: null, percent: null });
  });

  it("reports the absolute move but no percentage when one side is missing", () => {
    expect(metricDelta(4.2, null)).toEqual({ absolute: 4.2, percent: null });
    expect(metricDelta(null, 4.2)).toEqual({ absolute: -4.2, percent: null });
  });

  it("uses the magnitude of the previous value, so a negative baseline keeps its sign", () => {
    expect(metricDelta(-50, -100)).toEqual({ absolute: 50, percent: 50 });
  });

  it("never emits a non-finite percentage", () => {
    for (const [current, previous] of [
      [1, 0],
      [0, 0],
      [Number.MAX_VALUE, Number.MIN_VALUE],
    ] as const) {
      const delta = metricDelta(current, previous);
      expect(delta.percent === null || Number.isFinite(delta.percent)).toBe(true);
    }
  });
});

describe("compareMetrics", () => {
  const current = metrics({
    spend: 1200,
    impressions: 50000,
    clicks: 1000,
    ctr: 2,
    cpc: 1.2,
    purchases: 40,
    addToCart: 100,
    purchaseValue: 6000,
    costPerPurchase: 30,
    roas: 5,
  });
  const previous = metrics({
    spend: 1000,
    impressions: 40000,
    clicks: 800,
    ctr: 2,
    cpc: 1.25,
    purchases: 25,
    addToCart: 90,
    purchaseValue: 4000,
    costPerPurchase: 40,
    roas: 4,
  });

  it("covers every metric the dashboard renders", () => {
    const changes = compareMetrics(current, previous);
    for (const key of METRIC_KEYS) {
      expect(changes[key], key).toBeDefined();
    }
    expect(Object.keys(changes).sort()).toEqual([...METRIC_KEYS].sort());
  });

  it("computes growth correctly", () => {
    const changes = compareMetrics(current, previous);
    expect(changes.spend).toEqual({ absolute: 200, percent: 20 });
    expect(changes.purchases).toEqual({ absolute: 15, percent: 60 });
    expect(changes.roas).toEqual({ absolute: 1, percent: 25 });
  });

  it("reports a cost reduction as a negative change, leaving interpretation to lowerIsBetter", () => {
    const changes = compareMetrics(current, previous);
    expect(changes.costPerPurchase.absolute).toBe(-10);
    expect(changes.costPerPurchase.percent).toBe(-25);
    expect(LOWER_IS_BETTER.has("costPerPurchase")).toBe(true);
  });

  it("flags exactly the cost metrics as lower-is-better", () => {
    expect([...LOWER_IS_BETTER].sort()).toEqual(["cpc", "cpm", "costPerPurchase"].sort());
    expect(LOWER_IS_BETTER.has("spend")).toBe(false);
    expect(LOWER_IS_BETTER.has("roas")).toBe(false);
  });

  it("handles an empty previous period without inventing percentages", () => {
    const changes = compareMetrics(current, { ...EMPTY_METRICS });
    expect(changes.spend).toEqual({ absolute: 1200, percent: null });
    expect(changes.roas).toEqual({ absolute: 5, percent: null });
    expect(changes.ctr).toEqual({ absolute: 2, percent: null });
  });

  it("handles an empty current period", () => {
    const changes = compareMetrics({ ...EMPTY_METRICS }, previous);
    expect(changes.spend).toEqual({ absolute: -1000, percent: -100 });
    expect(changes.purchases).toEqual({ absolute: -25, percent: -100 });
  });
});
