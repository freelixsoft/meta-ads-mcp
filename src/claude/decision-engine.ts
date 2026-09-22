import type { EntityLevel, EntityRowDto, MetricsDto } from "../dashboard/dto.js";

/**
 * The optimization decision engine.
 *
 * Pure functions over rows the services already fetched: no I/O, no Meta
 * client, no cache. That is the whole point of it being here rather than in
 * the prompt. A model asked to eyeball forty rows and pick the three worst
 * will, sooner or later, compare a null against a number, call a rate a
 * currency, or quietly average something it should not. Every finding this
 * module emits carries the exact figures it was derived from, so the model's
 * job is reduced to translating a decision that was already made from real
 * numbers into Turkish.
 *
 * Three rules govern everything below:
 *
 *  1. **`null` is never zero.** Meta returns `null` for a metric it has no
 *     value for — most often ROAS and purchase value on an account without
 *     conversion tracking. Every comparison guards for it, and a signal that
 *     needs a missing metric is simply not emitted.
 *  2. **Thresholds are derived from the account's own numbers**, not from
 *     constants someone picked. "Low ROAS" means low against what the rest of
 *     this account achieves in the same period; "high spend, no purchases"
 *     means it has spent more than one conversion costs here. An account with
 *     a 1.2 ROAS and an account with a 12 ROAS both get useful answers, and no
 *     figure in a recommendation is one this module invented.
 *  3. **Ranking is by money at stake**, never by a composite score. A score
 *     would be an opinion dressed as arithmetic, and it cannot be explained to
 *     the person whose budget it moves. Spend in the period can be.
 */

/** What the engine can conclude about one object. */
export type FindingKind =
  | "zero_conversion_spend"
  | "low_roas"
  | "high_roas_underfunded"
  | "cpa_rising"
  | "ctr_falling"
  | "cpc_rising"
  | "cpm_rising"
  | "improving"
  | "active_no_delivery"
  | "paused_not_spending";

/**
 * Where this object's budget actually lives. Under Campaign Budget
 * Optimization an ad set has no budget of its own, so a recommendation to
 * change "its" budget is meaningless — the engine says so rather than letting
 * the model discover it at write time.
 */
export type BudgetOwner = "campaign" | "adset" | "unknown";

/** The operation a finding is asking a human to approve. */
export type ActionType =
  | "PAUSE_AD"
  | "PAUSE_ADSET"
  | "PAUSE_CAMPAIGN"
  | "CHANGE_ADSET_BUDGET"
  | "CHANGE_CAMPAIGN_BUDGET"
  /** Something to look at. No write exists for it, by design. */
  | "INVESTIGATE";

const PAUSE_BY_LEVEL: Record<Exclude<EntityLevel, "account">, ActionType> = {
  campaign: "PAUSE_CAMPAIGN",
  adset: "PAUSE_ADSET",
  ad: "PAUSE_AD",
};

/** One finding, in the shape the confirmation-style answer is built from. */
export interface Finding {
  kind: FindingKind;
  level: EntityLevel;
  objectId: string;
  objectName: string;
  /** Parent chain, so an ad can be named with the campaign it sits under. */
  campaignId: string | null;
  campaignName: string | null;
  adSetName: string | null;
  status: string;
  budgetOwner: BudgetOwner;
  /**
   * The object's full metric line for the period, so the answer can quote any
   * of it without a second read: spend, purchases, purchaseValue, ROAS, CPA,
   * CTR, CPC, CPM, frequency where reach allows it, and the budget where the
   * object owns one. Nulls stay null.
   */
  metrics: Record<string, number | null>;
  /** Every number behind this finding, already rounded for display. */
  facts: Record<string, number | null>;
  /** The Turkish sentence stating the evidence. Built only from `facts`. */
  evidence: string;
  /** The suggested action, its purpose, and what could go wrong. */
  action: string;
  goal: string;
  risk: string;
  /**
   * The operation a reviewer is being asked to approve, as an enum rather than
   * prose, so a UI can group and colour recommendations without parsing
   * Turkish. `INVESTIGATE` is the honest answer when the finding is something
   * to look at rather than something to change.
   */
  actionType: ActionType;
  /**
   * How much the data behind this supports acting on it. Derived, not felt:
   * `high` needs both a material share of the period's spend and — where the
   * signal is a trend — two periods that both carried a real number. Nothing
   * here is a score to rank by; the ordering is still money at stake.
   */
  confidence: "low" | "medium" | "high";
  /** The write tool that would carry it out, or null when none applies. */
  writeTool: "meta_update_campaign" | "meta_update_ad_set" | "meta_update_ad" | null;
  /** Spend at stake in the period. The ordering key — a real number, not a score. */
  spendAtStake: number;
  /** Why this is on the shortlist, stated in Turkish and in money. */
  priorityBasis: string;
}

/**
 * A change this size is treated as a real move rather than noise.
 *
 * One constant, used for every trend signal, so "rising" means the same thing
 * for CPA as for CPM and a reader only has to learn it once. Twenty percent is
 * a judgement call and the only one in this file; it is set where a week-over-
 * week swing stops being ordinary variance on the kind of budgets this
 * dashboard is used for. Everything else is derived from the account.
 */
const MATERIAL_CHANGE_PCT = 20;

/**
 * Below this share of the period's spend an object is not worth a
 * recommendation of its own, however bad its rates look: acting on it cannot
 * move the account, and it crowds out something that can.
 */
const MATERIAL_SPEND_SHARE = 0.05;

/** Relative to the account, this is "much worse" and "much better". */
const LOW_ROAS_RATIO = 0.5;
const HIGH_ROAS_RATIO = 1.5;

/**
 * At or above this share of the period spend, an object already IS the budget.
 * "Put more money here" stops being a reallocation and becomes an increase, so
 * the engine does not propose it.
 */
const DOMINANT_SPEND_SHARE = 0.5;

/**
 * Below this many purchases a high ROAS is a small sample, not a result. Three
 * is where a single refund or a single lucky order stops being able to move
 * the ratio on its own; the engine will still surface the finding, it just
 * will not call it high confidence.
 */
const MIN_PURCHASES_FOR_HIGH_CONFIDENCE = 3;

export interface EngineInput {
  level: Exclude<EntityLevel, "account">;
  currency: string;
  /** Rows for the period under analysis. */
  rows: EntityRowDto[];
  /** The same objects in the previous equivalent period, by id. Empty is fine. */
  previousById: Map<string, MetricsDto>;
  /**
   * Campaign id → whether that campaign holds the budget itself (CBO). Used to
   * decide whether an ad-set budget recommendation is even expressible.
   */
  cboCampaignIds: ReadonlySet<string>;
}

function round(value: number | null, digits: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function money(value: number, currency: string): string {
  return `${new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} ${currency}`;
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** Meta reports frequency as impressions per person; both inputs are on the row. */
export function frequencyOf(metrics: MetricsDto): number | null {
  if (metrics.reach === null || metrics.impressions === null || metrics.reach === 0) return null;
  return metrics.impressions / metrics.reach;
}

/**
 * The account's own baselines for the period, computed from the rows rather
 * than read separately, so a baseline can never describe a different window
 * than the rows it judges.
 */
export interface Baselines {
  totalSpend: number;
  totalPurchases: number;
  /** null when no row reported revenue — the account has no usable ROAS. */
  accountRoas: number | null;
  /** null when nothing converted; there is then no "one conversion costs this". */
  accountCostPerPurchase: number | null;
}

export function computeBaselines(rows: EntityRowDto[]): Baselines {
  let totalSpend = 0;
  let totalPurchases = 0;
  let totalValue: number | null = null;

  for (const row of rows) {
    totalSpend += row.metrics.spend ?? 0;
    totalPurchases += row.metrics.purchases ?? 0;
    if (row.metrics.purchaseValue !== null) {
      totalValue = (totalValue ?? 0) + row.metrics.purchaseValue;
    }
  }

  return {
    totalSpend,
    totalPurchases,
    accountRoas: totalValue !== null && totalSpend > 0 ? totalValue / totalSpend : null,
    accountCostPerPurchase: totalPurchases > 0 ? totalSpend / totalPurchases : null,
  };
}

const LEVEL_NOUN: Record<Exclude<EntityLevel, "account">, string> = {
  campaign: "kampanyası",
  adset: "reklam seti",
  ad: "reklamı",
};

const WRITE_TOOL: Record<Exclude<EntityLevel, "account">, Finding["writeTool"]> = {
  campaign: "meta_update_campaign",
  adset: "meta_update_ad_set",
  ad: "meta_update_ad",
};

function budgetOwnerOf(row: EntityRowDto, cboCampaignIds: ReadonlySet<string>): BudgetOwner {
  if (row.level === "campaign") return "campaign";
  if (row.dailyBudget !== null || row.lifetimeBudget !== null) return "adset";
  if (row.campaignId && cboCampaignIds.has(row.campaignId)) return "campaign";
  return "unknown";
}

/**
 * Is spending more on this object something we can even propose?
 *
 * Under CBO the answer is no at ad-set level: the money is on the campaign and
 * shared with every sibling, so "increase this ad set's budget" is not a
 * change that exists. The engine states that in the recommendation instead of
 * producing one the write layer would refuse.
 */
function budgetActionFor(row: EntityRowDto, owner: BudgetOwner, currency: string): {
  action: string;
  writeTool: Finding["writeTool"];
} {
  if (row.level === "campaign") {
    const current =
      row.dailyBudget !== null
        ? ` (şu an ${money(row.dailyBudget, currency)} günlük)`
        : row.lifetimeBudget !== null
          ? ` (şu an ${money(row.lifetimeBudget, currency)} toplam)`
          : "";
    return {
      action: `Kampanya bütçesini kademeli olarak artırmayı değerlendirin${current}.`,
      writeTool: "meta_update_campaign",
    };
  }
  if (owner === "campaign") {
    return {
      action:
        "Bu reklam setinin kendi bütçesi yok — bağlı olduğu kampanya bütçeyi kampanya seviyesinde " +
        "tutuyor (CBO). Bütçe artışı ancak kampanya bütçesi olarak yapılabilir ve kampanyadaki tüm " +
        "reklam setlerini etkiler; kullanıcıya bunu sorun.",
      writeTool: null,
    };
  }
  if (owner === "adset" && row.dailyBudget !== null) {
    return {
      action: `Reklam seti günlük bütçesini kademeli artırmayı değerlendirin (şu an ${money(row.dailyBudget, currency)}).`,
      writeTool: "meta_update_ad_set",
    };
  }
  return {
    action:
      "Bütçenin hangi seviyede tutulduğu bu veriden anlaşılmıyor; artırmadan önce kullanıcıya sorun.",
    writeTool: null,
  };
}

interface Ctx {
  currency: string;
  baselines: Baselines;
  cboCampaignIds: ReadonlySet<string>;
}

/** The requirement's metric line for one object, nulls preserved. */
export function metricLineOf(row: EntityRowDto): Record<string, number | null> {
  const m = row.metrics;
  return {
    spend: round(m.spend, 2),
    purchases: m.purchases,
    purchaseValue: round(m.purchaseValue, 2),
    roas: round(m.roas, 2),
    costPerPurchase: round(m.costPerPurchase, 2),
    ctr: round(m.ctr, 2),
    cpc: round(m.cpc, 2),
    cpm: round(m.cpm, 2),
    impressions: m.impressions,
    clicks: m.clicks,
    frequency: round(frequencyOf(m), 2),
    dailyBudget: row.dailyBudget,
    lifetimeBudget: row.lifetimeBudget,
  };
}

function actionTypeFor(
  kind: FindingKind,
  level: Exclude<EntityLevel, "account">,
  owner: BudgetOwner,
): ActionType {
  if (kind === "zero_conversion_spend" || kind === "low_roas") return PAUSE_BY_LEVEL[level];
  if (kind === "high_roas_underfunded") {
    if (owner === "campaign") return "CHANGE_CAMPAIGN_BUDGET";
    if (owner === "adset") return "CHANGE_ADSET_BUDGET";
    return "INVESTIGATE";
  }
  return "INVESTIGATE";
}

/**
 * How well the data supports acting, from the data alone.
 *
 * The share of the period's spend does most of the work: a finding on 2% of
 * the budget is a weaker basis for a decision than the same finding on 40% of
 * it, whatever the rates say. The one override is the small-sample trap — a
 * spectacular ROAS off two or three purchases is noise wearing a suit, and
 * calling that "high" is how a dashboard talks someone into scaling a fluke.
 */
function confidenceFor(kind: FindingKind, row: EntityRowDto, ctx: Ctx): Finding["confidence"] {
  const spend = row.metrics.spend ?? 0;
  const share = ctx.baselines.totalSpend > 0 ? spend / ctx.baselines.totalSpend : 0;

  let level: Finding["confidence"] =
    share >= MATERIAL_SPEND_SHARE * 2 ? "high" : share >= MATERIAL_SPEND_SHARE ? "medium" : "low";

  const purchases = row.metrics.purchases ?? 0;
  if (kind === "high_roas_underfunded" && purchases < MIN_PURCHASES_FOR_HIGH_CONFIDENCE) {
    level = level === "high" ? "medium" : "low";
  }
  return level;
}

function baseFinding(
  row: EntityRowDto,
  kind: FindingKind,
  ctx: Ctx,
): Omit<Finding, "evidence" | "action" | "goal" | "risk" | "writeTool" | "priorityBasis" | "facts"> {
  const owner = budgetOwnerOf(row, ctx.cboCampaignIds);
  return {
    actionType: actionTypeFor(kind, row.level as Exclude<EntityLevel, "account">, owner),
    confidence: confidenceFor(kind, row, ctx),
    metrics: metricLineOf(row),
    kind,
    level: row.level,
    objectId: row.id,
    objectName: row.name,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    adSetName: row.adSetName,
    status: row.effectiveStatus ?? row.status ?? "UNKNOWN",
    budgetOwner: budgetOwnerOf(row, ctx.cboCampaignIds),
    spendAtStake: row.metrics.spend ?? 0,
  };
}

function noun(level: Exclude<EntityLevel, "account">): string {
  return LEVEL_NOUN[level];
}

/** Every signal for one row, in the order they are checked. */
function findingsForRow(
  row: EntityRowDto,
  previous: MetricsDto | undefined,
  ctx: Ctx,
  level: Exclude<EntityLevel, "account">,
): Finding[] {
  const out: Finding[] = [];
  const m = row.metrics;
  const spend = m.spend ?? 0;
  const status = (row.effectiveStatus ?? row.status ?? "").toUpperCase();
  const label = `"${row.name}" ${noun(level)}`;
  const materialSpend = ctx.baselines.totalSpend * MATERIAL_SPEND_SHARE;

  // ── Structural states, checked first: they explain the numbers, and a
  // recommendation about spend would be wrong for both.
  if (status === "PAUSED" && spend === 0) {
    out.push({
      ...baseFinding(row, "paused_not_spending", ctx),
      facts: { spend: 0, impressions: m.impressions },
      evidence: `${label} duraklatılmış durumda ve bu dönemde hiç harcama yapmadı.`,
      action: "Şimdilik bir işlem gerekmiyor; yeniden açılacaksa ayrı olarak değerlendirin.",
      goal: "Harcamayan bir yapının performans listelerini kirletmesini önlemek.",
      risk: "Yok — bu bir gözlem, bir öneri değil.",
      writeTool: null,
      priorityBasis: "Harcama yok; bilgi amaçlı.",
    });
    return out;
  }

  if (status === "ACTIVE" && spend === 0 && (m.impressions ?? 0) === 0) {
    out.push({
      ...baseFinding(row, "active_no_delivery", ctx),
      facts: { spend: 0, impressions: 0 },
      evidence: `${label} aktif görünüyor ama bu dönemde hiç gösterim almadı ve hiç harcama yapmadı.`,
      action:
        "Teslimatı engelleyen bir durum olup olmadığını kontrol edin (onay bekleyen kreatif, " +
        "bitmiş tarih aralığı, tükenen bütçe, çok dar hedefleme).",
      goal: "Aktif sanılan ama aslında yayında olmayan bir yapıyı ortaya çıkarmak.",
      risk: "Yapı kasıtlı olarak bekletiliyor olabilir.",
      writeTool: null,
      priorityBasis: "Harcama yok, ancak aktif sanılıyor.",
    });
    return out;
  }

  // ── Money signals. Each one needs real spend behind it to be worth acting on.
  const worthActingOn = spend > 0 && spend >= materialSpend;

  if (worthActingOn && m.purchases === 0) {
    // "More than one conversion's worth, and nothing to show for it" — the
    // account's own cost per purchase is the yardstick. Without one (nothing
    // converted anywhere) the spend share alone carries it.
    const yardstick = ctx.baselines.accountCostPerPurchase;
    if (yardstick === null || spend >= yardstick) {
      out.push({
        ...baseFinding(row, "zero_conversion_spend", ctx),
        facts: {
          spend: round(spend, 2),
          purchases: 0,
          clicks: m.clicks,
          addToCart: m.addToCart,
          accountCostPerPurchase: round(yardstick, 2),
        },
        evidence:
          `${label} bu dönemde ${money(spend, ctx.currency)} harcadı ve 0 satın alma üretti` +
          (yardstick !== null
            ? `; hesabın ortalama satın alma maliyeti ${money(yardstick, ctx.currency)}.`
            : "."),
        action: `${label === "" ? "Bu yapıyı" : label} durdurmayı değerlendirin.`,
        goal: "Dönüşüm üretmeyen harcamayı kesip bütçeyi dönüşüm üreten yapılara bırakmak.",
        risk:
          "Kreatif geç dönüşüm üretiyor olabilir veya dönüşüm takibi (pixel/CAPI) eksik olabilir; " +
          "durdurmadan önce dönüşüm ölçümünün çalıştığını doğrulayın.",
        writeTool: WRITE_TOOL[level],
        priorityBasis: `${money(spend, ctx.currency)} harcama karşılığı sıfır satın alma.`,
      });
    }
  }

  if (worthActingOn && m.purchases !== null && m.purchases > 0 && m.roas !== null) {
    const accountRoas = ctx.baselines.accountRoas;
    if (accountRoas !== null && m.roas < accountRoas * LOW_ROAS_RATIO) {
      out.push({
        ...baseFinding(row, "low_roas", ctx),
        facts: {
          spend: round(spend, 2),
          roas: round(m.roas, 2),
          accountRoas: round(accountRoas, 2),
          purchases: m.purchases,
          costPerPurchase: round(m.costPerPurchase, 2),
        },
        evidence:
          `${label} ${money(spend, ctx.currency)} harcayıp ${m.purchases} satın alma getirdi; ` +
          `ROAS ${round(m.roas, 2)}x, hesap ortalaması ${round(accountRoas, 2)}x.`,
        action: "Bütçesini kısmayı ya da kreatif/hedeflemesini yenilemeyi değerlendirin.",
        goal: "Hesap ortalamasının belirgin altında getiri sağlayan harcamayı azaltmak.",
        risk:
          "Bu yapı huninin üst kısmını besliyor olabilir; kapatmak daha iyi performanslı " +
          "yapıların hacmini de düşürebilir.",
        writeTool: WRITE_TOOL[level],
        priorityBasis: `${money(spend, ctx.currency)} harcama, hesap ortalamasının altında ROAS.`,
      });
    }

    // (the "spend more here" signal is checked outside this block — see below)
  }

  // ── Low spend, high return.
  //
  // Deliberately NOT behind `worthActingOn`: this signal is *about* an object
  // that is not spending much, so gating it on material spend would make it
  // unreachable by construction. Its own floor is the account's cost per
  // purchase — it has to have spent at least what one conversion costs here,
  // so a single lucky sale on pocket change cannot be promoted into a budget
  // recommendation. That floor is the account's own number, not a constant.
  if (spend > 0 && m.purchases !== null && m.purchases > 0 && m.roas !== null) {
    const accountRoas = ctx.baselines.accountRoas;
    const floor = ctx.baselines.accountCostPerPurchase;
    const provenEnough = floor === null ? false : spend >= floor;
    // "Underfunded" is a share, not an amount: an object beating the account's
    // ROAS by half again is already, arithmetically, taking a smaller slice of
    // the spend than it returns of the revenue. The only thing left to exclude
    // is the object that is ALREADY most of the budget — telling someone to
    // raise that is not shifting money toward what works, it is just spending
    // more. Expressed as a share so it means the same on a 2.000 TRY account
    // and a 2.000.000 TRY one.
    const spendShare = ctx.baselines.totalSpend > 0 ? spend / ctx.baselines.totalSpend : 1;
    if (
      accountRoas !== null &&
      provenEnough &&
      m.roas > accountRoas * HIGH_ROAS_RATIO &&
      spendShare < DOMINANT_SPEND_SHARE
    ) {
      const budget = budgetActionFor(row, budgetOwnerOf(row, ctx.cboCampaignIds), ctx.currency);
      out.push({
        ...baseFinding(row, "high_roas_underfunded", ctx),
        facts: {
          spend: round(spend, 2),
          roas: round(m.roas, 2),
          accountRoas: round(accountRoas, 2),
          purchases: m.purchases,
          dailyBudget: row.dailyBudget,
          lifetimeBudget: row.lifetimeBudget,
        },
        evidence:
          `${label} yalnızca ${money(spend, ctx.currency)} harcadığı halde ROAS ${round(m.roas, 2)}x ` +
          `üretti; hesap ortalaması ${round(accountRoas, 2)}x.`,
        action: budget.action,
        goal: "Ortalamanın üzerinde getiri sağlayan bir yapıya daha fazla bütçe yönlendirmek.",
        risk:
          "Bütçe artışı öğrenme aşamasını yeniden tetikleyebilir ve ölçek büyüdükçe ROAS " +
          "düşebilir; kademeli artırın.",
        writeTool: budget.writeTool,
        priorityBasis: `Ortalamanın üzerinde ROAS, düşük harcama (${money(spend, ctx.currency)}).`,
      });
    }
  }

  // ── Trend signals. All of them need both periods to carry a real number.
  if (!previous || !worthActingOn) return out;

  const trends: Array<{
    kind: FindingKind;
    metric: keyof MetricsDto;
    turkish: string;
    rising: boolean;
    digits: number;
    suffix: string;
  }> = [
    { kind: "cpa_rising", metric: "costPerPurchase", turkish: "satın alma maliyeti", rising: true, digits: 2, suffix: ` ${ctx.currency}` },
    { kind: "ctr_falling", metric: "ctr", turkish: "CTR", rising: false, digits: 2, suffix: "%" },
    { kind: "cpc_rising", metric: "cpc", turkish: "CPC", rising: true, digits: 2, suffix: ` ${ctx.currency}` },
    { kind: "cpm_rising", metric: "cpm", turkish: "CPM", rising: true, digits: 2, suffix: ` ${ctx.currency}` },
  ];

  for (const trend of trends) {
    const current = m[trend.metric];
    const before = previous[trend.metric];
    const change = percentChange(current, before);
    if (change === null) continue;
    const moved = trend.rising ? change >= MATERIAL_CHANGE_PCT : change <= -MATERIAL_CHANGE_PCT;
    if (!moved) continue;

    out.push({
      ...baseFinding(row, trend.kind, ctx),
      facts: {
        spend: round(spend, 2),
        current: round(current, trend.digits),
        previous: round(before, trend.digits),
        changePercent: round(change, 1),
      },
      evidence:
        `${label} için ${trend.turkish} önceki döneme göre ` +
        `${round(before, trend.digits)}${trend.suffix} → ${round(current, trend.digits)}${trend.suffix} ` +
        `(%${round(Math.abs(change), 1)} ${trend.rising ? "artış" : "düşüş"}).`,
      action: trend.rising
        ? "Kreatif yorgunluğu ve rekabet artışı açısından inceleyin; kreatifi yenilemeyi değerlendirin."
        : "Kreatifin yorulup yorulmadığını ve hedeflemenin daralıp daralmadığını inceleyin.",
      goal: "Bozulan maliyet/etkileşim eğilimini erken yakalayıp harcamayı korumak.",
      risk:
        "Tek dönemlik bir dalgalanma olabilir; mevsimsellik veya rekabet kaynaklı geçici bir " +
        "hareketi kalıcı bir bozulma sanmamak için bir sonraki dönemi de izleyin.",
      writeTool: null,
      priorityBasis: `${money(spend, ctx.currency)} harcama üzerinde bozulan ${trend.turkish}.`,
    });
  }

  // Improvement is reported too: the user asked what to check today, and
  // "this is working, leave it alone" is an answer that prevents a bad edit.
  const roasChange = percentChange(m.roas, previous.roas);
  if (roasChange !== null && roasChange >= MATERIAL_CHANGE_PCT) {
    out.push({
      ...baseFinding(row, "improving", ctx),
      facts: {
        spend: round(spend, 2),
        roas: round(m.roas, 2),
        previousRoas: round(previous.roas, 2),
        changePercent: round(roasChange, 1),
      },
      evidence:
        `${label} için ROAS önceki döneme göre ${round(previous.roas, 2)}x → ${round(m.roas, 2)}x ` +
        `(%${round(roasChange, 1)} iyileşme).`,
      action: "Şu anki kurulumu bozmayın; bütçe artışını ancak kademeli olarak değerlendirin.",
      goal: "İyi çalışan bir yapıyı gereksiz müdahaleyle bozmamak.",
      risk: "Değişiklik yapmak öğrenme aşamasını sıfırlayabilir.",
      writeTool: null,
      priorityBasis: `${money(spend, ctx.currency)} harcama üzerinde iyileşen ROAS.`,
    });
  }

  return out;
}

export interface EngineResult {
  findings: Finding[];
  baselines: {
    totalSpend: number;
    totalPurchases: number;
    accountRoas: number | null;
    accountCostPerPurchase: number | null;
  };
  /** Counts by kind across every row, before the shortlist was cut. */
  counts: Record<string, number>;
  /**
   * Metrics no row reported. Named so the model can say "veri yok" instead of
   * ranking on a column that is empty everywhere.
   */
  metricsMissingOnEveryRow: string[];
}

const RANKED_KINDS: ReadonlySet<FindingKind> = new Set([
  "zero_conversion_spend",
  "low_roas",
  "high_roas_underfunded",
  "cpa_rising",
  "ctr_falling",
  "cpc_rising",
  "cpm_rising",
]);

/**
 * Run every signal over every row and return the findings worth acting on,
 * most money at stake first.
 *
 * Observations that are not actions — a paused object, an improving one — are
 * kept but sorted below the actionable ones, so a caller that takes the top
 * three gets three things to do rather than three things to note.
 */
export function analyze(input: EngineInput): EngineResult {
  const baselines = computeBaselines(input.rows);
  const ctx: Ctx = {
    currency: input.currency,
    baselines,
    cboCampaignIds: input.cboCampaignIds,
  };

  const findings: Finding[] = [];
  for (const row of input.rows) {
    findings.push(...findingsForRow(row, input.previousById.get(row.id), ctx, input.level));
  }

  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;

  findings.sort((a, b) => {
    const aRanked = RANKED_KINDS.has(a.kind) ? 1 : 0;
    const bRanked = RANKED_KINDS.has(b.kind) ? 1 : 0;
    if (aRanked !== bRanked) return bRanked - aRanked;
    return b.spendAtStake - a.spendAtStake;
  });

  const METRIC_NAMES: Array<keyof MetricsDto> = [
    "spend", "impressions", "reach", "clicks", "ctr", "cpc", "cpm",
    "purchases", "addToCart", "purchaseValue", "costPerPurchase", "roas",
  ];

  return {
    findings,
    baselines: {
      totalSpend: round(baselines.totalSpend, 2) ?? 0,
      totalPurchases: baselines.totalPurchases,
      accountRoas: round(baselines.accountRoas, 2),
      accountCostPerPurchase: round(baselines.accountCostPerPurchase, 2),
    },
    counts,
    metricsMissingOnEveryRow:
      input.rows.length === 0
        ? []
        : METRIC_NAMES.filter((key) => input.rows.every((row) => row.metrics[key] === null)),
  };
}

export {
  MIN_PURCHASES_FOR_HIGH_CONFIDENCE,
  MATERIAL_CHANGE_PCT,
  MATERIAL_SPEND_SHARE,
  LOW_ROAS_RATIO,
  HIGH_ROAS_RATIO,
  DOMINANT_SPEND_SHARE,
};
