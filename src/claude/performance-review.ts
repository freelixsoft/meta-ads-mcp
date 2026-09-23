import type { EntityLevel, EntityRowDto, MetricsDto } from "../dashboard/dto.js";
import {
  computeBaselines,
  metricLineOf,
  HIGH_ROAS_RATIO,
  LOW_ROAS_RATIO,
  MATERIAL_CHANGE_PCT,
  MATERIAL_SPEND_SHARE,
  MIN_PURCHASES_FOR_HIGH_CONFIDENCE,
} from "./decision-engine.js";

/**
 * The performance review: "kötü" and "kötüleşti" are two different questions.
 *
 * Pure, like the two engines beside it — no I/O, no Meta client, no cache. It
 * exists because one flat list of "bad ads" quietly merges three claims a
 * reader will separate anyway:
 *
 *  1. **Low now.** ROAS is half the account's, or spend bought nothing. That
 *     is a statement about the current period alone, and it is true whether
 *     the ad is climbing out of a hole or falling into one.
 *  2. **Worse than before.** CPA doubled, purchases halved. That is a
 *     statement about two periods, and it stays true even when the ad is
 *     still the best one in the account.
 *  3. **Not comparable.** Paused, not delivering, or carrying so little spend
 *     and so few purchases that every rate on it is a rounding artefact.
 *
 * An object can satisfy (1) and (2) at once, either without the other, or
 * neither, so the result puts it in every list it belongs to rather than
 * picking one. The lists overlap on purpose and `overlap` names the objects in
 * both, because an answer that presents them as exclusive is wrong.
 *
 * Two further properties are structural rather than stylistic:
 *
 * - **No advice.** Nothing here is an action, a budget or a suggestion, and no
 *   field carries one. A strong ROAS is reported as a measurement; turning
 *   that into "scale it" is the optimization pass's job in
 *   `decision-engine.ts`, reached only when the user asked what to do.
 * - **Corroboration is counted, not felt.** One metric moving is one metric
 *   moving, and `deteriorationStrength` says so. A deterioration is called
 *   `corroborated` only when two or more distinct metrics moved the wrong way
 *   over the same two periods, which is what stops a single CPA spike from
 *   being written up as a verdict.
 *
 * Every rule from the engines next door still holds: `null` is never zero,
 * thresholds come from the account's own numbers, and a signal that needs a
 * missing metric is not emitted at all.
 */

// ─── Metrics this review reads ───────────────────────────────────

export type ReviewMetric =
  | "spend"
  | "purchases"
  | "purchaseValue"
  | "roas"
  | "costPerPurchase"
  | "ctr"
  | "cpc"
  | "cpm"
  | "conversionRate"
  | "averageOrderValue";

/**
 * Which direction is bad. A `context` metric is reported with both values and
 * never counted as a signal either way: spend falling is not a problem and
 * spend rising is not a result, so calling either one a deterioration would
 * put a number in the evidence that does not belong there.
 */
type Polarity = "higher_is_better" | "lower_is_better" | "context";

type Unit = "currency" | "percent" | "multiplier" | "count";

interface MetricSpec {
  key: ReviewMetric;
  label: string;
  polarity: Polarity;
  unit: Unit;
  digits: number;
  /**
   * True when the reading is built on the purchase count and therefore needs
   * enough purchases behind it before a change in it means anything.
   */
  purchaseBound: boolean;
  read(metrics: MetricsDto): number | null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

/** Purchases per click, as a percentage so it reads like the CTR beside it. */
export function conversionRatePercentOf(metrics: MetricsDto): number | null {
  const value = ratio(metrics.purchases, metrics.clicks);
  return value === null ? null : value * 100;
}

/** Revenue per purchase. Null when Meta reported no revenue. */
export function averageOrderValueOf(metrics: MetricsDto): number | null {
  if (metrics.purchaseValue === null) return null;
  return ratio(metrics.purchaseValue, metrics.purchases);
}

const METRIC_SPECS: MetricSpec[] = [
  { key: "spend", label: "Harcama", polarity: "context", unit: "currency", digits: 2, purchaseBound: false, read: (m) => m.spend },
  { key: "purchases", label: "Satın alma", polarity: "higher_is_better", unit: "count", digits: 0, purchaseBound: true, read: (m) => m.purchases },
  { key: "purchaseValue", label: "Satın alma değeri", polarity: "higher_is_better", unit: "currency", digits: 2, purchaseBound: true, read: (m) => m.purchaseValue },
  { key: "roas", label: "ROAS", polarity: "higher_is_better", unit: "multiplier", digits: 2, purchaseBound: true, read: (m) => m.roas },
  { key: "costPerPurchase", label: "Satın alma maliyeti (CPA)", polarity: "lower_is_better", unit: "currency", digits: 2, purchaseBound: true, read: (m) => m.costPerPurchase },
  { key: "ctr", label: "CTR", polarity: "higher_is_better", unit: "percent", digits: 2, purchaseBound: false, read: (m) => m.ctr },
  { key: "cpc", label: "CPC", polarity: "lower_is_better", unit: "currency", digits: 2, purchaseBound: false, read: (m) => m.cpc },
  { key: "cpm", label: "CPM", polarity: "lower_is_better", unit: "currency", digits: 2, purchaseBound: false, read: (m) => m.cpm },
  { key: "conversionRate", label: "Dönüşüm oranı", polarity: "higher_is_better", unit: "percent", digits: 2, purchaseBound: true, read: conversionRatePercentOf },
  { key: "averageOrderValue", label: "Sepet tutarı", polarity: "higher_is_better", unit: "currency", digits: 2, purchaseBound: true, read: averageOrderValueOf },
];

/**
 * A cost per purchase this far above the account's own average is "much worse
 * here" — the mirror of the ROAS ratios the decision engine uses, with the
 * same reasoning: the yardstick is the account, not a number someone picked.
 */
const HIGH_CPA_RATIO = 1.5;

// ─── Numeric and formatting helpers ──────────────────────────────

function round(value: number | null, digits: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  const value = ((current - previous) / Math.abs(previous)) * 100;
  return Number.isFinite(value) ? value : null;
}

function nf(value: number, digits: number): string {
  return new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatValue(value: number | null, spec: MetricSpec, currency: string): string {
  if (value === null) return "veri yok";
  switch (spec.unit) {
    case "currency":
      return `${nf(value, spec.digits)} ${currency}`;
    case "percent":
      return `%${nf(value, spec.digits)}`;
    case "multiplier":
      return `${nf(value, spec.digits)}x`;
    case "count":
      return nf(value, 0);
  }
}

function money(value: number | null, currency: string): string {
  return value === null ? "veri yok" : `${nf(value, 2)} ${currency}`;
}

// ─── One metric, over both periods ───────────────────────────────

export type MoveDirection = "worse" | "better" | "flat" | "context" | "unknown";

export interface MetricMove {
  metric: ReviewMetric;
  label: string;
  previous: number | null;
  current: number | null;
  changePercent: number | null;
  direction: MoveDirection;
  /** True when the move cleared the material threshold and may be quoted as a signal. */
  material: boolean;
  /** Turkish, built only from the two values. Never a summary, never a cause. */
  statement: string;
}

function directionOf(spec: MetricSpec, current: number, previous: number): MoveDirection {
  if (spec.polarity === "context") return "context";
  const delta = current - previous;
  if (delta === 0) return "flat";
  const worse = spec.polarity === "higher_is_better" ? delta < 0 : delta > 0;
  return worse ? "worse" : "better";
}

function moveOf(
  spec: MetricSpec,
  current: MetricsDto,
  previous: MetricsDto | null,
  currency: string,
): MetricMove {
  const now = spec.read(current);
  const before = previous === null ? null : spec.read(previous);
  const changePercent = round(percentChange(now, before), 1);

  // A rate built on two or three purchases moves on a single refund. Below the
  // floor the numbers are still reported — they are just not a signal.
  const enoughPurchases =
    !spec.purchaseBound ||
    Math.max(current.purchases ?? 0, previous?.purchases ?? 0) >= MIN_PURCHASES_FOR_HIGH_CONFIDENCE;

  const comparable = now !== null && before !== null;
  const direction: MoveDirection = comparable ? directionOf(spec, now, before) : "unknown";
  const material =
    comparable &&
    enoughPurchases &&
    direction !== "flat" &&
    direction !== "context" &&
    (changePercent !== null ? Math.abs(changePercent) >= MATERIAL_CHANGE_PCT : before === 0);

  const shownNow = formatValue(round(now, spec.digits), spec, currency);
  const suffix =
    changePercent === null
      ? ""
      : ` (%${nf(Math.abs(changePercent), 1)} ${changePercent >= 0 ? "artış" : "düşüş"})`;

  return {
    metric: spec.key,
    label: spec.label,
    previous: round(before, spec.digits),
    current: round(now, spec.digits),
    changePercent,
    direction,
    material,
    statement:
      previous === null
        ? `${spec.label} ${shownNow} (önceki dönemde veri yok)`
        : `${spec.label} ${formatValue(round(before, spec.digits), spec, currency)} → ${shownNow}${suffix}`,
  };
}

// ─── Named combinations ──────────────────────────────────────────

export interface DeteriorationPattern {
  key: "cost_and_return" | "traffic_and_cost";
  metrics: ReviewMetric[];
  /** Turkish. Describes what moved together — never why. */
  label: string;
}

const PATTERNS: DeteriorationPattern[] = [
  {
    key: "cost_and_return",
    metrics: ["costPerPurchase", "roas", "purchases"],
    label: "CPA arttı, ROAS düştü ve satın alma azaldı; maliyet ve getiri tarafı birlikte bozulmuş görünüyor.",
  },
  {
    key: "traffic_and_cost",
    metrics: ["ctr", "cpc", "purchases"],
    label: "CTR düştü, CPC arttı ve satın alma azaldı; tıklama tarafı ve maliyet birlikte bozulmuş görünüyor.",
  },
];

// ─── Current-period weakness, against the account's own numbers ──

export type WeaknessKind = "zero_conversion_spend" | "roas_below_account" | "cpa_above_account";

export interface Weakness {
  kind: WeaknessKind;
  /** Turkish sentence, built only from the figures in `facts`. */
  statement: string;
  facts: Record<string, number | null>;
}

// ─── Reading states ──────────────────────────────────────────────

export type ExclusionReason = "paused" | "inactive" | "no_delivery";

export type DataSufficiency = "sufficient" | "limited" | "insufficient";

export type Trend = "deteriorating" | "improving" | "mixed" | "flat" | "unknown";

export type DeteriorationStrength = "none" | "single" | "corroborated";

export interface ObjectReview {
  objectId: string;
  objectName: string;
  level: EntityLevel;
  status: string;
  campaignId: string | null;
  campaignName: string | null;
  adSetName: string | null;
  /** ACTIVE and actually delivering. Everything else is out of both lists. */
  active: boolean;
  excludedBecause: ExclusionReason | null;
  /** Turkish, stating why it is out of the comparison. Null when it is in. */
  exclusionStatement: string | null;
  /** Share of the level's spend in the period, 0–100. */
  spendShare: number;
  metrics: Record<string, number | null>;
  previousMetrics: Record<string, number | null> | null;
  /** Every metric with both values, in the fixed order of the specs above. */
  moves: MetricMove[];
  dataSufficiency: DataSufficiency;
  dataSufficiencyReason: string;
  trend: Trend;
  deteriorationSignals: MetricMove[];
  improvementSignals: MetricMove[];
  deteriorationStrength: DeteriorationStrength;
  deteriorationPatterns: DeteriorationPattern[];
  /**
   * Turkish. Hedged by construction when only one metric moved — the sentence
   * says the reading rests on a single signal rather than leaving the reader
   * to infer it.
   */
  deteriorationStatement: string | null;
  improvementStatement: string | null;
  weaknesses: Weakness[];
  /** Above the account's own ROAS by half again, on enough purchases to mean it. */
  strong: boolean;
  strongStatement: string | null;
  spendAtStake: number;
}

const LEVEL_NOUN: Record<Exclude<EntityLevel, "account">, string> = {
  campaign: "kampanya",
  adset: "reklam seti",
  ad: "reklam",
};

const STATUS_LABEL: Record<string, string> = {
  PAUSED: "duraklatılmış",
  ADSET_PAUSED: "bağlı olduğu reklam seti duraklatılmış",
  CAMPAIGN_PAUSED: "bağlı olduğu kampanya duraklatılmış",
  ARCHIVED: "arşivlenmiş",
  DELETED: "silinmiş",
  DISAPPROVED: "reddedilmiş",
  PENDING_REVIEW: "inceleme bekliyor",
  PENDING_BILLING_INFO: "ödeme bilgisi bekliyor",
  IN_PROCESS: "işleme alınmış",
  WITH_ISSUES: "sorunlu",
};

const PAUSED_STATUSES = new Set(["PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED"]);

function previousLine(metrics: MetricsDto): Record<string, number | null> {
  return {
    spend: round(metrics.spend, 2),
    purchases: metrics.purchases,
    purchaseValue: round(metrics.purchaseValue, 2),
    roas: round(metrics.roas, 2),
    costPerPurchase: round(metrics.costPerPurchase, 2),
    ctr: round(metrics.ctr, 2),
    cpc: round(metrics.cpc, 2),
    cpm: round(metrics.cpm, 2),
    impressions: metrics.impressions,
    clicks: metrics.clicks,
    conversionRate: round(conversionRatePercentOf(metrics), 2),
    averageOrderValue: round(averageOrderValueOf(metrics), 2),
  };
}

function sufficiencyOf(
  metrics: MetricsDto,
  spendShare: number,
  hasPrevious: boolean,
): { level: DataSufficiency; reason: string } {
  const spend = metrics.spend ?? 0;
  const purchases = metrics.purchases ?? 0;
  const tail = hasPrevious ? "" : " Önceki dönemde veri yok, karşılaştırma yapılamıyor.";

  if (spend === 0) {
    return { level: "insufficient", reason: `Bu dönemde harcama yok.${tail}` };
  }

  const thinSpend = spendShare < MATERIAL_SPEND_SHARE * 100;
  const thinPurchases = purchases < MIN_PURCHASES_FOR_HIGH_CONFIDENCE;
  const figures = `Dönem harcamasının %${nf(spendShare, 1)}'i, ${purchases} satın alma`;

  if (thinSpend && thinPurchases) {
    return {
      level: "insufficient",
      reason: `${figures}; bu hacimde oranlar güvenilir değil, performans yorumu yapılamıyor.${tail}`,
    };
  }
  if (thinSpend || thinPurchases) {
    return { level: "limited", reason: `${figures}; sinyaller sınırlı bir örnekleme dayanıyor.${tail}` };
  }
  return { level: "sufficient", reason: `${figures}.${tail}` };
}

/**
 * Both values and the direction for every signal, never a summary of them.
 *
 * A reader who disagrees with the reading can still check the numbers, which
 * is the whole reason the move keeps its own sentence instead of collapsing
 * into "performans düştü".
 */
function joinSignals(signals: MetricMove[]): string {
  return signals.map((signal) => signal.statement).join("; ");
}

interface Ctx {
  currency: string;
  level: Exclude<EntityLevel, "account">;
  totalSpend: number;
  accountRoas: number | null;
  accountCostPerPurchase: number | null;
}

function weaknessesOf(row: EntityRowDto, ctx: Ctx): Weakness[] {
  const m = row.metrics;
  const spend = m.spend ?? 0;
  const out: Weakness[] = [];

  if ((m.purchases ?? 0) === 0 && spend > 0) {
    const yardstick = ctx.accountCostPerPurchase;
    // Below one conversion's worth of spend, "no purchases yet" is arithmetic
    // rather than a verdict: it has not been given enough to buy one here.
    if (yardstick === null || spend >= yardstick) {
      out.push({
        kind: "zero_conversion_spend",
        statement:
          `${money(round(spend, 2), ctx.currency)} harcadı ve bu dönemde 0 satın alma üretti` +
          (yardstick === null
            ? "."
            : `; hesabın ortalama satın alma maliyeti ${money(round(yardstick, 2), ctx.currency)}.`),
        facts: {
          spend: round(spend, 2),
          purchases: 0,
          clicks: m.clicks,
          accountCostPerPurchase: round(yardstick, 2),
        },
      });
    }
  }

  if (m.roas !== null && ctx.accountRoas !== null && m.roas < ctx.accountRoas * LOW_ROAS_RATIO) {
    out.push({
      kind: "roas_below_account",
      statement: `ROAS ${nf(m.roas, 2)}x, hesap ortalaması ${nf(ctx.accountRoas, 2)}x.`,
      facts: {
        roas: round(m.roas, 2),
        accountRoas: round(ctx.accountRoas, 2),
        purchases: m.purchases,
        spend: round(spend, 2),
      },
    });
  }

  // A high cost per order is only a weakness when the order is not worth more
  // to match. An ad selling a basket twice the account's average SHOULD cost
  // more per purchase, and ROAS has already priced that in — so when the
  // return beats the account, the CPA reading is dropped rather than reported
  // as a second problem. Without revenue there is no ROAS to check it against,
  // and CPA is then the only yardstick there is.
  const paysForItself =
    m.roas !== null && ctx.accountRoas !== null && m.roas >= ctx.accountRoas;

  if (
    !paysForItself &&
    m.costPerPurchase !== null &&
    ctx.accountCostPerPurchase !== null &&
    m.costPerPurchase > ctx.accountCostPerPurchase * HIGH_CPA_RATIO
  ) {
    out.push({
      kind: "cpa_above_account",
      statement:
        `Satın alma maliyeti ${money(round(m.costPerPurchase, 2), ctx.currency)}, ` +
        `hesap ortalaması ${money(round(ctx.accountCostPerPurchase, 2), ctx.currency)}.`,
      facts: {
        costPerPurchase: round(m.costPerPurchase, 2),
        accountCostPerPurchase: round(ctx.accountCostPerPurchase, 2),
        purchases: m.purchases,
        spend: round(spend, 2),
      },
    });
  }

  return out;
}

function exclusionOf(
  row: EntityRowDto,
  status: string,
  ctx: Ctx,
): { reason: ExclusionReason | null; statement: string | null } {
  const spend = row.metrics.spend ?? 0;
  const noun = LEVEL_NOUN[ctx.level];
  const spent =
    spend > 0 ? ` Dönem içinde ${money(round(spend, 2), ctx.currency)} harcaması görünüyor.` : "";

  if (PAUSED_STATUSES.has(status)) {
    return {
      reason: "paused",
      statement:
        `Bu ${noun} ${STATUS_LABEL[status]} olduğu için mevcut dönemde aktif performans ` +
        `karşılaştırmasına dahil edilmedi.${spent}`,
    };
  }
  if (status !== "ACTIVE") {
    return {
      reason: "inactive",
      statement:
        `Bu ${noun} ${STATUS_LABEL[status] ?? `"${status}"`} durumunda olduğu için aktif performans ` +
        `karşılaştırmasına dahil edilmedi.${spent}`,
    };
  }
  if (spend === 0 && (row.metrics.impressions ?? 0) === 0) {
    return {
      reason: "no_delivery",
      statement:
        `Bu ${noun} aktif görünüyor ancak bu dönemde hiç gösterim almadı ve hiç harcamadı; ` +
        "aktif performans karşılaştırmasına dahil edilmedi.",
    };
  }
  return { reason: null, statement: null };
}

function reviewRow(row: EntityRowDto, previous: MetricsDto | null, ctx: Ctx): ObjectReview {
  const m = row.metrics;
  const spend = m.spend ?? 0;
  const status = (row.effectiveStatus ?? row.status ?? "UNKNOWN").toUpperCase();
  const spendShare = ctx.totalSpend > 0 ? (spend / ctx.totalSpend) * 100 : 0;
  const noun = LEVEL_NOUN[ctx.level];

  const exclusion = exclusionOf(row, status, ctx);

  const moves = METRIC_SPECS.map((spec) => moveOf(spec, m, previous, ctx.currency));
  const bySize = (a: MetricMove, b: MetricMove) =>
    Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0);
  const deteriorationSignals = moves
    .filter((move) => move.material && move.direction === "worse")
    .sort(bySize);
  const improvementSignals = moves
    .filter((move) => move.material && move.direction === "better")
    .sort(bySize);

  const strength: DeteriorationStrength =
    deteriorationSignals.length === 0
      ? "none"
      : deteriorationSignals.length === 1
        ? "single"
        : "corroborated";

  const signalMetrics = new Set(deteriorationSignals.map((signal) => signal.metric));
  const deteriorationPatterns = PATTERNS.filter((pattern) =>
    pattern.metrics.every((metric) => signalMetrics.has(metric)),
  );

  // Both forms name the strongest signal; only the hedge after it differs.
  // One metric moving is reported as one metric moving, in the sentence
  // itself, so the caution survives an answer that quotes nothing else.
  let deteriorationStatement: string | null = null;
  if (strength === "single") {
    const only = deteriorationSignals[0];
    deteriorationStatement =
      `${only.statement}. Mevcut veride bu ${noun} için en belirgin olumsuz sinyal ${only.label} tarafında; ` +
      "başka bir metrik aynı yönde hareket etmediği için okuma tek sinyale dayanıyor.";
  } else if (strength === "corroborated") {
    deteriorationStatement =
      `Önceki döneme göre ${deteriorationSignals.length} metrik olumsuz yönde hareket etti: ` +
      `${joinSignals(deteriorationSignals)}. Mevcut veride bu ${noun} için en belirgin olumsuz sinyal ` +
      `${deteriorationSignals[0].label} tarafında. Bu, tek metriğe dayanmayan bir bozulma sinyali oluşturuyor.` +
      (deteriorationPatterns.length > 0
        ? ` ${deteriorationPatterns.map((pattern) => pattern.label).join(" ")}`
        : "");
  }

  const trend: Trend =
    previous === null
      ? "unknown"
      : deteriorationSignals.length > 0 && improvementSignals.length > 0
        ? "mixed"
        : deteriorationSignals.length > 0
          ? "deteriorating"
          : improvementSignals.length > 0
            ? "improving"
            : "flat";

  const improvementStatement =
    trend === "improving"
      ? `Önceki döneme göre olumlu yönde hareket eden metrikler: ${joinSignals(improvementSignals)}. ` +
        "Mevcut dönemdeki performans düşük olsa bile bu, önceki döneme göre bir kötüleşme değil."
      : null;

  const sufficiency = sufficiencyOf(m, spendShare, previous !== null);
  const weaknesses = exclusion.reason === null ? weaknessesOf(row, ctx) : [];

  const strong =
    exclusion.reason === null &&
    m.roas !== null &&
    ctx.accountRoas !== null &&
    m.roas > ctx.accountRoas * HIGH_ROAS_RATIO &&
    (m.purchases ?? 0) >= MIN_PURCHASES_FOR_HIGH_CONFIDENCE;

  return {
    objectId: row.id,
    objectName: row.name,
    level: row.level,
    status,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    adSetName: row.adSetName,
    active: exclusion.reason === null,
    excludedBecause: exclusion.reason,
    exclusionStatement: exclusion.statement,
    spendShare: round(spendShare, 1) ?? 0,
    metrics: metricLineOf(row),
    previousMetrics: previous === null ? null : previousLine(previous),
    moves,
    dataSufficiency: sufficiency.level,
    dataSufficiencyReason: sufficiency.reason,
    trend,
    deteriorationSignals,
    improvementSignals,
    deteriorationStrength: strength,
    deteriorationPatterns,
    deteriorationStatement,
    improvementStatement,
    weaknesses,
    strong,
    strongStatement:
      strong && m.roas !== null && ctx.accountRoas !== null
        ? `"${row.name}" mevcut dönemde ${nf(m.roas, 2)} ROAS ile güçlü performans gösteriyor ` +
          `(hesap ortalaması ${nf(ctx.accountRoas, 2)}).`
        : null,
    spendAtStake: spend,
  };
}

// ─── The public entry point ──────────────────────────────────────

export interface ReviewInput {
  level: Exclude<EntityLevel, "account">;
  currency: string;
  /** Rows for the period under review. */
  rows: EntityRowDto[];
  /** The same objects in the previous equivalent period, by id. Empty is fine. */
  previousById: Map<string, MetricsDto>;
}

export interface ReviewResult {
  level: Exclude<EntityLevel, "account">;
  baselines: {
    totalSpend: number;
    totalPurchases: number;
    accountRoas: number | null;
    accountCostPerPurchase: number | null;
  };
  /** Every row, highest spend first. The lists below are views onto it. */
  reviews: ObjectReview[];
  /** Section A — worse than the previous period, whatever level it sits at. */
  deteriorating: ObjectReview[];
  /** Section B — weak in the current period, whichever way it is moving. */
  underperforming: ObjectReview[];
  /** Above the account's own ROAS. A measurement; no action is attached. */
  strong: ObjectReview[];
  /** Too little spend or too few purchases to judge. Not "kötü". */
  insufficientData: ObjectReview[];
  /** Paused, inactive or not delivering: out of both lists, with the reason. */
  excluded: ObjectReview[];
  /** Object ids present in BOTH section A and section B. */
  overlap: string[];
  counts: Record<string, number>;
  metricsMissingOnEveryRow: string[];
}

const METRIC_NAMES: Array<keyof MetricsDto> = [
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
 * Review one level of the account over two periods.
 *
 * Ordering inside every list is by spend in the period — money at stake, the
 * same key the decision engine ranks on, and a real number rather than a
 * composite score nobody can audit.
 */
export function reviewPerformance(input: ReviewInput): ReviewResult {
  const baselines = computeBaselines(input.rows);
  const ctx: Ctx = {
    currency: input.currency,
    level: input.level,
    totalSpend: baselines.totalSpend,
    accountRoas: baselines.accountRoas,
    accountCostPerPurchase: baselines.accountCostPerPurchase,
  };

  const reviews = input.rows
    .map((row) => reviewRow(row, input.previousById.get(row.id) ?? null, ctx))
    .sort((a, b) => b.spendAtStake - a.spendAtStake);

  // Only an object that is delivering AND carries enough volume to read can be
  // called good or bad. Everything else gets its own list and its own reason.
  const comparable = reviews.filter(
    (review) => review.active && review.dataSufficiency !== "insufficient",
  );
  const deteriorating = comparable.filter((review) => review.deteriorationSignals.length > 0);
  const underperforming = comparable.filter((review) => review.weaknesses.length > 0);
  const strong = comparable.filter((review) => review.strong);
  const insufficientData = reviews.filter(
    (review) => review.active && review.dataSufficiency === "insufficient",
  );
  const excluded = reviews.filter((review) => !review.active);

  const inSectionB = new Set(underperforming.map((review) => review.objectId));

  return {
    level: input.level,
    baselines: {
      totalSpend: round(baselines.totalSpend, 2) ?? 0,
      totalPurchases: baselines.totalPurchases,
      accountRoas: round(baselines.accountRoas, 2),
      accountCostPerPurchase: round(baselines.accountCostPerPurchase, 2),
    },
    reviews,
    deteriorating,
    underperforming,
    strong,
    insufficientData,
    excluded,
    overlap: deteriorating
      .filter((review) => inSectionB.has(review.objectId))
      .map((review) => review.objectId),
    counts: {
      reviewed: reviews.length,
      comparable: comparable.length,
      deteriorating: deteriorating.length,
      underperforming: underperforming.length,
      strong: strong.length,
      insufficientData: insufficientData.length,
      excluded: excluded.length,
      corroborated: deteriorating.filter((r) => r.deteriorationStrength === "corroborated").length,
      singleSignal: deteriorating.filter((r) => r.deteriorationStrength === "single").length,
    },
    metricsMissingOnEveryRow:
      input.rows.length === 0
        ? []
        : METRIC_NAMES.filter((key) => input.rows.every((row) => row.metrics[key] === null)),
  };
}

export { HIGH_CPA_RATIO, METRIC_SPECS, PATTERNS };
