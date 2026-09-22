import type { MetricsDto } from "../dto.js";

/**
 * Server-side derivation of the dashboard metrics from a raw Meta insights row.
 *
 * Two rules drive everything here:
 *
 *  1. Never sum across action-type aliases. Meta reports the same conversion
 *     under several `action_type` strings depending on the pixel/CAPI setup —
 *     `omni_purchase` is the deduplicated cross-surface count, `purchase` and
 *     `offsite_conversion.fb_pixel_purchase` overlap with it. Adding them
 *     double-counts. The first alias present, in priority order, wins.
 *  2. Rates are derived from the counters, never read back from Meta. `ctr`,
 *     `cpc` and `cpm` are absent from rows with no delivery and are not
 *     meaningful to average across campaigns, so computing them from
 *     spend/impressions/clicks keeps every surface internally consistent.
 */

/** Priority order: the deduplicated omni_* alias first, then pixel-specific ones. */
export const PURCHASE_ACTION_TYPES = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_web_purchase",
] as const;

export const ADD_TO_CART_ACTION_TYPES = [
  "omni_add_to_cart",
  "add_to_cart",
  "offsite_conversion.fb_pixel_add_to_cart",
  "onsite_web_add_to_cart",
] as const;

export interface ActionEntry {
  action_type?: unknown;
  value?: unknown;
}

export interface InsightsRowLike {
  spend?: unknown;
  impressions?: unknown;
  reach?: unknown;
  clicks?: unknown;
  actions?: unknown;
  action_values?: unknown;
  cost_per_action_type?: unknown;
  purchase_roas?: unknown;
  [key: string]: unknown;
}

/** Meta sends every numeric metric as a string; anything unparseable is absent, not zero. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function toCount(value: unknown): number {
  return toNumber(value) ?? 0;
}

/**
 * First entry whose action_type appears in `preferred`, resolved in the order
 * of `preferred` rather than the order Meta happened to serialize them in.
 */
export function pickAction(
  field: unknown,
  preferred: readonly string[],
): { actionType: string; value: number } | null {
  if (!Array.isArray(field)) return null;
  for (const actionType of preferred) {
    for (const raw of field as ActionEntry[]) {
      if (raw?.action_type !== actionType) continue;
      const value = toNumber(raw.value);
      if (value !== null) return { actionType, value };
    }
  }
  return null;
}

function ratio(numerator: number, denominator: number, scale = 1): number | null {
  if (denominator <= 0) return null;
  const result = (numerator / denominator) * scale;
  return Number.isFinite(result) ? result : null;
}

export function deriveMetrics(row: InsightsRowLike): MetricsDto {
  const spend = toCount(row.spend);
  const impressions = toCount(row.impressions);
  const reach = toCount(row.reach);
  const clicks = toCount(row.clicks);

  const purchase = pickAction(row.actions, PURCHASE_ACTION_TYPES);
  const addToCart = pickAction(row.actions, ADD_TO_CART_ACTION_TYPES);
  const purchases = purchase?.value ?? 0;

  // Value and cost are read for the *same* alias the count came from, so a
  // mixed-alias row cannot pair one conversion definition's count with
  // another's revenue.
  const purchaseValue = purchase
    ? (pickAction(row.action_values, [purchase.actionType])?.value ??
      pickAction(row.action_values, PURCHASE_ACTION_TYPES)?.value ??
      null)
    : null;

  const reportedCostPerPurchase = purchase
    ? (pickAction(row.cost_per_action_type, [purchase.actionType])?.value ?? null)
    : null;

  const reportedRoas =
    pickAction(row.purchase_roas, PURCHASE_ACTION_TYPES)?.value ??
    firstValue(row.purchase_roas);

  return {
    spend,
    impressions,
    reach,
    clicks,
    ctr: ratio(clicks, impressions, 100),
    cpc: ratio(spend, clicks),
    cpm: ratio(spend, impressions, 1000),
    purchases,
    addToCart: addToCart?.value ?? 0,
    purchaseValue,
    costPerPurchase: reportedCostPerPurchase ?? ratio(spend, purchases),
    // Meta's own purchase_roas is authoritative when present; otherwise it is
    // only derivable if a purchase value exists, which is the documented
    // "ROAS when purchase value is available" behaviour.
    roas: reportedRoas ?? (purchaseValue !== null ? ratio(purchaseValue, spend) : null),
  };
}

function firstValue(field: unknown): number | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  return toNumber((field[0] as ActionEntry | undefined)?.value);
}

export const EMPTY_METRICS: MetricsDto = Object.freeze({
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
});
