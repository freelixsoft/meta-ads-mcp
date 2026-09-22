import { metaApiClient } from "../../meta/client.js";
import { validateMetaId } from "../../utils/format.js";
import { CACHE_TTL_MS, cacheKey, dashboardCache } from "../cache.js";
import { DashboardError, toDashboardError, type DashboardErrorCode } from "../errors.js";
import type { AdAccountDto, EntityLevel } from "../dto.js";
import type { DashboardContext } from "./accounts.js";

/**
 * An entity resolved from Meta and proven to belong to the authorized account.
 *
 * Nothing downstream accepts a bare id: every account-scoped route turns the
 * caller's id into one of these first, which is where ownership is decided.
 */
export interface EntityRef {
  id: string;
  level: EntityLevel;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  objective: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adSetId: string | null;
  adSetName: string | null;
  creativeId: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
}

interface RawEntity {
  id?: unknown;
  name?: unknown;
  account_id?: unknown;
  status?: unknown;
  effective_status?: unknown;
  objective?: unknown;
  campaign_id?: unknown;
  adset_id?: unknown;
  daily_budget?: unknown;
  lifetime_budget?: unknown;
  campaign?: { id?: unknown; name?: unknown };
  adset?: { id?: unknown; name?: unknown };
  creative?: { id?: unknown };
}

const CAMPAIGN_REF_FIELDS =
  "id,name,account_id,status,effective_status,objective,daily_budget,lifetime_budget";
const ADSET_REF_FIELDS =
  "id,name,account_id,status,effective_status,campaign_id,campaign{id,name},daily_budget,lifetime_budget";
const AD_REF_FIELDS =
  "id,name,account_id,status,effective_status,adset_id,campaign_id,adset{id,name},campaign{id,name},creative{id}";

const ADSET_LIST_FIELDS =
  "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget";
const AD_LIST_FIELDS = "id,name,status,effective_status,adset_id,campaign_id,creative{id}";

/**
 * The account-wide variants expand the parent, which the per-parent edges do
 * not need: when rows from the whole account are mixed together, "which
 * campaign is this ad set in" stops being obvious from context.
 */
const ACCOUNT_ADSET_LIST_FIELDS =
  "id,name,status,effective_status,campaign_id,campaign{id,name},daily_budget,lifetime_budget";
const ACCOUNT_AD_LIST_FIELDS =
  "id,name,status,effective_status,adset_id,campaign_id,adset{id,name},campaign{id,name},creative{id}";

const MAX_ROWS = 500;

/** Failures that describe the connection, not the object, and must keep their own status. */
const PASS_THROUGH_CODES: ReadonlySet<DashboardErrorCode> = new Set([
  "meta_connection_expired",
  "meta_not_connected",
  "meta_rate_limited",
  "rate_limited",
]);

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Meta reports budgets in minor units (kuruş, cents); the browser only sees major units. */
export function minorUnitsToMajor(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) ? parsed / 100 : null;
}

function toRef(raw: RawEntity, level: EntityLevel): EntityRef {
  return {
    id: str(raw.id) ?? "",
    level,
    name: str(raw.name) ?? "(isimsiz)",
    status: str(raw.status),
    effectiveStatus: str(raw.effective_status),
    objective: str(raw.objective),
    campaignId: str(raw.campaign?.id) ?? str(raw.campaign_id),
    campaignName: str(raw.campaign?.name),
    adSetId: str(raw.adset?.id) ?? str(raw.adset_id),
    adSetName: str(raw.adset?.name),
    creativeId: str(raw.creative?.id),
    dailyBudget: minorUnitsToMajor(raw.daily_budget),
    lifetimeBudget: minorUnitsToMajor(raw.lifetime_budget),
  };
}

const LEVEL_LABEL: Record<Exclude<EntityLevel, "account">, string> = {
  campaign: "campaign",
  adset: "ad set",
  ad: "ad",
};

/**
 * Resolve an id supplied by the browser into an entity owned by the authorized
 * account.
 *
 * Two gates, in order:
 *
 *  1. `validateMetaId` — the id is interpolated into a Graph path, so anything
 *     that is not a bare numeric id is rejected before a request is built.
 *  2. Ownership is decided on Meta's own answer, never on caller input: the
 *     `account_id` Meta returns for the object must equal the account already
 *     authorized for this request. A token that can reach two accounts
 *     therefore still cannot read account B's ad sets through an account A
 *     URL. An object the token cannot see at all errors inside Meta, which
 *     reveals nothing the same token could not already learn by calling Graph
 *     directly.
 */
async function resolveEntity(
  ctx: DashboardContext,
  account: AdAccountDto,
  level: Exclude<EntityLevel, "account">,
  rawId: string,
  fields: string,
): Promise<EntityRef> {
  let id: string;
  try {
    id = validateMetaId(rawId, LEVEL_LABEL[level]);
  } catch {
    throw new DashboardError(
      "invalid_request",
      400,
      `Invalid ${LEVEL_LABEL[level]} id.`,
    );
  }

  const key = cacheKey({
    fbUserId: ctx.fbUserId,
    tokenHash: ctx.tokenHash,
    endpoint: `entity:${level}`,
    params: { account: account.id, id },
  });

  return dashboardCache.getOrLoad(key, CACHE_TTL_MS.campaigns, async () => {
    let raw: RawEntity;
    try {
      raw = await metaApiClient.get<RawEntity>(`/${id}`, { fields });
    } catch (error) {
      // A dead token or a throttle is not an authorization verdict about this
      // object, and collapsing them into 403 would tell the user to pick a
      // different ad set when the real fix is reconnecting Meta or waiting.
      const classified = toDashboardError(error);
      if (PASS_THROUGH_CODES.has(classified.code)) throw classified;

      // Everything else — unknown id, or one this token cannot see — is
      // indistinguishable from "not yours" and is answered identically, so the
      // endpoint cannot be used to probe for which ids exist.
      throw new DashboardError(
        "account_forbidden",
        403,
        `This ${LEVEL_LABEL[level]} is not accessible with the connected Meta user.`,
        { cause: error },
      );
    }

    const owner = str(raw.account_id);
    if (!owner || `act_${owner}` !== account.id) {
      throw new DashboardError(
        "account_forbidden",
        403,
        `This ${LEVEL_LABEL[level]} does not belong to the selected ad account.`,
      );
    }
    return toRef(raw, level);
  });
}

export function authorizeCampaign(
  ctx: DashboardContext,
  account: AdAccountDto,
  campaignId: string,
): Promise<EntityRef> {
  return resolveEntity(ctx, account, "campaign", campaignId, CAMPAIGN_REF_FIELDS);
}

export function authorizeAdSet(
  ctx: DashboardContext,
  account: AdAccountDto,
  adSetId: string,
): Promise<EntityRef> {
  return resolveEntity(ctx, account, "adset", adSetId, ADSET_REF_FIELDS);
}

export function authorizeAd(
  ctx: DashboardContext,
  account: AdAccountDto,
  adId: string,
): Promise<EntityRef> {
  return resolveEntity(ctx, account, "ad", adId, AD_REF_FIELDS);
}

/** Ad sets belonging to one campaign, metadata only. */
export function listAdSetsOfCampaign(
  ctx: DashboardContext,
  account: AdAccountDto,
  campaign: EntityRef,
): Promise<EntityRef[]> {
  return dashboardCache.getOrLoad(
    cacheKey({
      fbUserId: ctx.fbUserId,
      tokenHash: ctx.tokenHash,
      endpoint: "adsets",
      params: { account: account.id, campaign: campaign.id },
    }),
    CACHE_TTL_MS.campaigns,
    async () => {
      const rows = await metaApiClient.getPaginated<RawEntity>(
        `/${campaign.id}/adsets`,
        { fields: ADSET_LIST_FIELDS, limit: 200 },
        MAX_ROWS,
      );
      return rows.map((raw) => {
        const ref = toRef(raw, "adset");
        // The list edge does not expand the parent, but every row on it belongs
        // to the campaign we just authorized.
        return { ...ref, campaignId: campaign.id, campaignName: campaign.name };
      });
    },
  );
}

/**
 * Every ad set in the account, metadata only.
 *
 * Exists so a question like "which ad set should I pause?" is one read rather
 * than a walk down the tree: campaign list, then a list per campaign, then a
 * list per ad set is dozens of calls against a shared Meta quota, and on a real
 * account it exhausts the agent's tool budget before it has seen anything.
 */
export function listAdSetsOfAccount(
  ctx: DashboardContext,
  account: AdAccountDto,
): Promise<EntityRef[]> {
  return dashboardCache.getOrLoad(
    cacheKey({
      fbUserId: ctx.fbUserId,
      tokenHash: ctx.tokenHash,
      endpoint: "account-adsets",
      params: { account: account.id },
    }),
    CACHE_TTL_MS.campaigns,
    async () => {
      const rows = await metaApiClient.getPaginated<RawEntity>(
        `/${account.id}/adsets`,
        { fields: ACCOUNT_ADSET_LIST_FIELDS, limit: 200 },
        MAX_ROWS,
      );
      return rows.map((raw) => toRef(raw, "adset"));
    },
  );
}

/** Every ad in the account, metadata only. Same reasoning as listAdSetsOfAccount. */
export function listAdsOfAccount(
  ctx: DashboardContext,
  account: AdAccountDto,
): Promise<EntityRef[]> {
  return dashboardCache.getOrLoad(
    cacheKey({
      fbUserId: ctx.fbUserId,
      tokenHash: ctx.tokenHash,
      endpoint: "account-ads",
      params: { account: account.id },
    }),
    CACHE_TTL_MS.campaigns,
    async () => {
      const rows = await metaApiClient.getPaginated<RawEntity>(
        `/${account.id}/ads`,
        { fields: ACCOUNT_AD_LIST_FIELDS, limit: 200 },
        MAX_ROWS,
      );
      return rows.map((raw) => toRef(raw, "ad"));
    },
  );
}

/** Ads belonging to one ad set, metadata only. */
export function listAdsOfAdSet(
  ctx: DashboardContext,
  account: AdAccountDto,
  adSet: EntityRef,
): Promise<EntityRef[]> {
  return dashboardCache.getOrLoad(
    cacheKey({
      fbUserId: ctx.fbUserId,
      tokenHash: ctx.tokenHash,
      endpoint: "ads",
      params: { account: account.id, adset: adSet.id },
    }),
    CACHE_TTL_MS.campaigns,
    async () => {
      const rows = await metaApiClient.getPaginated<RawEntity>(
        `/${adSet.id}/ads`,
        { fields: AD_LIST_FIELDS, limit: 200 },
        MAX_ROWS,
      );
      return rows.map((raw) => {
        const ref = toRef(raw, "ad");
        return {
          ...ref,
          adSetId: adSet.id,
          adSetName: adSet.name,
          campaignId: adSet.campaignId ?? ref.campaignId,
          campaignName: adSet.campaignName,
        };
      });
    },
  );
}
