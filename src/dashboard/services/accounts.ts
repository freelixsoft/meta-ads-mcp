import { metaApiClient } from "../../meta/client.js";
import { AD_ACCOUNT_DEFAULT_FIELDS } from "../../meta/types/account.js";
import type { AdAccount } from "../../meta/types/index.js";
import { accountStatusFromCode, type AdAccountDto } from "../dto.js";
import { CACHE_TTL_MS, cacheKey, dashboardCache } from "../cache.js";
import { DashboardError } from "../errors.js";

/** Identity of the caller, used for cache partitioning. Never carries the token itself. */
export interface DashboardContext {
  fbUserId: string;
  tokenHash: string;
}

/**
 * Ceiling on the accounts collected from /me/adaccounts. This list is the
 * authorization set, so a truncated read would deny a legitimate account
 * rather than leak one — the failure mode is safe, but the ceiling is high
 * enough that no real agency reaches it.
 */
const MAX_ACCOUNTS = 1000;

function toAdAccountDto(raw: AdAccount): AdAccountDto {
  return {
    id: raw.id?.startsWith("act_") ? raw.id : `act_${raw.account_id}`,
    accountId: raw.account_id,
    name: raw.name,
    status: accountStatusFromCode(raw.account_status),
    statusCode: typeof raw.account_status === "number" ? raw.account_status : -1,
    currency: raw.currency,
    timezone: raw.timezone_name ?? null,
    businessName: raw.business_name ?? null,
  };
}

/**
 * Every ad account the current Meta token can reach.
 *
 * This is the single source of truth for account authorization: the browser
 * never gets to name an account that is not in this list.
 */
export async function listAccessibleAccounts(ctx: DashboardContext): Promise<AdAccountDto[]> {
  return dashboardCache.getOrLoad(
    cacheKey({ fbUserId: ctx.fbUserId, tokenHash: ctx.tokenHash, endpoint: "accounts" }),
    CACHE_TTL_MS.accounts,
    async () => {
      const accounts = await metaApiClient.getPaginated<AdAccount>(
        "/me/adaccounts",
        { fields: [...AD_ACCOUNT_DEFAULT_FIELDS].join(","), limit: 200 },
        MAX_ACCOUNTS,
      );
      return accounts
        .filter((raw) => typeof raw?.account_id === "string" && raw.account_id.length > 0)
        .map(toAdAccountDto)
        .sort((a, b) => a.name.localeCompare(b.name, "tr"));
    },
  );
}

/**
 * Resolve an account id supplied by the browser to an account the caller
 * actually has. Fails closed: an id that is not in the accessible list is a
 * 403, never a Meta call. This runs before every account-scoped operation, so
 * a crafted `act_*` can neither reach Graph nor probe for existence.
 */
export async function authorizeAccount(
  ctx: DashboardContext,
  accountId: string,
): Promise<AdAccountDto> {
  const accounts = await listAccessibleAccounts(ctx);
  const match = accounts.find((account) => account.id === accountId);
  if (!match) {
    throw new DashboardError(
      "account_forbidden",
      403,
      "This ad account is not accessible with the connected Meta user.",
    );
  }
  return match;
}
