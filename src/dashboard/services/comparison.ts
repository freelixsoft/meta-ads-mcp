import type { MetricDelta, MetricsComparison, MetricsDto } from "../dto.js";

/**
 * Metrics where a smaller number is the better outcome. The API reports the
 * raw direction; this flag lets the UI colour a falling CPA as an improvement
 * instead of a regression, without the frontend having to re-derive which
 * metrics are costs.
 */
export const LOWER_IS_BETTER: ReadonlySet<keyof MetricsDto> = new Set([
  "cpc",
  "cpm",
  "costPerPurchase",
]);

const METRIC_KEYS: ReadonlyArray<keyof MetricsDto> = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "purchases",
  "addToCart",
  "purchaseValue",
  "costPerPurchase",
  "roas",
];

/**
 * Absolute and percentage change for one metric.
 *
 * Both sides can legitimately be null (a rate with no delivery, revenue with
 * no purchases), and the two nulls mean different things, so they are not
 * collapsed to zero:
 *
 *  - Neither period has a value  → both null; there is nothing to compare.
 *  - Only one period has a value → absolute is reported, percent is null.
 *    A move from "no data" to a number has no meaningful percentage.
 *  - Previous is exactly zero    → percent is null, not Infinity. Going from
 *    0 to 5 purchases is a real change but "+∞%" is not a number a dashboard
 *    should print.
 */
export function metricDelta(current: number | null, previous: number | null): MetricDelta {
  if (current === null && previous === null) return { absolute: null, percent: null };
  if (current === null || previous === null) {
    return { absolute: (current ?? 0) - (previous ?? 0), percent: null };
  }
  const absolute = current - previous;
  if (previous === 0) return { absolute, percent: null };
  const percent = (absolute / Math.abs(previous)) * 100;
  return { absolute, percent: Number.isFinite(percent) ? percent : null };
}

export function compareMetrics(current: MetricsDto, previous: MetricsDto): MetricsComparison {
  const changes = {} as MetricsComparison;
  for (const key of METRIC_KEYS) {
    changes[key] = metricDelta(current[key], previous[key]);
  }
  return changes;
}

export { METRIC_KEYS };
