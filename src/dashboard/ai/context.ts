import type {
  ComparisonDto,
  EntityInsightsResponseDto,
  EntityLevel,
  EntityRowDto,
  MetricsDto,
  SeriesPointDto,
} from "../dto.js";
import { METRIC_KEYS } from "../services/comparison.js";
import { sanitizeLabel } from "./sanitize.js";

/**
 * The only thing the model is ever allowed to see.
 *
 * Built exclusively from DTOs the dashboard has already fetched, authorized and
 * whitelisted for the browser — this module never calls Meta and never touches
 * a token, a session or a Firestore document. Three further rules apply on top
 * of the DTO whitelist:
 *
 *  1. **No identifiers.** Account, campaign, ad set and ad ids are dropped.
 *     They add nothing to an analysis and every id left out is one fewer thing
 *     that can end up in a third-party's logs.
 *  2. **Nulls survive as nulls.** A metric Meta did not return is `null`, never
 *     `0`. The two mean opposite things ("no data" vs "measured zero"), and
 *     `missingMetrics` names them explicitly so the model does not have to
 *     infer the distinction.
 *  3. **Everything is bounded.** Row counts, series length, label length and
 *     the serialized byte size all have ceilings, so a large ad account cannot
 *     turn one question into an unbounded prompt.
 */

export const MAX_BREAKDOWN_ROWS = 25;
export const MAX_SERIES_POINTS = 62;
/** Ceiling on the serialized data block. Roughly 6k tokens of JSON. */
export const MAX_CONTEXT_BYTES = 24_000;

/** Row counts attempted in order until the serialized context fits the budget. */
const ROW_FALLBACKS = [MAX_BREAKDOWN_ROWS, 15, 10, 5] as const;

export interface AiMetrics {
  spend: number | null;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  purchases: number | null;
  addToCart: number | null;
  purchaseValue: number | null;
  costPerPurchase: number | null;
  roas: number | null;
}

export interface AiDelta {
  absolute: number | null;
  percent: number | null;
}

export interface AiBreakdownRow {
  name: string;
  status: string;
  metrics: AiMetrics;
  /** Share of the scope's spend, in percent. Precomputed so the model never has to divide. */
  spendShare: number | null;
}

export interface AiAnalysisContext {
  account: { name: string; currency: string };
  scope: { level: EntityLevel; name: string; status: string | null; objective: string | null };
  period: { preset: string; since: string | null; until: string | null };
  previousPeriod: { since: string; until: string } | null;
  current: AiMetrics;
  previous: AiMetrics | null;
  changes: Record<string, AiDelta> | null;
  dailySeries: Array<{
    date: string;
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    purchases: number | null;
    purchaseValue: number | null;
  }>;
  breakdown: {
    level: EntityLevel;
    /** How many rows exist in total, so "top 25 of 340" is stated, not guessed. */
    totalRows: number;
    rows: AiBreakdownRow[];
  } | null;
  /** Metric keys Meta returned no value for in the current period. */
  missingMetrics: string[];
  /** Everything that was dropped to stay inside the budget, in plain words. */
  truncation: string[];
}

/** Digits each metric is rounded to before it reaches the prompt. */
const METRIC_PRECISION: Record<keyof MetricsDto, number> = {
  spend: 2,
  impressions: 0,
  reach: 0,
  clicks: 0,
  ctr: 3,
  cpc: 4,
  cpm: 2,
  purchases: 0,
  addToCart: 0,
  purchaseValue: 2,
  costPerPurchase: 2,
  roas: 3,
};

export function round(value: number | null | undefined, digits: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Shared with the Claude tool layer so every surface rounds identically. */
export function toAiMetrics(metrics: MetricsDto): AiMetrics {
  const out = {} as AiMetrics;
  for (const key of METRIC_KEYS) {
    out[key] = round(metrics[key], METRIC_PRECISION[key]);
  }
  return out;
}

/**
 * Counters are reported as `0` by the DTO layer when a row is absent, which is
 * indistinguishable from a measured zero. Only the derived rates and the
 * revenue fields carry a real "Meta returned nothing" null, so those are what
 * gets listed — plus every counter on a scope with no delivery at all, where
 * the zeroes are genuinely "no data".
 */
export function findMissingMetrics(metrics: MetricsDto): string[] {
  const noDelivery = metrics.impressions === 0 && metrics.spend === 0;
  return METRIC_KEYS.filter((key) => {
    const value = metrics[key];
    if (value === null) return true;
    return noDelivery && value === 0;
  });
}

function toDeltas(comparison: ComparisonDto): Record<string, AiDelta> {
  const changes: Record<string, AiDelta> = {};
  for (const key of METRIC_KEYS) {
    const delta = comparison.changes[key];
    changes[key] = {
      absolute: round(delta?.absolute ?? null, METRIC_PRECISION[key]),
      percent: round(delta?.percent ?? null, 1),
    };
  }
  return changes;
}

function toSeries(points: SeriesPointDto[], limit: number): AiAnalysisContext["dailySeries"] {
  // The tail is kept rather than the head: when a range is too long to send in
  // full, the recent days are the ones a "what changed?" question is about.
  return points.slice(-limit).map((point) => ({
    date: point.date,
    spend: round(point.spend, 2),
    impressions: round(point.impressions, 0),
    clicks: round(point.clicks, 0),
    purchases: round(point.purchases, 0),
    purchaseValue: round(point.purchaseValue, 2),
  }));
}

function toBreakdownRows(rows: EntityRowDto[], limit: number): AiBreakdownRow[] {
  const totalSpend = rows.reduce((sum, row) => sum + (row.metrics.spend || 0), 0);
  return rows.slice(0, limit).map((row) => ({
    name: sanitizeLabel(row.name),
    status: sanitizeLabel(row.effectiveStatus ?? row.status) || "UNKNOWN",
    metrics: toAiMetrics(row.metrics),
    spendShare: totalSpend > 0 ? round((row.metrics.spend / totalSpend) * 100, 1) : null,
  }));
}

export interface BuildContextInput {
  insights: EntityInsightsResponseDto;
  /** Children of the scope, already authorized and metric-joined. Sorted by spend by the caller. */
  breakdown?: { level: EntityLevel; rows: EntityRowDto[] } | null;
}

/**
 * Assemble the data block, then shrink it until it serializes inside the byte
 * budget. Shrinking is deterministic and always announced in `truncation`, so
 * the model can say "top 10 of 340 campaigns" instead of implying it saw
 * everything.
 */
export function buildAnalysisContext(input: BuildContextInput): AiAnalysisContext {
  const { insights } = input;
  const allRows = input.breakdown?.rows ?? [];
  const sortedRows = [...allRows].sort((a, b) => (b.metrics.spend || 0) - (a.metrics.spend || 0));

  const base: AiAnalysisContext = {
    account: {
      name: sanitizeLabel(insights.account.name),
      currency: sanitizeLabel(insights.account.currency),
    },
    scope: {
      level: insights.entity.level,
      name: sanitizeLabel(insights.entity.name),
      status: insights.entity.effectiveStatus
        ? sanitizeLabel(insights.entity.effectiveStatus)
        : insights.entity.status
          ? sanitizeLabel(insights.entity.status)
          : null,
      objective: insights.entity.objective ? sanitizeLabel(insights.entity.objective) : null,
    },
    period: {
      preset: sanitizeLabel(insights.range.preset),
      since: insights.resolvedRange?.since ?? insights.range.since,
      until: insights.resolvedRange?.until ?? insights.range.until,
    },
    previousPeriod: insights.comparison?.range ?? null,
    current: toAiMetrics(insights.summary),
    previous: insights.comparison ? toAiMetrics(insights.comparison.previous) : null,
    changes: insights.comparison ? toDeltas(insights.comparison) : null,
    dailySeries: toSeries(insights.series, MAX_SERIES_POINTS),
    breakdown: input.breakdown
      ? { level: input.breakdown.level, totalRows: allRows.length, rows: [] }
      : null,
    missingMetrics: findMissingMetrics(insights.summary),
    truncation: [],
  };

  if (insights.series.length > MAX_SERIES_POINTS) {
    base.truncation.push(
      `Daily series trimmed to the last ${MAX_SERIES_POINTS} of ${insights.series.length} days.`,
    );
  }

  const budget = MAX_CONTEXT_BYTES;
  for (const limit of ROW_FALLBACKS) {
    const candidate: AiAnalysisContext = {
      ...base,
      truncation: [...base.truncation],
      breakdown: base.breakdown
        ? { ...base.breakdown, rows: toBreakdownRows(sortedRows, limit) }
        : null,
    };
    if (sortedRows.length > limit && candidate.breakdown) {
      candidate.truncation.push(
        `Breakdown shows the top ${limit} of ${sortedRows.length} rows by spend; the rest were not sent.`,
      );
    }
    if (serializedSize(candidate) <= budget) return candidate;
  }

  // Still over budget with the smallest row set: the series is the only part
  // left that can be large, so it goes rather than the breakdown.
  const minimal: AiAnalysisContext = {
    ...base,
    truncation: [...base.truncation],
    dailySeries: [],
    breakdown: base.breakdown
      ? { ...base.breakdown, rows: toBreakdownRows(sortedRows, ROW_FALLBACKS[ROW_FALLBACKS.length - 1]) }
      : null,
  };
  minimal.truncation.push("Daily series omitted entirely to stay inside the payload limit.");
  if (sortedRows.length > 5 && minimal.breakdown) {
    minimal.truncation.push(
      `Breakdown shows the top 5 of ${sortedRows.length} rows by spend; the rest were not sent.`,
    );
  }
  return minimal;
}

export function serializedSize(context: AiAnalysisContext): number {
  return Buffer.byteLength(JSON.stringify(context), "utf8");
}
