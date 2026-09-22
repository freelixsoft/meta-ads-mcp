import { metaApiClient } from "../../meta/client.js";
import { CAMPAIGN_DEFAULT_FIELDS } from "../../meta/types/campaign.js";
import type { Campaign } from "../../meta/types/index.js";
import { CACHE_TTL_MS, cacheKey, dashboardCache } from "../cache.js";
import type { AdAccountDto, CampaignDto, CampaignsResponseDto } from "../dto.js";
import type { CampaignQueryInput, ResolvedRange } from "../schemas.js";
import { deriveMetrics, EMPTY_METRICS, toNumber } from "./metrics.js";
import { getCampaignInsightRows } from "./insights.js";
import type { DashboardContext } from "./accounts.js";
import { foldForSearch } from "../search.js";

const MAX_CAMPAIGNS = 500;

/**
 * Budgets come back from Meta in minor units (kuruş for a TRY account, cents
 * for USD). Converted once here so the browser only ever sees major units and
 * never has to know the divisor.
 */
function minorUnitsToMajor(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed === null ? null : parsed / 100;
}

async function listCampaigns(
  ctx: DashboardContext,
  account: AdAccountDto,
): Promise<Campaign[]> {
  return dashboardCache.getOrLoad(
    cacheKey({
      fbUserId: ctx.fbUserId,
      tokenHash: ctx.tokenHash,
      endpoint: "campaigns",
      params: { account: account.id },
    }),
    CACHE_TTL_MS.campaigns,
    async () =>
      metaApiClient.getPaginated<Campaign>(
        `/${account.id}/campaigns`,
        { fields: [...CAMPAIGN_DEFAULT_FIELDS].join(","), limit: 200 },
        MAX_CAMPAIGNS,
      ),
  );
}

export function filterCampaigns(
  campaigns: CampaignDto[],
  query: Pick<CampaignQueryInput, "status" | "q">,
): CampaignDto[] {
  const rawNeedle = query.q?.trim();
  const needle = rawNeedle ? foldForSearch(rawNeedle) : undefined;
  return campaigns.filter((campaign) => {
    if (query.status !== "ALL" && campaign.status !== query.status) return false;
    if (needle && !foldForSearch(campaign.name).includes(needle)) return false;
    return true;
  });
}

/**
 * Campaign metadata joined to campaign-level insights, server-side.
 *
 * Campaigns with no delivery in the range are kept with zeroed metrics rather
 * than dropped — a paused campaign disappearing from the table reads as data
 * loss, not as a filter.
 */
export async function getCampaignsWithMetrics(
  ctx: DashboardContext,
  account: AdAccountDto,
  range: ResolvedRange,
  query: Pick<CampaignQueryInput, "status" | "q">,
): Promise<CampaignsResponseDto> {
  const [campaigns, insightsByCampaign] = await Promise.all([
    listCampaigns(ctx, account),
    getCampaignInsightRows(ctx, account, range),
  ]);

  const merged: CampaignDto[] = campaigns.map((campaign) => {
    const row = insightsByCampaign.get(campaign.id);
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      effectiveStatus: campaign.effective_status ?? null,
      objective: campaign.objective ?? null,
      dailyBudget: minorUnitsToMajor(campaign.daily_budget),
      lifetimeBudget: minorUnitsToMajor(campaign.lifetime_budget),
      metrics: row ? deriveMetrics(row) : { ...EMPTY_METRICS },
    };
  });

  merged.sort((a, b) => b.metrics.spend - a.metrics.spend);

  return {
    account: { id: account.id, name: account.name, currency: account.currency },
    range: { preset: range.label, since: range.since, until: range.until },
    campaigns: filterCampaigns(merged, query),
  };
}
