import type { EntityLevel, EntityRowDto, MetricsDto } from "../dashboard/dto.js";

/**
 * The diagnosis engine: where a change came from, and which factor carries it.
 *
 * Pure, like the decision engine next to it — no I/O, no Meta client, no
 * cache. It answers two questions the existing tools could not, and refuses a
 * third that the data cannot support.
 *
 *  1. **Where.** A period-over-period comparison says purchases fell by 13.
 *     It does not say that nine of those came from one ad set. Attribution is
 *     arithmetic on the children's own deltas, so "the drop is concentrated in
 *     X" is a measurement rather than an impression.
 *
 *  2. **Which factor.** ROAS is an identity, not a mystery:
 *
 *         ROAS = (CTR × CVR × AOV × 1000) / CPM
 *
 *     so a change in ROAS decomposes exactly into changes in those four. In
 *     logs the identity is additive, which is what makes "CPM carried most of
 *     it" a computed share rather than a guess. Nothing here infers a cause
 *     outside the identity.
 *
 *  3. **Why not.** Meta's insights do not see a landing page, a competitor, a
 *     season or a checkout bug. The engine can say conversion rate fell while
 *     the click side held; it cannot say why, and it does not try. The same
 *     goes for budget changes: insights carry no history of what a budget used
 *     to be, so a budget change is reported only when the caller actually
 *     knows both values.
 *
 * Every rule from the decision engine applies unchanged: `null` is never zero,
 * thresholds come from the account's own numbers, and a signal that needs a
 * missing metric is not emitted at all.
 */

/** A factor in the ROAS identity. Frequency is observed separately. */
export type FactorKey = "cpm" | "ctr" | "cvr" | "aov";

export const FACTOR_LABEL: Record<FactorKey, string> = {
  cpm: "CPM (bin gösterim maliyeti)",
  ctr: "CTR (tıklama oranı)",
  cvr: "Dönüşüm oranı",
  aov: "Sepet tutarı",
};

/** How much a reading can be leaned on. */
export type Confidence = "low" | "medium" | "high";

/**
 * Below this many purchases in a period, a rate built on them is a small
 * sample. Shared with the decision engine's reasoning: three is where one
 * refund or one lucky order stops moving the ratio on its own.
 */
const MIN_PURCHASES_FOR_CONFIDENCE = 3;

/** Below this share of the scope's spend, a child cannot move the account. */
const MATERIAL_SPEND_SHARE = 0.05;

/** A factor has to move this much before it is called a mover. */
const MATERIAL_FACTOR_PCT = 10;

/** Impressions per person above which saturation is worth naming. */
const HIGH_FREQUENCY = 3;

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

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

/** Conversion rate: purchases per click. Null unless both sides are real. */
export function conversionRateOf(metrics: MetricsDto): number | null {
  return ratio(metrics.purchases, metrics.clicks);
}

/** Average order value. Null when Meta reported no revenue. */
export function averageOrderValueOf(metrics: MetricsDto): number | null {
  if (metrics.purchaseValue === null) return null;
  return ratio(metrics.purchaseValue, metrics.purchases);
}

/** Impressions per person, Meta's own definition. */
export function frequencyOf(metrics: MetricsDto): number | null {
  return ratio(metrics.impressions, metrics.reach);
}

// ─── Factor decomposition ────────────────────────────────────────

export interface FactorMove {
  factor: FactorKey;
  label: string;
  previous: number | null;
  current: number | null;
  changePercent: number | null;
  /**
   * Share of the ROAS move this factor accounts for, 0–100. Derived from the
   * log identity, so the shares of all four sum to 100 and none of it is
   * apportioned by judgement.
   */
  shareOfRoasMove: number | null;
  /** True when this factor pushed ROAS down. */
  hurt: boolean;
}

export interface FactorBreakdown {
  /** Null when the identity could not be evaluated — see `blockedBy`. */
  roasChangePercent: number | null;
  factors: FactorMove[];
  /**
   * Which metric was missing or zero on one of the two periods, when the
   * decomposition could not run. Stated rather than silently skipped: "we
   * cannot tell" is information.
   */
  blockedBy: string[];
}

function factorValues(metrics: MetricsDto): Record<FactorKey, number | null> {
  return {
    cpm: metrics.cpm,
    ctr: metrics.ctr,
    cvr: conversionRateOf(metrics),
    aov: averageOrderValueOf(metrics),
  };
}

/**
 * Split a ROAS change across the four factors that produce it.
 *
 * `ROAS = (CTR × CVR × AOV × 1000) / CPM` is an identity, so in logs
 * `ln(ROAS₁/ROAS₀)` is exactly the sum of the four factor log-ratios (CPM
 * entering with a minus). Shares are those terms normalised by their absolute
 * total, which is why they can be reported as "this factor carried N% of the
 * move" without anyone having decided it.
 */
export function decomposeRoas(current: MetricsDto, previous: MetricsDto): FactorBreakdown {
  const now = factorValues(current);
  const before = factorValues(previous);
  const blockedBy: string[] = [];

  for (const key of ["cpm", "ctr", "cvr", "aov"] as const) {
    const a = before[key];
    const b = now[key];
    if (a === null || b === null || a <= 0 || b <= 0) blockedBy.push(key);
  }

  const roasChangePercent = percentChange(current.roas, previous.roas);

  if (blockedBy.length > 0) {
    return {
      roasChangePercent,
      factors: (["cpm", "ctr", "cvr", "aov"] as const).map((factor) => ({
        factor,
        label: FACTOR_LABEL[factor],
        previous: round(before[factor], 4),
        current: round(now[factor], 4),
        changePercent: round(percentChange(now[factor], before[factor]), 1),
        shareOfRoasMove: null,
        hurt: false,
      })),
      blockedBy,
    };
  }

  // CPM sits in the denominator, so a rise in it is a fall in ROAS.
  const terms: Record<FactorKey, number> = {
    cpm: -Math.log((now.cpm as number) / (before.cpm as number)),
    ctr: Math.log((now.ctr as number) / (before.ctr as number)),
    cvr: Math.log((now.cvr as number) / (before.cvr as number)),
    aov: Math.log((now.aov as number) / (before.aov as number)),
  };
  const total = Object.values(terms).reduce((sum, term) => sum + Math.abs(term), 0);

  const factors: FactorMove[] = (["cpm", "ctr", "cvr", "aov"] as const).map((factor) => ({
    factor,
    label: FACTOR_LABEL[factor],
    previous: round(before[factor], 4),
    current: round(now[factor], 4),
    changePercent: round(percentChange(now[factor], before[factor]), 1),
    shareOfRoasMove: total > 0 ? round((Math.abs(terms[factor]) / total) * 100, 1) : null,
    hurt: terms[factor] < 0,
  }));

  // Biggest mover first; the answer quotes the top of this list.
  factors.sort((a, b) => (b.shareOfRoasMove ?? 0) - (a.shareOfRoasMove ?? 0));

  return { roasChangePercent: round(roasChangePercent, 1), factors, blockedBy: [] };
}

// ─── Attribution across children ─────────────────────────────────

export interface ChildPeriods {
  /** The current-period row: carries the name, the ids, the budget and status. */
  row: EntityRowDto;
  /** The same object last period, or null when it did not exist / returned nothing. */
  previous: MetricsDto | null;
}

export interface Contribution {
  objectId: string;
  objectName: string;
  level: EntityLevel;
  status: string;
  /** Share of the scope's current spend, 0–100. */
  spendShare: number;
  deltaSpend: number;
  deltaPurchases: number | null;
  deltaPurchaseValue: number | null;
  /**
   * Share of the scope's total purchase change this object accounts for,
   * 0–100. Only meaningful when the scope actually moved; null otherwise.
   */
  shareOfPurchaseChange: number | null;
  shareOfValueChange: number | null;
  /** Whether this object moved the same way the scope did. */
  movedWithScope: boolean;
  confidence: Confidence;
  /** Why the confidence is what it is, in Turkish. */
  confidenceReason: string;
  frequency: number | null;
  dailyBudget: number | null;
  /**
   * Spend per day against the daily budget, 0–100, when a daily budget exists.
   * A value near 100 means delivery was budget-capped; a low one means it was
   * not, which is a different problem.
   */
  budgetUtilisation: number | null;
}

function confidenceOf(
  row: EntityRowDto,
  previous: MetricsDto | null,
  spendShare: number,
): { confidence: Confidence; reason: string } {
  if (previous === null) {
    return { confidence: "low", reason: "Önceki dönemde veri yok, karşılaştırma yapılamıyor." };
  }
  if (spendShare < MATERIAL_SPEND_SHARE * 100) {
    return {
      confidence: "low",
      reason: `Dönem harcamasının yalnızca %${round(spendShare, 1)}'i; tek başına toplamı taşıyamaz.`,
    };
  }
  const purchases = (row.metrics.purchases ?? 0) + (previous.purchases ?? 0);
  if (purchases < MIN_PURCHASES_FOR_CONFIDENCE) {
    return {
      confidence: "low",
      reason: `İki dönemde toplam ${purchases} satın alma; oranlar bu örneklemde güvenilir değil.`,
    };
  }
  if (spendShare < MATERIAL_SPEND_SHARE * 200 || purchases < MIN_PURCHASES_FOR_CONFIDENCE * 3) {
    return {
      confidence: "medium",
      reason: `Harcama payı %${round(spendShare, 1)}, iki dönemde ${purchases} satın alma.`,
    };
  }
  return {
    confidence: "high",
    reason: `Harcama payı %${round(spendShare, 1)}, iki dönemde ${purchases} satın alma.`,
  };
}

function attribute(
  children: ChildPeriods[],
  totalCurrentSpend: number,
  scopeDeltaPurchases: number | null,
  scopeDeltaValue: number | null,
  days: number,
): Contribution[] {
  return children.map(({ row, previous }) => {
    const spendShare = totalCurrentSpend > 0 ? ((row.metrics.spend ?? 0) / totalCurrentSpend) * 100 : 0;
    const deltaPurchases =
      previous === null ? null : (row.metrics.purchases ?? 0) - (previous.purchases ?? 0);
    const deltaValue =
      previous === null || row.metrics.purchaseValue === null || previous.purchaseValue === null
        ? null
        : row.metrics.purchaseValue - previous.purchaseValue;
    const { confidence, reason } = confidenceOf(row, previous, spendShare);

    return {
      objectId: row.id,
      objectName: row.name,
      level: row.level,
      status: row.effectiveStatus ?? row.status ?? "UNKNOWN",
      spendShare: round(spendShare, 1) ?? 0,
      deltaSpend: round((row.metrics.spend ?? 0) - (previous?.spend ?? 0), 2) ?? 0,
      deltaPurchases,
      deltaPurchaseValue: round(deltaValue, 2),
      shareOfPurchaseChange:
        scopeDeltaPurchases === null || scopeDeltaPurchases === 0 || deltaPurchases === null
          ? null
          : round((deltaPurchases / scopeDeltaPurchases) * 100, 1),
      shareOfValueChange:
        scopeDeltaValue === null || scopeDeltaValue === 0 || deltaValue === null
          ? null
          : round((deltaValue / scopeDeltaValue) * 100, 1),
      movedWithScope:
        scopeDeltaPurchases !== null &&
        deltaPurchases !== null &&
        scopeDeltaPurchases !== 0 &&
        Math.sign(deltaPurchases) === Math.sign(scopeDeltaPurchases),
      confidence,
      confidenceReason: reason,
      frequency: round(frequencyOf(row.metrics), 2),
      dailyBudget: row.dailyBudget,
      budgetUtilisation:
        row.dailyBudget !== null && row.dailyBudget > 0 && days > 0
          ? round((((row.metrics.spend ?? 0) / days) / row.dailyBudget) * 100, 1)
          : null,
    };
  });
}

// ─── Observed signals that sit outside the ROAS identity ─────────

export type SignalKind =
  | "frequency_rising"
  | "budget_capped"
  | "under_delivering"
  | "spend_shifted"
  | "no_delivery";

export interface Signal {
  kind: SignalKind;
  objectId: string | null;
  objectName: string | null;
  /** Turkish, built only from the numbers in `facts`. */
  statement: string;
  facts: Record<string, number | null>;
  confidence: Confidence;
}

function observedSignals(
  scopeCurrent: MetricsDto,
  scopePrevious: MetricsDto,
  contributions: Contribution[],
  children: ChildPeriods[],
): Signal[] {
  const signals: Signal[] = [];

  const frequencyNow = frequencyOf(scopeCurrent);
  const frequencyBefore = frequencyOf(scopePrevious);
  const frequencyChange = percentChange(frequencyNow, frequencyBefore);
  if (
    frequencyNow !== null &&
    frequencyNow >= HIGH_FREQUENCY &&
    frequencyChange !== null &&
    frequencyChange >= MATERIAL_FACTOR_PCT
  ) {
    signals.push({
      kind: "frequency_rising",
      objectId: null,
      objectName: null,
      statement: `Frekans ${round(frequencyBefore, 2)} → ${round(frequencyNow, 2)} (%${round(frequencyChange, 1)} artış); aynı kişiler daha sık görüyor.`,
      facts: {
        previous: round(frequencyBefore, 2),
        current: round(frequencyNow, 2),
        changePercent: round(frequencyChange, 1),
      },
      confidence: "medium",
    });
  }

  for (const contribution of contributions) {
    if (contribution.spendShare < MATERIAL_SPEND_SHARE * 100) continue;

    if (contribution.budgetUtilisation !== null && contribution.budgetUtilisation >= 95) {
      signals.push({
        kind: "budget_capped",
        objectId: contribution.objectId,
        objectName: contribution.objectName,
        statement: `"${contribution.objectName}" günlük bütçesinin %${contribution.budgetUtilisation}'ini harcadı; teslimat bütçeyle sınırlı.`,
        facts: { utilisation: contribution.budgetUtilisation, dailyBudget: contribution.dailyBudget },
        confidence: contribution.confidence,
      });
    } else if (contribution.budgetUtilisation !== null && contribution.budgetUtilisation <= 60) {
      signals.push({
        kind: "under_delivering",
        objectId: contribution.objectId,
        objectName: contribution.objectName,
        statement: `"${contribution.objectName}" günlük bütçesinin yalnızca %${contribution.budgetUtilisation}'ini harcayabildi; teslimat bütçeyle değil başka bir şeyle sınırlı.`,
        facts: { utilisation: contribution.budgetUtilisation, dailyBudget: contribution.dailyBudget },
        confidence: contribution.confidence,
      });
    }

    // Spend moved into something that did not convert more for it.
    if (
      contribution.deltaSpend > 0 &&
      contribution.deltaPurchases !== null &&
      contribution.deltaPurchases <= 0
    ) {
      signals.push({
        kind: "spend_shifted",
        objectId: contribution.objectId,
        objectName: contribution.objectName,
        statement: `"${contribution.objectName}" harcaması arttı (${contribution.deltaSpend > 0 ? "+" : ""}${contribution.deltaSpend}) ama satın alma ${contribution.deltaPurchases === 0 ? "değişmedi" : `${contribution.deltaPurchases} azaldı`}.`,
        facts: { deltaSpend: contribution.deltaSpend, deltaPurchases: contribution.deltaPurchases },
        confidence: contribution.confidence,
      });
    }
  }

  const silent = children.filter(
    ({ row }) => (row.metrics.spend ?? 0) === 0 && (row.metrics.impressions ?? 0) === 0,
  );
  if (silent.length > 0) {
    signals.push({
      kind: "no_delivery",
      objectId: null,
      objectName: null,
      statement: `${silent.length} nesne bu dönemde hiç gösterim almadı ve hiç harcamadı.`,
      facts: { count: silent.length },
      confidence: "high",
    });
  }

  return signals;
}

// ─── The public entry point ──────────────────────────────────────

export interface DiagnosisInput {
  currency: string;
  scope: { level: EntityLevel; id: string | null; name: string };
  current: MetricsDto;
  previous: MetricsDto;
  /** Days in the period, used for budget utilisation. */
  days: number;
  childLevel: Exclude<EntityLevel, "account">;
  children: ChildPeriods[];
}

export interface DiagnosisResult {
  scope: DiagnosisInput["scope"];
  headline: Record<string, number | null>;
  factors: FactorBreakdown;
  childLevel: Exclude<EntityLevel, "account">;
  /** Children ordered by how much of the scope's change they carry. */
  contributions: Contribution[];
  signals: Signal[];
  /** Metrics neither period reported, so nothing is ranked on an empty column. */
  missingMetrics: string[];
  /** Overall confidence in the attribution, from the data behind it. */
  confidence: Confidence;
  confidenceReason: string;
}

const HEADLINE_KEYS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "purchases",
  "purchaseValue",
  "costPerPurchase",
  "roas",
] as const;

export function diagnose(input: DiagnosisInput): DiagnosisResult {
  const { current, previous } = input;

  const headline: Record<string, number | null> = {};
  for (const key of HEADLINE_KEYS) {
    headline[key] = round(current[key], 2);
    headline[`${key}Previous`] = round(previous[key], 2);
    headline[`${key}ChangePercent`] = round(percentChange(current[key], previous[key]), 1);
  }
  headline.frequency = round(frequencyOf(current), 2);
  headline.frequencyPrevious = round(frequencyOf(previous), 2);
  headline.conversionRate = round(conversionRateOf(current), 4);
  headline.conversionRatePrevious = round(conversionRateOf(previous), 4);

  const totalCurrentSpend = current.spend ?? 0;
  const scopeDeltaPurchases =
    current.purchases === null || previous.purchases === null
      ? null
      : current.purchases - previous.purchases;
  const scopeDeltaValue =
    current.purchaseValue === null || previous.purchaseValue === null
      ? null
      : current.purchaseValue - previous.purchaseValue;

  const contributions = attribute(
    input.children,
    totalCurrentSpend,
    scopeDeltaPurchases,
    scopeDeltaValue,
    input.days,
  );

  // Ordered by how much of the scope's move each one explains, falling back to
  // spend when the scope did not move enough for shares to mean anything.
  contributions.sort((a, b) => {
    const aShare = Math.abs(a.shareOfPurchaseChange ?? 0);
    const bShare = Math.abs(b.shareOfPurchaseChange ?? 0);
    if (aShare !== bShare) return bShare - aShare;
    return b.spendShare - a.spendShare;
  });

  const missingMetrics = HEADLINE_KEYS.filter(
    (key) => current[key] === null && previous[key] === null,
  );

  const material = contributions.filter((c) => c.confidence !== "low");
  const confidence: Confidence =
    material.length === 0
      ? "low"
      : material.some((c) => c.confidence === "high")
        ? "high"
        : "medium";
  const confidenceReason =
    material.length === 0
      ? "Hiçbir alt nesne, toplamı taşıyacak kadar harcama veya satın alma üretmedi; dağılım yorumlanamaz."
      : `${material.length} alt nesne anlamlı hacme sahip; dağılım bunlara dayanıyor.`;

  return {
    scope: input.scope,
    headline,
    factors: decomposeRoas(current, previous),
    childLevel: input.childLevel,
    contributions,
    signals: observedSignals(current, previous, contributions, input.children),
    missingMetrics,
    confidence,
    confidenceReason,
  };
}

export {
  MIN_PURCHASES_FOR_CONFIDENCE,
  MATERIAL_SPEND_SHARE,
  MATERIAL_FACTOR_PCT,
  HIGH_FREQUENCY,
};
