import { metaApiClient } from "../../meta/client.js";
import {
  applyAttributionDefault,
  enforceInsightsGuardrails,
} from "../../tools/insights-guardrails.js";
import { CACHE_TTL_MS, cacheKey, dashboardCache } from "../cache.js";
import type { AdAccountDto, SeriesPointDto } from "../dto.js";
import type { ResolvedRange } from "../schemas.js";
import { deriveMetrics, type InsightsRowLike } from "./metrics.js";
import type { DashboardContext } from "./accounts.js";

/**
 * Fields the dashboard needs beyond the MCP default set: action_values and
 * purchase_roas are what make revenue and ROAS derivable at all.
 */
export const DASHBOARD_INSIGHTS_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "actions",
  "action_values",
  "cost_per_action_type",
  "purchase_roas",
] as const;

export function buildInsightsParams(
  range: ResolvedRange,
  extra: Record<string, string | number | boolean> = {},
): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    fields: [...DASHBOARD_INSIGHTS_FIELDS].join(","),
    ...extra,
  };
  // Matches the MCP tools' default so dashboard numbers and agent numbers
  // agree with Ads Manager (Meta change effective 2025-06-10).
  applyAttributionDefault(params, true);
  if (range.datePreset) params.date_preset = range.datePreset;
  if (range.timeRange) params.time_range = JSON.stringify(range.timeRange);
  return params;
}

function guard(range: ResolvedRange, level: string): void {
  enforceInsightsGuardrails({
    level,
    breakdowns: [],
    date_preset: range.datePreset ?? undefined,
    time_range: range.timeRange ?? undefined,
    is_async: false,
  });
}

/** Shared with the entity-level drill-down so every series has identical shape. */
export function toSeriesPoint(row: InsightsRowLike): SeriesPointDto {
  const metrics = deriveMetrics(row);
  return {
    date: typeof row.date_start === "string" ? row.date_start : "",
    spend: metrics.spend,
    impressions: metrics.impressions,
    clicks: metrics.clicks,
    purchases: metrics.purchases,
    purchaseValue: metrics.purchaseValue,
  };
}

export async function getCampaignInsightRows(
  ctx: DashboardContext,
  account: AdAccountDto,
  range: ResolvedRange,
): Promise<Map<string, InsightsRowLike>> {
  guard(range, "campaign");

  const key = cacheKey({
    fbUserId: ctx.fbUserId,
    tokenHash: ctx.tokenHash,
    endpoint: "campaign-insights",
    params: { account: account.id, preset: range.label, since: range.since, until: range.until },
  });

  return dashboardCache.getOrLoad(key, CACHE_TTL_MS.insights, async () => {
    const rows = await metaApiClient.getPaginated<InsightsRowLike>(
      `/${account.id}/insights`,
      buildInsightsParams(range, {
        level: "campaign",
        fields: ["campaign_id", ...DASHBOARD_INSIGHTS_FIELDS].join(","),
        limit: 200,
      }),
      1000,
    );

    const byCampaign = new Map<string, InsightsRowLike>();
    for (const row of rows) {
      const id = typeof row.campaign_id === "string" ? row.campaign_id : null;
      if (id) byCampaign.set(id, row);
    }
    return byCampaign;
  });
}

