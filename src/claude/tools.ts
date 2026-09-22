import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { metaApiClient } from "../meta/client.js";
import { DashboardError } from "../dashboard/errors.js";
import { checkRange, dateRangeShape, entityIdSchema, resolveRange, type ResolvedRange } from "../dashboard/schemas.js";
import { previousPeriod, resolvePresetDates } from "../dashboard/date-range.js";
import { toAiMetrics } from "../dashboard/ai/context.js";
import { sanitizeLabel, sanitizeLine } from "../dashboard/ai/sanitize.js";
import { listAccessibleAccounts } from "../dashboard/services/accounts.js";
import { getCampaignsWithMetrics } from "../dashboard/services/campaigns.js";
import { METRIC_KEYS } from "../dashboard/services/comparison.js";
import { filterEntityRows } from "../dashboard/services/entity-filters.js";
import {
  authorizeAd,
  authorizeAdSet,
  authorizeCampaign,
  listAdSetsOfAccount,
  listAdSetsOfCampaign,
  listAdsOfAccount,
  listAdsOfAdSet,
  type EntityRef,
} from "../dashboard/services/entities.js";
import {
  accountEntityRef,
  getAccountInsights,
  getChildRows,
  getEntityInsights,
} from "../dashboard/services/entity-insights.js";
import type { CampaignDto, EntityRowDto } from "../dashboard/dto.js";
import { analyze } from "./decision-engine.js";
import type { ConfirmationField, ToolExecutionContext } from "./types.js";

/**
 * The tool surface Claude is given.
 *
 * Three properties matter more than the tool list itself:
 *
 *  1. **No raw Meta access.** Claude never names a Graph path, a field list or
 *     a query parameter. Every tool is a high-level verb whose arguments are a
 *     Zod schema, and each one calls the *existing* dashboard services —
 *     `listAccessibleAccounts`, `getCampaignsWithMetrics`, `getEntityInsights`,
 *     `getChildRows`, `authorizeCampaign` … — so there is one Meta client, one
 *     cache, one guardrail path, and one authorization model in this codebase.
 *  2. **Authorization is not the model's business.** Every id that arrives in a
 *     tool call is re-authorized against the session's own account list and,
 *     below the account, against Meta's own `account_id` answer. A hallucinated
 *     or copied id fails closed with a stable code; it cannot read anything.
 *  3. **Writes never write.** A write tool's `plan` validates and describes the
 *     change; only `apply`, reached through an explicit user confirmation on a
 *     separate endpoint, sends anything to Meta.
 */

// ─── Shared input pieces ─────────────────────────────────────────

const rangeFields = { ...dateRangeShape };

/** Row ceilings. A tool result is context the user pays for on every later turn. */
const DEFAULT_ROW_LIMIT = 15;

/** Findings returned by the optimization pass, before the answer cuts it to three. */
const MAX_FINDINGS = 8;
const MAX_ROW_LIMIT = 40;

const limitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_ROW_LIMIT)
  .optional()
  .describe(`How many rows to return, highest spend first. Default ${DEFAULT_ROW_LIMIT}.`);

const INSIGHT_LEVELS = ["account", "campaign", "adset", "ad"] as const;

/**
 * Find rows by name, using the same matcher the drill-down table uses.
 *
 * Substring, accent- and case-folded, and deliberately NOT "best match": a
 * search for "J3" returns J3 and JJ3 both, because picking one of them here
 * would be the tool guessing which ad the user meant. Every match is returned
 * so the answer can ask.
 */
const nameQueryField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Filter by name (substring, case-insensitive). Use it to find a named object instead of paging the whole account. Every match is returned — 'J3' also matches 'JJ3', so say which one you mean rather than assuming.",
  );

// ─── Bounded result mappers ──────────────────────────────────────

/**
 * Ids are kept in tool results — unlike the one-shot analysis context, which
 * strips them. The agent needs them to drill down (campaign id → ad sets → ads)
 * and they are Meta object ids the browser already displays, not credentials.
 */
function toRowResult(row: EntityRowDto): Record<string, unknown> {
  return {
    id: row.id,
    name: sanitizeLabel(row.name),
    status: sanitizeLabel(row.effectiveStatus ?? row.status) || "UNKNOWN",
    // The parent CHAIN travels with the row — ids as well as names. Without
    // the ids the model can see that an ad lives in "SET2" and still have no
    // way to address SET2, which is exactly how a budget request aimed at an
    // ad set ends up pointed at an ad that has no budget.
    campaignId: row.campaignId,
    campaignName: row.campaignName ? sanitizeLabel(row.campaignName) : null,
    adSetId: row.adSetId,
    adSetName: row.adSetName ? sanitizeLabel(row.adSetName) : null,
    dailyBudget: row.dailyBudget,
    lifetimeBudget: row.lifetimeBudget,
    metrics: toAiMetrics(row.metrics),
  };
}

interface RowResult {
  rows: Record<string, unknown>[];
  totalRows: number;
  truncated: boolean;
  dataQuality: {
    /** Rows Meta reported no spend and no impressions for in this period. */
    rowsWithNoDelivery: number;
    /**
     * Metrics Meta returned for NONE of these rows. Stated explicitly because
     * "every roas is null" is easy to miss row by row, and a model that misses
     * it is one step from inventing a ranking that the data cannot support.
     */
    metricsMissingOnEveryRow: string[];
  };
}

function sortAndCap(rows: EntityRowDto[], limit: number | undefined): RowResult {
  const applied = limit ?? DEFAULT_ROW_LIMIT;
  const sorted = [...rows].sort((a, b) => (b.metrics.spend || 0) - (a.metrics.spend || 0));
  const shown = sorted.slice(0, applied);

  return {
    rows: shown.map(toRowResult),
    totalRows: rows.length,
    truncated: rows.length > applied,
    dataQuality: {
      rowsWithNoDelivery: shown.filter(
        (row) => row.metrics.spend === 0 && row.metrics.impressions === 0,
      ).length,
      metricsMissingOnEveryRow:
        shown.length === 0
          ? []
          : METRIC_KEYS.filter((key) => shown.every((row) => row.metrics[key] === null)),
    },
  };
}

/** A campaign as a generic row, so one analysis path covers all three levels. */
function campaignRow(campaign: CampaignDto): EntityRowDto {
  return {
    id: campaign.id,
    level: "campaign",
    name: campaign.name,
    status: campaign.status,
    effectiveStatus: campaign.effectiveStatus,
    objective: campaign.objective,
    campaignId: campaign.id,
    campaignName: campaign.name,
    adSetId: null,
    adSetName: null,
    creativeId: null,
    dailyBudget: campaign.dailyBudget,
    lifetimeBudget: campaign.lifetimeBudget,
    metrics: campaign.metrics,
  };
}

function entitySummary(entity: EntityRef): Record<string, unknown> {
  return {
    id: entity.id,
    level: entity.level,
    name: sanitizeLabel(entity.name),
    status: entity.status ? sanitizeLabel(entity.status) : null,
    effectiveStatus: entity.effectiveStatus ? sanitizeLabel(entity.effectiveStatus) : null,
    objective: entity.objective ? sanitizeLabel(entity.objective) : null,
    campaignId: entity.campaignId,
    campaignName: entity.campaignName ? sanitizeLabel(entity.campaignName) : null,
    adSetId: entity.adSetId,
    adSetName: entity.adSetName ? sanitizeLabel(entity.adSetName) : null,
    dailyBudget: entity.dailyBudget,
    lifetimeBudget: entity.lifetimeBudget,
  };
}

/** Metrics Meta returned nothing for, stated rather than left as an ambiguous 0. */
function missingOf(metrics: Record<string, number | null>): string[] {
  return METRIC_KEYS.filter((key) => metrics[key] === null);
}

async function resolveScope(
  input: { level: (typeof INSIGHT_LEVELS)[number]; entityId?: string },
  tools: ToolExecutionContext,
): Promise<EntityRef | null> {
  if (input.level === "account") return null;
  const id = entityIdSchema.parse(input.entityId);
  if (input.level === "campaign") return authorizeCampaign(tools.ctx, tools.account, id);
  if (input.level === "adset") return authorizeAdSet(tools.ctx, tools.account, id);
  return authorizeAd(tools.ctx, tools.account, id);
}

// ─── Read tools ──────────────────────────────────────────────────

export interface ReadTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Turkish label for the "which data did the AI read" trace. */
  label(input: z.output<S>): string;
  run(input: z.output<S>, tools: ToolExecutionContext): Promise<unknown>;
}

function readTool<S extends z.ZodType>(tool: ReadTool<S>): ReadTool {
  return tool as unknown as ReadTool;
}

const insightsInput = z
  .object({
    ...rangeFields,
    level: z.enum(INSIGHT_LEVELS).default("account"),
    entityId: entityIdSchema.optional().describe("Required unless level is account."),
    compare: z
      .boolean()
      .optional()
      .describe("Also return the previous equivalent period and the change per metric."),
  })
  .superRefine((value, ctx) => {
    checkRange(value, ctx);
    if (value.level !== "account" && value.entityId === undefined) {
      ctx.addIssue({ code: "custom", message: "entityId is required unless level is account" });
    }
  });

export const READ_TOOLS: ReadTool[] = [
  readTool({
    name: "meta_list_ad_accounts",
    description:
      "List every Meta ad account the signed-in user can reach. Use it when the user names an account you do not have an id for. Returns id, name, currency and status.",
    schema: z.object({}),
    label: () => "Reklam hesapları listelendi",
    async run(_input, tools) {
      const accounts = await listAccessibleAccounts(tools.ctx);
      return {
        accounts: accounts.map((account) => ({
          id: account.id,
          name: sanitizeLabel(account.name),
          currency: account.currency,
          status: account.status,
        })),
        selectedAccountId: tools.account.id,
      };
    },
  }),

  readTool({
    name: "meta_get_campaigns",
    description:
      "Campaigns of the selected ad account with their metrics for a period, highest spend first. The starting point for almost every question about the account as a whole.",
    schema: z
      .object({
        ...rangeFields,
        status: z
          .enum(["ALL", "ACTIVE", "PAUSED", "ARCHIVED", "DELETED"])
          .optional()
          .describe("Filter by configured status. Default ALL."),
        q: nameQueryField,
        limit: limitField,
      })
      .superRefine(checkRange),
    label: (input) => `Kampanyalar okundu (${input.preset})`,
    async run(input, tools) {
      const range = resolveRange(input);
      const response = await getCampaignsWithMetrics(tools.ctx, tools.account, range, {
        status: input.status ?? "ALL",
      });
      const rows: EntityRowDto[] = response.campaigns.map((campaign) => ({
        id: campaign.id,
        level: "campaign",
        name: campaign.name,
        status: campaign.status,
        effectiveStatus: campaign.effectiveStatus,
        objective: campaign.objective,
        campaignId: campaign.id,
        campaignName: campaign.name,
        adSetId: null,
        adSetName: null,
        creativeId: null,
        dailyBudget: campaign.dailyBudget,
        lifetimeBudget: campaign.lifetimeBudget,
        metrics: campaign.metrics,
      }));
      return {
        account: { name: sanitizeLabel(tools.account.name), currency: tools.account.currency },
        period: { preset: range.label, since: range.since, until: range.until },
        // Filtered before the cap, or a named object outside the top rows by
        // spend would be invisible to a search that should have found it.
        ...sortAndCap(filterEntityRows(rows, { q: input.q }), input.limit),
      };
    },
  }),

  readTool({
    name: "meta_get_ad_sets",
    description:
      "Ad sets with their metrics for a period, highest spend first. Omit campaignId to get every ad set in the account in one call — that is how you find the worst ad set without walking the tree. Pass campaignId only when the question is about one campaign.",
    schema: z
      .object({ ...rangeFields, campaignId: entityIdSchema.optional(), q: nameQueryField, limit: limitField })
      .superRefine(checkRange),
    label: (input) =>
      input.campaignId
        ? `Kampanyanın reklam setleri okundu (${input.preset})`
        : `Hesaptaki tüm reklam setleri okundu (${input.preset})`,
    async run(input, tools) {
      const range = resolveRange(input);
      const parent = input.campaignId
        ? await authorizeCampaign(tools.ctx, tools.account, input.campaignId)
        : accountEntityRef(tools.account);
      const children = input.campaignId
        ? await listAdSetsOfCampaign(tools.ctx, tools.account, parent)
        : await listAdSetsOfAccount(tools.ctx, tools.account);
      const rows = await getChildRows(tools.ctx, tools.account, parent, "adset", range, children);
      return {
        parent: { level: parent.level, id: input.campaignId ?? null, name: sanitizeLabel(parent.name) },
        currency: tools.account.currency,
        period: { preset: range.label, since: range.since, until: range.until },
        ...sortAndCap(filterEntityRows(rows, { q: input.q }), input.limit),
      };
    },
  }),

  readTool({
    name: "meta_get_ads",
    description:
      "Ads with their metrics for a period, highest spend first. Omit adSetId to get every ad in the account in one call — that is how you answer 'which ad is losing money' or 'which ad should I turn off'. Pass adSetId only when the question is about one ad set.",
    schema: z
      .object({ ...rangeFields, adSetId: entityIdSchema.optional(), q: nameQueryField, limit: limitField })
      .superRefine(checkRange),
    label: (input) =>
      input.adSetId
        ? `Reklam setinin reklamları okundu (${input.preset})`
        : `Hesaptaki tüm reklamlar okundu (${input.preset})`,
    async run(input, tools) {
      const range = resolveRange(input);
      const parent = input.adSetId
        ? await authorizeAdSet(tools.ctx, tools.account, input.adSetId)
        : accountEntityRef(tools.account);
      const children = input.adSetId
        ? await listAdsOfAdSet(tools.ctx, tools.account, parent)
        : await listAdsOfAccount(tools.ctx, tools.account);
      const rows = await getChildRows(tools.ctx, tools.account, parent, "ad", range, children);
      return {
        parent: { level: parent.level, id: input.adSetId ?? null, name: sanitizeLabel(parent.name) },
        currency: tools.account.currency,
        period: { preset: range.label, since: range.since, until: range.until },
        ...sortAndCap(filterEntityRows(rows, { q: input.q }), input.limit),
      };
    },
  }),

  readTool({
    name: "meta_get_insights",
    description:
      "Aggregate metrics for the whole account or for one campaign, ad set or ad: spend, impressions, reach, clicks, CTR, CPC, CPM, add-to-cart, purchases, purchase value, cost per purchase and ROAS, plus a daily series. Set compare to also get the previous equivalent period.",
    schema: insightsInput,
    label: (input) => `Performans verileri okundu (${input.preset})`,
    async run(input, tools) {
      const range = resolveRange(input);
      const entity = await resolveScope(input, tools);
      const insights = entity
        ? await getEntityInsights(tools.ctx, tools.account, entity, range, {
            compare: input.compare ?? false,
          })
        : await getAccountInsights(tools.ctx, tools.account, range, {
            compare: input.compare ?? false,
          });

      const summary = toAiMetrics(insights.summary);
      return {
        scope: { level: insights.entity.level, name: sanitizeLabel(insights.entity.name) },
        currency: insights.account.currency,
        period: insights.resolvedRange ?? { since: range.since, until: range.until },
        summary,
        missingMetrics: missingOf(summary as unknown as Record<string, number | null>),
        previousPeriod: insights.comparison?.range ?? null,
        previous: insights.comparison ? toAiMetrics(insights.comparison.previous) : null,
        dailySeries: insights.series.slice(-31),
      };
    },
  }),

  readTool({
    name: "meta_compare_periods",
    description:
      "The current period against the previous equivalent one (same length, ending the day before it starts) for the account or one object. Returns both sets of metrics and the absolute and percentage change of each. Use this for 'why did X drop' questions.",
    schema: insightsInput,
    label: (input) => `Dönem karşılaştırması yapıldı (${input.preset})`,
    async run(input, tools) {
      const range = resolveRange(input);
      const entity = await resolveScope(input, tools);
      // No chart is rendered from this tool, so the daily series would be a
      // paginated Meta call whose result is thrown away.
      const options = { compare: true, includeSeries: false };
      const insights = entity
        ? await getEntityInsights(tools.ctx, tools.account, entity, range, options)
        : await getAccountInsights(tools.ctx, tools.account, range, options);

      const summary = toAiMetrics(insights.summary);
      return {
        scope: { level: insights.entity.level, name: sanitizeLabel(insights.entity.name) },
        currency: insights.account.currency,
        currentPeriod: insights.resolvedRange,
        previousPeriod: insights.comparison?.range ?? null,
        current: summary,
        previous: insights.comparison ? toAiMetrics(insights.comparison.previous) : null,
        changes: insights.comparison?.changes ?? null,
        lowerIsBetter: insights.comparison?.lowerIsBetter ?? [],
        missingMetrics: missingOf(summary as unknown as Record<string, number | null>),
      };
    },
  }),

  readTool({
    name: "meta_find_opportunities",
    description:
      "The optimization pass. Reads one level of the account for a period AND the previous equivalent period, then returns the objects worth acting on, most spend at stake first, each with the evidence, a suggested action, its purpose and its risk already worked out from the real numbers. Use it for 'bugün neyi kontrol etmeliyim', 'hangi reklamlar para harcayıp satış getirmiyor', 'bütçeyi nerede artırayım', 'en büyük sorunlar neler' and 'bana 3 optimizasyon öner'. Start at level 'ad' for 'which ad', 'campaign' for a whole-account picture. It does not change anything and proposes no write by itself.",
    schema: z
      .object({
        ...rangeFields,
        level: z
          .enum(["campaign", "adset", "ad"])
          .default("ad")
          .describe("Which level to analyse. Default 'ad'."),
      })
      .superRefine(checkRange),
    label: (input) => `Optimizasyon taraması yapıldı (${input.level}, ${input.preset})`,
    async run(input, tools) {
      const range = resolveRange(input);
      const parent = accountEntityRef(tools.account);
      const level = input.level;

      // The previous window is the same rule the comparison uses everywhere
      // else: same length, ending the day before this one starts.
      const concrete = range.timeRange ?? resolvePresetDates(range.datePreset ?? "last_30d", tools.account.timezone);
      const before = previousPeriod(concrete);
      const previousRange: ResolvedRange = {
        datePreset: null,
        timeRange: before,
        label: "custom",
        since: before.since,
        until: before.until,
      };

      let rows: EntityRowDto[];
      let previousRows: EntityRowDto[];
      let cboCampaignIds = new Set<string>();

      if (level === "campaign") {
        const [current, prior] = await Promise.all([
          getCampaignsWithMetrics(tools.ctx, tools.account, range, { status: "ALL" }),
          getCampaignsWithMetrics(tools.ctx, tools.account, previousRange, { status: "ALL" }),
        ]);
        rows = current.campaigns.map(campaignRow);
        previousRows = prior.campaigns.map(campaignRow);
      } else {
        const children =
          level === "adset"
            ? await listAdSetsOfAccount(tools.ctx, tools.account)
            : await listAdsOfAccount(tools.ctx, tools.account);
        // Campaign budgets decide whether an ad-set budget recommendation is
        // even expressible: under CBO it is not.
        const [current, prior, campaigns] = await Promise.all([
          getChildRows(tools.ctx, tools.account, parent, level, range, children),
          getChildRows(tools.ctx, tools.account, parent, level, previousRange, children),
          getCampaignsWithMetrics(tools.ctx, tools.account, range, { status: "ALL" }),
        ]);
        rows = current;
        previousRows = prior;
        cboCampaignIds = new Set(
          campaigns.campaigns
            .filter((campaign) => campaign.dailyBudget !== null || campaign.lifetimeBudget !== null)
            .map((campaign) => campaign.id),
        );
      }

      const previousById = new Map(previousRows.map((row) => [row.id, row.metrics]));
      const result = analyze({ level, currency: tools.account.currency, rows, previousById, cboCampaignIds });

      return {
        account: { name: sanitizeLabel(tools.account.name), currency: tools.account.currency },
        level,
        period: { preset: range.label, since: concrete.since, until: concrete.until },
        previousPeriod: before,
        rowsAnalyzed: rows.length,
        baselines: result.baselines,
        counts: result.counts,
        metricsMissingOnEveryRow: result.metricsMissingOnEveryRow,
        findings: result.findings.slice(0, MAX_FINDINGS).map((finding) => ({
          ...finding,
          objectName: sanitizeLabel(finding.objectName),
          campaignName: finding.campaignName ? sanitizeLabel(finding.campaignName) : null,
          adSetName: finding.adSetName ? sanitizeLabel(finding.adSetName) : null,
        })),
        totalFindings: result.findings.length,
      };
    },
  }),

  readTool({
    name: "meta_get_campaign_detail",
    description:
      "One campaign: its configuration (objective, status, budget) together with its metrics and the previous-period comparison. Use it when the user asks about a specific campaign.",
    schema: z
      .object({ ...rangeFields, campaignId: entityIdSchema })
      .superRefine(checkRange),
    label: () => "Kampanya detayı okundu",
    async run(input, tools) {
      return entityDetail(tools, await authorizeCampaign(tools.ctx, tools.account, input.campaignId), input);
    },
  }),

  readTool({
    name: "meta_get_ad_set_detail",
    description:
      "One ad set: its configuration and parent campaign together with its metrics and the previous-period comparison.",
    schema: z.object({ ...rangeFields, adSetId: entityIdSchema }).superRefine(checkRange),
    label: () => "Reklam seti detayı okundu",
    async run(input, tools) {
      return entityDetail(tools, await authorizeAdSet(tools.ctx, tools.account, input.adSetId), input);
    },
  }),

  readTool({
    name: "meta_get_ad_detail",
    description:
      "One ad: its configuration and parents together with its metrics and the previous-period comparison.",
    schema: z.object({ ...rangeFields, adId: entityIdSchema }).superRefine(checkRange),
    label: () => "Reklam detayı okundu",
    async run(input, tools) {
      return entityDetail(tools, await authorizeAd(tools.ctx, tools.account, input.adId), input);
    },
  }),
];

/** Shared body of the three *_detail tools: identical shape, different authorizer. */
async function entityDetail(
  tools: ToolExecutionContext,
  entity: EntityRef,
  input: { preset: string; since?: string; until?: string },
): Promise<Record<string, unknown>> {
  const range = resolveRange(input as Parameters<typeof resolveRange>[0]);
  const insights = await getEntityInsights(tools.ctx, tools.account, entity, range, {
    compare: true,
    // Same reasoning as meta_compare_periods: this result carries no series.
    includeSeries: false,
  });
  const summary = toAiMetrics(insights.summary);
  return {
    entity: entitySummary(entity),
    currency: insights.account.currency,
    period: insights.resolvedRange,
    previousPeriod: insights.comparison?.range ?? null,
    summary,
    previous: insights.comparison ? toAiMetrics(insights.comparison.previous) : null,
    changes: insights.comparison?.changes ?? null,
    missingMetrics: missingOf(summary as unknown as Record<string, number | null>),
  };
}

// ─── Write tools ─────────────────────────────────────────────────

/**
 * A validated, authorized change that has NOT been sent to Meta.
 *
 * `body` is built entirely from schema-validated fields — never from the user's
 * prompt text and never from anything Claude wrote free-form — and it is stored
 * server-side until the user approves it.
 */
export interface WritePlan {
  tool: string;
  title: string;
  description: string;
  fields: ConfirmationField[];
  /** What could go wrong, in the model’s words. Optional: not every proposal has one. */
  risk: string | null;
  /** How well the data supports acting, when the proposal came from a finding. */
  confidence: "low" | "medium" | "high" | null;
  /**
   * Why the model is proposing this, in its own words and already sanitized.
   * Shown in the confirmation dialog: a user approving a budget change needs
   * the argument for it next to the number, not only the number.
   */
  reason: string;
  /** Graph path and form body, already fully built. */
  path: string;
  body: Record<string, string>;
  /** Object to re-read after the write, to verify what actually landed. */
  verify: { kind: "created" | "existing"; id: string | null; level: "campaign" | "adset" | "ad" };
  /**
   * What the fields this plan changes looked like when it was proposed.
   *
   * A confirmation can sit for ten minutes, and in that window someone else —
   * a colleague in Ads Manager, another session, an automated rule — can move
   * the same budget or flip the same status. Applying the plan blind would
   * silently overwrite their change with a number the user approved against a
   * world that no longer exists. Checked against a fresh read immediately
   * before the write; a mismatch aborts instead of guessing which value wins.
   *
   * Only the keys this plan actually writes are recorded, so an unrelated
   * edit elsewhere on the object does not block it. Empty for creations,
   * which have nothing to have drifted.
   */
  expected: Record<string, string | number | null>;
}

export interface WriteTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  plan(input: z.output<S>, tools: ToolExecutionContext): Promise<WritePlan>;
}

function writeTool<S extends z.ZodType>(tool: WriteTool<S>): WriteTool {
  return tool as unknown as WriteTool;
}

const STATUS_VALUES = ["ACTIVE", "PAUSED"] as const;
const OBJECTIVES = [
  "OUTCOME_AWARENESS",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_TRAFFIC",
  "OUTCOME_APP_PROMOTION",
] as const;

const nameField = z.string().trim().min(1).max(200);

const MAX_REASON_CHARS = 300;

/**
 * Required on every write, so the confirmation dialog can never show a change
 * with no argument behind it. Model-authored free text, so it is sanitized on
 * the way into the plan rather than on the way out to the browser.
 */
const riskField = z
  .string()
  .trim()
  .min(1)
  .max(MAX_REASON_CHARS)
  .optional()
  .describe(
    "One short Turkish sentence naming what could go wrong if this is applied. Copy the finding’s risk when the proposal came from meta_find_opportunities.",
  );

const confidenceField = z
  .enum(["low", "medium", "high"])
  .optional()
  .describe(
    "How well the data supports acting. Copy the finding’s confidence when the proposal came from meta_find_opportunities; omit it otherwise rather than guessing.",
  );

const reasonField = z
  .string()
  .trim()
  .min(1)
  .max(MAX_REASON_CHARS)
  .describe(
    "One short Turkish sentence saying why this change is worth making, citing the number that justifies it. Shown to the user next to the Onayla button.",
  );

/**
 * Budgets are taken in **major units** (₺1.500, not 150000 kuruş) because that
 * is what the user says out loud, and converted here. Meta wants an integer
 * count of minor units, so anything below one minor unit is a rounding error,
 * not a budget.
 */
const budgetField = z
  .number()
  .positive()
  .max(10_000_000)
  .optional()
  .describe("Budget in the account currency's major unit, e.g. 1500 for ₺1.500. Not in kuruş/cents.");

function toMinorUnits(value: number): string {
  return String(Math.round(value * 100));
}

function money(value: number, currency: string): string {
  return `${new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${currency}`;
}

const STATUS_LABEL: Record<string, string> = { ACTIVE: "Aktif", PAUSED: "Duraklatıldı" };

function requireSomething(fields: ConfirmationField[], what: string): void {
  if (fields.length === 0) {
    throw new DashboardError("invalid_request", 400, `No change was requested for this ${what}.`);
  }
}

/**
 * True when the campaign holds the budget itself — Campaign Budget
 * Optimization, which Meta's UI now calls Advantage campaign budget.
 */
function campaignHoldsTheBudget(campaign: EntityRef): boolean {
  return campaign.dailyBudget !== null || campaign.lifetimeBudget !== null;
}

/**
 * Refuse an ad-set budget under a CBO campaign, and say why at length.
 *
 * The trap this closes is specific. Under CBO an ad set's `daily_budget` comes
 * back as `null`, which reads exactly like a missing value waiting to be
 * filled in — so "bu sete 500 TL bütçe ver" turns into an ad-set budget write
 * that Meta rejects, or, worse, into a campaign budget write the user never
 * asked for. A campaign budget is shared by every ad set under it, so moving it
 * is a different decision with a different blast radius, and the user has to
 * make that one deliberately.
 *
 * The message is English and addressed to the model, like every other refusal
 * here; the model relays it to the user in Turkish.
 */
function refuseAdSetBudgetUnderCbo(campaign: EntityRef, currency: string): never {
  const current =
    campaign.dailyBudget !== null
      ? `${money(campaign.dailyBudget, currency)} daily`
      : `${money(campaign.lifetimeBudget as number, currency)} lifetime`;
  throw new DashboardError(
    "invalid_request",
    400,
    [
      `The campaign "${sanitizeLabel(campaign.name)}" (id ${campaign.id}) holds its budget at campaign`,
      `level — Campaign Budget Optimization / Advantage campaign budget — currently ${current}.`,
      "Its ad sets therefore have no budget of their own, which is why an ad set's daily budget reads",
      "as null. That null is not a missing value to fill in.",
      "Do NOT retry this as an ad set budget, and do NOT quietly change the campaign budget instead:",
      "a campaign budget is shared by every ad set under that campaign, so changing it affects all of",
      "them and is not what was asked for.",
      "Instead, tell the user in Turkish that this campaign's budget is set at campaign level, say what",
      "it is now, and ask whether they want the CAMPAIGN budget changed to the figure they named.",
      `Only after they say yes, in a later turn, call meta_update_campaign with campaignId ${campaign.id}.`,
      "If what they actually wanted was to turn an ad set on or off, call meta_update_ad_set again with",
      "only `status` and no budget field — that is allowed under CBO and is a separate request.",
    ].join(" "),
  );
}

/**
 * The current value of exactly the fields a plan is about to write.
 *
 * Keyed by the Meta form field so the comparison at apply time is against the
 * same names the write uses, and narrowed to the keys in `body` so an edit to
 * some unrelated part of the object never blocks an approved change.
 */
function snapshotOf(ref: EntityRef, body: Record<string, string>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if ("name" in body) out.name = ref.name;
  if ("status" in body) out.status = ref.status;
  if ("daily_budget" in body) out.daily_budget = ref.dailyBudget;
  if ("lifetime_budget" in body) out.lifetime_budget = ref.lifetimeBudget;
  return out;
}

/** Budget rules are Meta's, not ours: exactly one of daily/lifetime, never both. */
function assertSingleBudget(daily?: number, lifetime?: number): void {
  if (daily !== undefined && lifetime !== undefined) {
    throw new DashboardError(
      "invalid_request",
      400,
      "A daily budget and a lifetime budget cannot both be set on the same object.",
    );
  }
}

export const WRITE_TOOLS: WriteTool[] = [
  writeTool({
    name: "meta_create_campaign",
    description:
      "Propose creating a campaign in the selected ad account. Nothing is sent to Meta until the user approves the confirmation this produces. Campaigns are created paused unless the user explicitly asks for active.",
    schema: z.object({
      reason: reasonField,
      risk: riskField,
      confidence: confidenceField,
      name: nameField.describe("Campaign name as the user wants it."),
      objective: z.enum(OBJECTIVES),
      status: z.enum(STATUS_VALUES).optional(),
      dailyBudget: budgetField,
      lifetimeBudget: budgetField,
    }),
    async plan(input, tools) {
      assertSingleBudget(input.dailyBudget, input.lifetimeBudget);
      const status = input.status ?? "PAUSED";
      const body: Record<string, string> = {
        name: input.name,
        objective: input.objective,
        status,
        special_ad_categories: "[]",
      };
      if (input.dailyBudget !== undefined) body.daily_budget = toMinorUnits(input.dailyBudget);
      if (input.lifetimeBudget !== undefined) body.lifetime_budget = toMinorUnits(input.lifetimeBudget);

      const fields: ConfirmationField[] = [
        { label: "Kampanya adı", value: input.name },
        { label: "Hedef", value: input.objective },
        { label: "Başlangıç durumu", value: STATUS_LABEL[status] ?? status },
      ];
      if (input.dailyBudget !== undefined) {
        fields.push({ label: "Günlük bütçe", value: money(input.dailyBudget, tools.account.currency) });
      }
      if (input.lifetimeBudget !== undefined) {
        fields.push({ label: "Toplam bütçe", value: money(input.lifetimeBudget, tools.account.currency) });
      }

      return {
        tool: "meta_create_campaign",
        title: "Meta'da yeni kampanya oluşturulacak",
        description: "Onaylarsanız bu kampanya Meta hesabınızda oluşturulur.",
        reason: sanitizeLine(input.reason, MAX_REASON_CHARS),
        risk: input.risk ? sanitizeLine(input.risk, MAX_REASON_CHARS) : null,
        confidence: input.confidence ?? null,
        fields,
        path: `/${tools.account.id}/campaigns`,
        body,
        expected: {},
        verify: { kind: "created", id: null, level: "campaign" },
      };
    },
  }),

  writeTool({
    name: "meta_update_campaign",
    description:
      "Propose changing an existing campaign: rename it, pause or activate it, or change its budget. Status changes and budget changes both go through this tool — there is no separate status tool. Nothing is sent to Meta until the user approves.",
    schema: z.object({
      reason: reasonField,
      risk: riskField,
      confidence: confidenceField,
      campaignId: entityIdSchema,
      campaignBudgetRequestedByUser: z
        .boolean()
        .optional()
        .describe(
          "Set true ONLY when the user asked for the CAMPAIGN budget in those terms. Required for any budget change here. A campaign budget is shared by every ad set under it, so a request about one ad set is never a request about the campaign — if you could not read the ad set, say so and stop; do not retarget.",
        ),
      name: nameField.optional(),
      status: z.enum(STATUS_VALUES).optional(),
      dailyBudget: budgetField,
      lifetimeBudget: budgetField,
    }),
    async plan(input, tools) {
      assertSingleBudget(input.dailyBudget, input.lifetimeBudget);

      // The failure this closes was observed in production: a read of the ad
      // set timed out on Meta's insights quota, and rather than reporting that,
      // the model moved the budget request up to the campaign — an object the
      // user had not mentioned, shared by every ad set under it. A budget here
      // now requires the model to state that the user asked for the campaign,
      // so retargeting takes a deliberate false claim rather than a slip.
      const touchesBudget = input.dailyBudget !== undefined || input.lifetimeBudget !== undefined;
      if (touchesBudget && input.campaignBudgetRequestedByUser !== true) {
        throw new DashboardError(
          "invalid_request",
          400,
          "A campaign budget change requires campaignBudgetRequestedByUser: true, and that flag is " +
            "only honest when the user asked for the CAMPAIGN budget in those terms. A campaign " +
            "budget is shared by every ad set under it, so a request about one ad set is not a " +
            "request about the campaign. If you could not read the ad set — a failed read, a rate " +
            "limit, a missing budget under CBO — tell the user exactly that and stop. Do not " +
            "substitute a different object.",
        );
      }

      const campaign = await authorizeCampaign(tools.ctx, tools.account, input.campaignId);

      const body: Record<string, string> = {};
      const fields: ConfirmationField[] = [{ label: "Kampanya", value: sanitizeLabel(campaign.name) }];
      if (input.name !== undefined) {
        body.name = input.name;
        fields.push({ label: "Yeni ad", value: input.name });
      }
      if (input.status !== undefined) {
        body.status = input.status;
        fields.push({ label: "Yeni durum", value: STATUS_LABEL[input.status] ?? input.status });
      }
      if (input.dailyBudget !== undefined) {
        body.daily_budget = toMinorUnits(input.dailyBudget);
        fields.push({
          label: "Yeni günlük bütçe",
          value: `${money(input.dailyBudget, tools.account.currency)}${campaign.dailyBudget !== null ? ` (önce ${money(campaign.dailyBudget, tools.account.currency)})` : ""}`,
        });
      }
      if (input.lifetimeBudget !== undefined) {
        body.lifetime_budget = toMinorUnits(input.lifetimeBudget);
        fields.push({ label: "Yeni toplam bütçe", value: money(input.lifetimeBudget, tools.account.currency) });
      }
      requireSomething(fields.slice(1), "campaign");

      return {
        tool: "meta_update_campaign",
        title: "Kampanya güncellenecek",
        description: "Onaylarsanız bu değişiklik Meta'ya gönderilir.",
        reason: sanitizeLine(input.reason, MAX_REASON_CHARS),
        risk: input.risk ? sanitizeLine(input.risk, MAX_REASON_CHARS) : null,
        confidence: input.confidence ?? null,
        fields,
        path: `/${campaign.id}`,
        body,
        expected: snapshotOf(campaign, body),
        verify: { kind: "existing", id: campaign.id, level: "campaign" },
      };
    },
  }),

  writeTool({
    name: "meta_create_ad_set",
    description:
      "Propose creating an ad set inside a campaign. Targeting is limited to countries, age range and gender — anything more detailed has to be done in Ads Manager. Nothing is sent to Meta until the user approves.",
    schema: z.object({
      reason: reasonField,
      risk: riskField,
      confidence: confidenceField,
      campaignId: entityIdSchema,
      name: nameField,
      status: z.enum(STATUS_VALUES).optional(),
      dailyBudget: budgetField,
      lifetimeBudget: budgetField,
      optimizationGoal: z
        .enum(["OFFSITE_CONVERSIONS", "LINK_CLICKS", "IMPRESSIONS", "REACH", "LANDING_PAGE_VIEWS", "THRUPLAY"])
        .optional(),
      billingEvent: z.enum(["IMPRESSIONS", "LINK_CLICKS", "THRUPLAY"]).optional(),
      destinationType: z.enum(["WEBSITE", "APP", "MESSENGER", "WHATSAPP", "INSTAGRAM_DIRECT", "ON_AD"]).optional(),
      countries: z
        .array(z.string().regex(/^[A-Z]{2}$/, "Two-letter uppercase ISO country code"))
        .min(1)
        .max(25)
        .describe("Targeted countries as ISO-3166-1 alpha-2 codes, e.g. ['TR']."),
      ageMin: z.number().int().min(13).max(65).optional(),
      ageMax: z.number().int().min(13).max(65).optional(),
      genders: z.enum(["all", "male", "female"]).optional(),
    }),
    async plan(input, tools) {
      assertSingleBudget(input.dailyBudget, input.lifetimeBudget);
      if (input.ageMin !== undefined && input.ageMax !== undefined && input.ageMin > input.ageMax) {
        throw new DashboardError("invalid_request", 400, "ageMin cannot be greater than ageMax.");
      }
      const campaign = await authorizeCampaign(tools.ctx, tools.account, input.campaignId);
      if (
        (input.dailyBudget !== undefined || input.lifetimeBudget !== undefined) &&
        campaignHoldsTheBudget(campaign)
      ) {
        refuseAdSetBudgetUnderCbo(campaign, tools.account.currency);
      }
      const status = input.status ?? "PAUSED";

      // Targeting is assembled from enumerated fields only. No part of the
      // user's prompt and no free-form object from the model reaches Meta.
      const targeting: Record<string, unknown> = {
        geo_locations: { countries: input.countries },
      };
      if (input.ageMin !== undefined) targeting.age_min = input.ageMin;
      if (input.ageMax !== undefined) targeting.age_max = input.ageMax;
      if (input.genders === "male") targeting.genders = [1];
      if (input.genders === "female") targeting.genders = [2];

      const body: Record<string, string> = {
        campaign_id: campaign.id,
        name: input.name,
        status,
        optimization_goal: input.optimizationGoal ?? "LINK_CLICKS",
        billing_event: input.billingEvent ?? "IMPRESSIONS",
        destination_type: input.destinationType ?? "WEBSITE",
        targeting: JSON.stringify(targeting),
      };
      if (input.dailyBudget !== undefined) body.daily_budget = toMinorUnits(input.dailyBudget);
      if (input.lifetimeBudget !== undefined) body.lifetime_budget = toMinorUnits(input.lifetimeBudget);

      const fields: ConfirmationField[] = [
        { label: "Reklam seti adı", value: input.name },
        { label: "Kampanya", value: sanitizeLabel(campaign.name) },
        { label: "Başlangıç durumu", value: STATUS_LABEL[status] ?? status },
        { label: "Ülkeler", value: input.countries.join(", ") },
      ];
      if (input.ageMin !== undefined || input.ageMax !== undefined) {
        fields.push({ label: "Yaş aralığı", value: `${input.ageMin ?? 18} – ${input.ageMax ?? 65}` });
      }
      if (input.genders && input.genders !== "all") {
        fields.push({ label: "Cinsiyet", value: input.genders === "male" ? "Erkek" : "Kadın" });
      }
      if (input.dailyBudget !== undefined) {
        fields.push({ label: "Günlük bütçe", value: money(input.dailyBudget, tools.account.currency) });
      }
      if (input.lifetimeBudget !== undefined) {
        fields.push({ label: "Toplam bütçe", value: money(input.lifetimeBudget, tools.account.currency) });
      }

      return {
        tool: "meta_create_ad_set",
        title: "Meta'da yeni reklam seti oluşturulacak",
        description: "Onaylarsanız bu reklam seti kampanyanın altında oluşturulur.",
        reason: sanitizeLine(input.reason, MAX_REASON_CHARS),
        risk: input.risk ? sanitizeLine(input.risk, MAX_REASON_CHARS) : null,
        confidence: input.confidence ?? null,
        fields,
        path: `/${tools.account.id}/adsets`,
        body,
        expected: {},
        verify: { kind: "created", id: null, level: "adset" },
      };
    },
  }),

  writeTool({
    name: "meta_update_ad_set",
    description:
      "Propose changing an existing ad set: rename it, pause or activate it, or change its budget. Nothing is sent to Meta until the user approves.",
    schema: z.object({
      reason: reasonField,
      risk: riskField,
      confidence: confidenceField,
      adSetId: entityIdSchema,
      becauseOfAdId: entityIdSchema
        .optional()
        .describe(
          "The ad whose performance prompted this, when the request started from one. An ad has no budget of its own, so a budget change asked for 'this ad' belongs on its ad set — pass the ad here and the confirmation names the whole chain (ad, ad set, campaign) instead of only the object being written.",
        ),
      name: nameField.optional(),
      status: z.enum(STATUS_VALUES).optional(),
      dailyBudget: budgetField,
      lifetimeBudget: budgetField,
    }),
    async plan(input, tools) {
      assertSingleBudget(input.dailyBudget, input.lifetimeBudget);
      const adSet = await authorizeAdSet(tools.ctx, tools.account, input.adSetId);

      // Only when money is involved: a status change on a CBO ad set is a
      // legitimate, separate request and must keep working. The parent read is
      // cached, so asking for it costs nothing on a repeat.
      const touchesBudget = input.dailyBudget !== undefined || input.lifetimeBudget !== undefined;
      const adSetHasItsOwnBudget = adSet.dailyBudget !== null || adSet.lifetimeBudget !== null;
      if (touchesBudget && !adSetHasItsOwnBudget && adSet.campaignId) {
        const parent = await authorizeCampaign(tools.ctx, tools.account, adSet.campaignId);
        if (campaignHoldsTheBudget(parent)) refuseAdSetBudgetUnderCbo(parent, tools.account.currency);
      }

      // The chain, top to bottom, so the card shows what is being changed AND
      // what prompted it. An ad named here is re-authorized and checked to
      // actually sit in this ad set: a card that claims a relationship Meta
      // does not report would be worse than one that omits it.
      const fields: ConfirmationField[] = [];
      if (input.becauseOfAdId) {
        const ad = await authorizeAd(tools.ctx, tools.account, input.becauseOfAdId);
        if (ad.adSetId !== adSet.id) {
          throw new DashboardError(
            "invalid_request",
            400,
            `Ad ${ad.id} does not belong to ad set ${adSet.id}. Read the ad first and use the adSetId it reports.`,
          );
        }
        fields.push({ label: "Reklam", value: sanitizeLabel(ad.name) });
      }
      const body: Record<string, string> = {};
      fields.push({ label: "Reklam seti", value: sanitizeLabel(adSet.name) });
      if (adSet.campaignName) {
        fields.push({ label: "Kampanya", value: sanitizeLabel(adSet.campaignName) });
      }
      /** Rows added above describe the object; only what follows is a change. */
      const contextRows = fields.length;
      if (input.name !== undefined) {
        body.name = input.name;
        fields.push({ label: "Yeni ad", value: input.name });
      }
      if (input.status !== undefined) {
        body.status = input.status;
        fields.push({ label: "Yeni durum", value: STATUS_LABEL[input.status] ?? input.status });
      }
      if (input.dailyBudget !== undefined) {
        body.daily_budget = toMinorUnits(input.dailyBudget);
        fields.push({
          label: "Yeni günlük bütçe",
          value: `${money(input.dailyBudget, tools.account.currency)}${adSet.dailyBudget !== null ? ` (önce ${money(adSet.dailyBudget, tools.account.currency)})` : ""}`,
        });
      }
      if (input.lifetimeBudget !== undefined) {
        body.lifetime_budget = toMinorUnits(input.lifetimeBudget);
        fields.push({ label: "Yeni toplam bütçe", value: money(input.lifetimeBudget, tools.account.currency) });
      }
      requireSomething(fields.slice(contextRows), "ad set");

      return {
        tool: "meta_update_ad_set",
        title: "Reklam seti güncellenecek",
        description: "Onaylarsanız bu değişiklik Meta'ya gönderilir.",
        reason: sanitizeLine(input.reason, MAX_REASON_CHARS),
        risk: input.risk ? sanitizeLine(input.risk, MAX_REASON_CHARS) : null,
        confidence: input.confidence ?? null,
        fields,
        path: `/${adSet.id}`,
        body,
        expected: snapshotOf(adSet, body),
        verify: { kind: "existing", id: adSet.id, level: "adset" },
      };
    },
  }),

  writeTool({
    name: "meta_create_ad",
    description:
      "Propose creating an ad inside an ad set from an existing creative. The creative must already exist in the account — this tool does not upload media. Nothing is sent to Meta until the user approves.",
    schema: z.object({
      reason: reasonField,
      risk: riskField,
      confidence: confidenceField,
      adSetId: entityIdSchema,
      name: nameField,
      creativeId: entityIdSchema.describe("Id of a creative that already exists in this ad account."),
      status: z.enum(STATUS_VALUES).optional(),
    }),
    async plan(input, tools) {
      const adSet = await authorizeAdSet(tools.ctx, tools.account, input.adSetId);
      const status = input.status ?? "PAUSED";
      return {
        tool: "meta_create_ad",
        title: "Meta'da yeni reklam oluşturulacak",
        description: "Onaylarsanız bu reklam, seçili reklam setinin altında oluşturulur.",
        reason: sanitizeLine(input.reason, MAX_REASON_CHARS),
        risk: input.risk ? sanitizeLine(input.risk, MAX_REASON_CHARS) : null,
        confidence: input.confidence ?? null,
        fields: [
          { label: "Reklam adı", value: input.name },
          { label: "Reklam seti", value: sanitizeLabel(adSet.name) },
          { label: "Kreatif kimliği", value: input.creativeId },
          { label: "Başlangıç durumu", value: STATUS_LABEL[status] ?? status },
        ],
        path: `/${tools.account.id}/ads`,
        body: {
          name: input.name,
          adset_id: adSet.id,
          status,
          creative: JSON.stringify({ creative_id: input.creativeId }),
        },
        expected: {},
        verify: { kind: "created", id: null, level: "ad" },
      };
    },
  }),

  writeTool({
    name: "meta_update_ad",
    description:
      "Propose changing an existing ad: rename it, or pause or activate it. Nothing is sent to Meta until the user approves.",
    schema: z.object({
      reason: reasonField,
      risk: riskField,
      confidence: confidenceField,
      adId: entityIdSchema,
      name: nameField.optional(),
      status: z.enum(STATUS_VALUES).optional(),
    }),
    async plan(input, tools) {
      const ad = await authorizeAd(tools.ctx, tools.account, input.adId);
      const body: Record<string, string> = {};
      const fields: ConfirmationField[] = [{ label: "Reklam", value: sanitizeLabel(ad.name) }];
      if (input.name !== undefined) {
        body.name = input.name;
        fields.push({ label: "Yeni ad", value: input.name });
      }
      if (input.status !== undefined) {
        body.status = input.status;
        fields.push({ label: "Yeni durum", value: STATUS_LABEL[input.status] ?? input.status });
      }
      requireSomething(fields.slice(1), "ad");

      return {
        tool: "meta_update_ad",
        title: "Reklam güncellenecek",
        description: "Onaylarsanız bu değişiklik Meta'ya gönderilir.",
        reason: sanitizeLine(input.reason, MAX_REASON_CHARS),
        risk: input.risk ? sanitizeLine(input.risk, MAX_REASON_CHARS) : null,
        confidence: input.confidence ?? null,
        fields,
        path: `/${ad.id}`,
        body,
        expected: snapshotOf(ad, body),
        verify: { kind: "existing", id: ad.id, level: "ad" },
      };
    },
  }),
];

// ─── Execution of an approved plan ───────────────────────────────

const VERIFY_FIELDS = "id,name,status,effective_status,daily_budget,lifetime_budget";

/**
 * Send an approved plan to Meta, then read the object back.
 *
 * The read-back is the point: Meta accepts a write and then decides what the
 * object actually looks like (a budget can be clamped, a status can land as
 * WITH_ISSUES). Reporting the echoed request instead of the stored object would
 * tell the user something that is not true.
 */
export class StaleWriteError extends DashboardError {
  constructor(
    readonly field: string,
    readonly approved: string | number | null,
    readonly current: string | number | null,
  ) {
    super(
      "ai_write_stale",
      409,
      "Bu nesne, öneri hazırlandıktan sonra Meta tarafında değişti. Hiçbir şey gönderilmedi — " +
        "güncel değerlerle yeniden sorun.",
    );
  }
}

/** Is what Meta holds now still what the user approved against? */
function driftOf(
  expected: Record<string, string | number | null>,
  fresh: Record<string, unknown>,
): { field: string; approved: string | number | null; current: string | number | null } | null {
  for (const [field, approved] of Object.entries(expected)) {
    const raw = fresh[field];
    // Budgets come back in minor units; the snapshot holds major, like the UI.
    const current =
      field === "daily_budget" || field === "lifetime_budget"
        ? minorToMajor(raw)
        : typeof raw === "string"
          ? raw
          : null;
    if (current !== approved) return { field, approved, current };
  }
  return null;
}

export async function applyWritePlan(plan: WritePlan): Promise<{
  id: string | null;
  verified: Record<string, string | number | boolean | null>;
  verificationFailed: boolean;
}> {
  // Re-read before writing, not after. An approval can be ten minutes old, and
  // in that window a colleague in Ads Manager, another session or an automated
  // rule can have moved the same budget. Writing blind would overwrite their
  // change with a number the user approved against a world that no longer
  // exists — so a mismatch stops here, before anything is sent.
  if (plan.verify.kind === "existing" && plan.verify.id && Object.keys(plan.expected).length > 0) {
    const current = await metaApiClient.get<Record<string, unknown>>(`/${plan.verify.id}`, {
      fields: VERIFY_FIELDS,
    });
    const drift = driftOf(plan.expected, current);
    if (drift) throw new StaleWriteError(drift.field, drift.approved, drift.current);
  }

  const result = await metaApiClient.postForm<{ id?: string; success?: boolean }>(plan.path, plan.body);
  const id = plan.verify.kind === "created" ? (result.id ?? null) : plan.verify.id;
  if (!id) return { id: null, verified: {}, verificationFailed: true };

  try {
    const fresh = await metaApiClient.get<Record<string, unknown>>(`/${id}`, { fields: VERIFY_FIELDS });
    return {
      id,
      verified: {
        id: typeof fresh.id === "string" ? fresh.id : id,
        name: typeof fresh.name === "string" ? sanitizeLabel(fresh.name) : null,
        status: typeof fresh.status === "string" ? fresh.status : null,
        effectiveStatus: typeof fresh.effective_status === "string" ? fresh.effective_status : null,
        dailyBudget: minorToMajor(fresh.daily_budget),
        lifetimeBudget: minorToMajor(fresh.lifetime_budget),
      },
      verificationFailed: false,
    };
  } catch {
    // The write landed; only the confirmation read failed. Say so rather than
    // claiming a result we did not observe.
    return { id, verified: { id }, verificationFailed: true };
  }
}

function minorToMajor(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed / 100 : null;
}

// ─── Anthropic tool definitions ──────────────────────────────────

/**
 * Zod is the single source of truth for every tool's arguments: the JSON
 * Schema Claude sees is generated from the same schema that validates the
 * arguments when they come back, so the two can never drift apart.
 */
function toAnthropicTool(tool: { name: string; description: string; schema: z.ZodType }): Anthropic.Tool {
  const schema = z.toJSONSchema(tool.schema, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { ...schema, type: "object" } as Anthropic.Tool.InputSchema,
  };
}

export function buildToolDefinitions(options: { allowWrites: boolean }): Anthropic.Tool[] {
  const tools = options.allowWrites ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  return tools.map(toAnthropicTool);
}

export const READ_TOOLS_BY_NAME = new Map(READ_TOOLS.map((tool) => [tool.name, tool]));
export const WRITE_TOOLS_BY_NAME = new Map(WRITE_TOOLS.map((tool) => [tool.name, tool]));

