import { metaApiClient } from "../../meta/client.js";
import type { MetaApiResponse } from "../../meta/types/index.js";
import { enforceInsightsGuardrails } from "../../tools/insights-guardrails.js";
import { CACHE_TTL_MS, cacheKey, dashboardCache } from "../cache.js";
import type {
  AdAccountDto,
  ComparisonDto,
  EntityInsightsResponseDto,
  EntityLevel,
  EntityRowDto,
  MetricsDto,
  SeriesPointDto,
} from "../dto.js";
import type { ResolvedRange } from "../schemas.js";
import { previousPeriod, resolvePresetDates, type ConcreteRange } from "../date-range.js";
import { buildInsightsParams, DASHBOARD_INSIGHTS_FIELDS, toSeriesPoint } from "./insights.js";
import { deriveMetrics, EMPTY_METRICS, type InsightsRowLike } from "./metrics.js";
import { compareMetrics, LOWER_IS_BETTER } from "./comparison.js";
import type { EntityRef } from "./entities.js";
import type { DashboardContext } from "./accounts.js";

/**
 * Meta's insights `level` values differ from our entity vocabulary in one
 * place: we say "adset", the API says "adset" for the level but nests rows
 * under `adset_id`. Kept as an explicit map so a rename on either side is a
 * compile error rather than a silent empty table.
 */
const META_LEVEL: Record<EntityLevel, string> = {
  account: "account",
  campaign: "campaign",
  adset: "adset",
  ad: "ad",
};

/** The id field Meta stamps on each row, by level, used to join metrics to metadata. */
const ROW_ID_FIELD: Record<Exclude<EntityLevel, "account">, string> = {
  campaign: "campaign_id",
  adset: "adset_id",
  ad: "ad_id",
};

function guard(range: ResolvedRange, level: EntityLevel): void {
  enforceInsightsGuardrails({
    level: META_LEVEL[level],
    breakdowns: [],
    date_preset: range.datePreset ?? undefined,
    time_range: range.timeRange ?? undefined,
    is_async: false,
  });
}

/**
 * The dates the range actually covers.
 *
 * Meta stamps every insights row with the `date_start`/`date_stop` it resolved
 * the preset to, in the ad account's timezone — that is authoritative and is
 * used whenever a row came back. `resolvePresetDates` only covers the case
 * where the period returned nothing at all, which is precisely when the
 * comparison is most worth showing ("we spent nothing this period, unlike
 * last"), so falling back is better than dropping it.
 */
function resolveConcreteRange(
  range: ResolvedRange,
  account: AdAccountDto,
  summaryRow: InsightsRowLike | undefined,
): ConcreteRange {
  if (range.timeRange) return range.timeRange;
  const since = typeof summaryRow?.date_start === "string" ? summaryRow.date_start : null;
  const until = typeof summaryRow?.date_stop === "string" ? summaryRow.date_stop : null;
  if (since && until) return { since, until };
  return resolvePresetDates(range.datePreset ?? "last_30d", account.timezone);
}

async function fetchSummaryRow(
  path: string,
  params: Record<string, string | number | boolean>,
): Promise<InsightsRowLike | undefined> {
  const response = await metaApiClient.get<MetaApiResponse<InsightsRowLike>>(path, params);
  return response.data?.[0];
}

/**
 * Summary, daily series and (optionally) the previous-period comparison for
 * one entity at any level.
 *
 * The comparison costs one extra Meta call, so it is opt-in: the drill-down
 * tables never ask for it, only the overview and the detail drawer do. The
 * shared Meta quota is the reason — see docs/dashboard.md.
 */
export async function getEntityInsights(
  ctx: DashboardContext,
  account: AdAccountDto,
  entity: EntityRef,
  range: ResolvedRange,
  options: { compare: boolean; includeSeries?: boolean },
): Promise<EntityInsightsResponseDto> {
  guard(range, entity.level);

  // The daily series is a second, paginated Meta call. Every browser surface
  // needs it — the overview chart, the detail drawer — so it stays the
  // default. The agent's comparison and *_detail tools do not render a chart
  // and discarded it, which was a wasted call against a quota shared with the
  // MCP tools on every one of those questions.
  const includeSeries = options.includeSeries !== false;

  const key = cacheKey({
    fbUserId: ctx.fbUserId,
    tokenHash: ctx.tokenHash,
    endpoint: `entity-insights:${entity.level}`,
    params: {
      account: account.id,
      id: entity.id,
      preset: range.label,
      since: range.since,
      until: range.until,
      compare: options.compare,
      series: includeSeries,
    },
  });

  return dashboardCache.getOrLoad(key, CACHE_TTL_MS.insights, async () => {
    const path = `/${entity.id}/insights`;
    const level = META_LEVEL[entity.level];

    // Two calls rather than one: `reach` counts unique people, so summing a
    // time_increment=1 series over-reports it badly on longer ranges. The
    // unsegmented call is the only correct source for the summary.
    const [summaryRow, seriesResponse] = await Promise.all([
      fetchSummaryRow(path, buildInsightsParams(range, { level, limit: 1 })),
      includeSeries
        ? metaApiClient.get<MetaApiResponse<InsightsRowLike>>(
            path,
            buildInsightsParams(range, { level, time_increment: 1, limit: 400 }),
          )
        : Promise.resolve({ data: [] as InsightsRowLike[] } as MetaApiResponse<InsightsRowLike>),
    ]);

    const summary = deriveMetrics(summaryRow ?? {});
    const resolvedRange = resolveConcreteRange(range, account, summaryRow);

    const series: SeriesPointDto[] = (seriesResponse.data ?? [])
      .map(toSeriesPoint)
      .filter((point) => point.date !== "")
      .sort((a, b) => a.date.localeCompare(b.date));

    let comparison: ComparisonDto | null = null;
    if (options.compare) {
      const previousRange = previousPeriod(resolvedRange);
      const previousRow = await fetchSummaryRow(path, {
        ...buildInsightsParams(
          { datePreset: null, timeRange: previousRange, label: "custom", since: previousRange.since, until: previousRange.until },
          { level, limit: 1 },
        ),
      });
      const previous = previousRow ? deriveMetrics(previousRow) : { ...EMPTY_METRICS };
      comparison = {
        range: previousRange,
        previous,
        changes: compareMetrics(summary, previous),
        lowerIsBetter: [...LOWER_IS_BETTER],
      };
    }

    return {
      account: { id: account.id, name: account.name, currency: account.currency },
      entity: {
        id: entity.id,
        level: entity.level,
        name: entity.name,
        status: entity.status,
        effectiveStatus: entity.effectiveStatus,
        objective: entity.objective,
        campaignId: entity.campaignId,
        campaignName: entity.campaignName,
        adSetId: entity.adSetId,
        adSetName: entity.adSetName,
        creativeId: entity.creativeId,
        dailyBudget: entity.dailyBudget,
        lifetimeBudget: entity.lifetimeBudget,
      },
      range: { preset: range.label, since: range.since, until: range.until },
      resolvedRange,
      summary,
      comparison,
      series,
    };
  });
}

/**
 * Child-level rows for one parent, with metrics joined on.
 *
 * Children with no delivery in the range are kept with zeroed metrics rather
 * than dropped — a paused ad set disappearing from the table reads as data
 * loss, not as a filter.
 */
export async function getChildRows(
  ctx: DashboardContext,
  account: AdAccountDto,
  parent: EntityRef,
  childLevel: Exclude<EntityLevel, "account">,
  range: ResolvedRange,
  children: EntityRef[],
): Promise<EntityRowDto[]> {
  guard(range, childLevel);

  const metricsById = await dashboardCache.getOrLoad(
    cacheKey({
      fbUserId: ctx.fbUserId,
      tokenHash: ctx.tokenHash,
      endpoint: `child-insights:${childLevel}`,
      params: {
        account: account.id,
        parent: parent.id,
        preset: range.label,
        since: range.since,
        until: range.until,
      },
    }),
    CACHE_TTL_MS.insights,
    async () => {
      const rows = await metaApiClient.getPaginated<InsightsRowLike>(
        `/${parent.id}/insights`,
        buildInsightsParams(range, {
          level: META_LEVEL[childLevel],
          // Meta only stamps the child id on the row when it is asked for.
          fields: [ROW_ID_FIELD[childLevel], ...DASHBOARD_INSIGHTS_FIELDS].join(","),
          limit: 200,
        }),
        1000,
      );
      const idField = ROW_ID_FIELD[childLevel];
      const byId = new Map<string, MetricsDto>();
      for (const row of rows) {
        const id = row[idField];
        if (typeof id === "string" && id.length > 0) byId.set(id, deriveMetrics(row));
      }
      return byId;
    },
  );

  return children.map((child) => ({
    id: child.id,
    level: child.level,
    name: child.name,
    status: child.status ?? "UNKNOWN",
    effectiveStatus: child.effectiveStatus,
    objective: child.objective,
    campaignId: child.campaignId,
    campaignName: child.campaignName,
    adSetId: child.adSetId,
    adSetName: child.adSetName,
    creativeId: child.creativeId,
    dailyBudget: child.dailyBudget,
    lifetimeBudget: child.lifetimeBudget,
    metrics: metricsById.get(child.id) ?? { ...EMPTY_METRICS },
  }));
}

/**
 * Account-level insights.
 *
 * A thin wrapper over the entity path with a synthetic account-level ref, so
 * the overview, a campaign, an ad set and an ad all go through exactly one
 * implementation of summary / series / comparison. The response therefore also
 * carries an `entity` block describing the account, which is additive over the
 * Phase 1 shape.
 */
export function getAccountInsights(
  ctx: DashboardContext,
  account: AdAccountDto,
  range: ResolvedRange,
  options: { compare: boolean; includeSeries?: boolean } = { compare: false },
): Promise<EntityInsightsResponseDto> {
  return getEntityInsights(ctx, account, accountEntityRef(account), range, options);
}

/**
 * The account as an `EntityRef`, so account-wide reads go through exactly the
 * same code path as a campaign or an ad set instead of growing a parallel one.
 */
export function accountEntityRef(account: AdAccountDto): EntityRef {
  return {
    id: account.id,
    level: "account",
    name: account.name,
    status: account.status,
    effectiveStatus: null,
    objective: null,
    campaignId: null,
    campaignName: null,
    adSetId: null,
    adSetName: null,
    creativeId: null,
    dailyBudget: null,
    lifetimeBudget: null,
  };
}
