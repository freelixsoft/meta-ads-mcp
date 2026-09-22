import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiGet, apiPost, ApiError, isConnectionError } from "./client";
import type {
  AccountsResponse,
  AiChatResponse,
  AiConfirmResponse,
  AiStatus,
  ChatHistoryTurn,
  CampaignsResponse,
  EntityInsightsResponse,
  EntityLevel,
  EntityListResponse,
  InsightsResponse,
  SessionResponse,
} from "./types";

export interface RangeParams {
  preset: string;
  since?: string;
  until?: string;
}

function rangeQuery(range: RangeParams): Record<string, string | undefined> {
  return range.preset === "custom"
    ? { preset: "custom", since: range.since, until: range.until }
    : { preset: range.preset };
}

/** Reconnecting is the only fix for an auth failure, so those are never retried. */
function retryPolicy(failureCount: number, error: Error): boolean {
  if (isConnectionError(error)) return false;
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

const COMMON = {
  retry: retryPolicy,
  staleTime: 30_000,
  refetchOnWindowFocus: false,
} as const;

export function useSession(): UseQueryResult<SessionResponse, Error> {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => apiGet<SessionResponse>("/session"),
    ...COMMON,
  });
}

export function useAccounts(enabled: boolean): UseQueryResult<AccountsResponse, Error> {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => apiGet<AccountsResponse>("/accounts"),
    enabled,
    ...COMMON,
  });
}

export function useInsights(
  accountId: string | null,
  range: RangeParams,
): UseQueryResult<InsightsResponse, Error> {
  return useQuery({
    queryKey: ["insights", accountId, range.preset, range.since, range.until],
    queryFn: () =>
      apiGet<InsightsResponse>(`/accounts/${accountId}/insights`, {
        ...rangeQuery(range),
        compare: "1",
      }),
    enabled: accountId !== null,
    ...COMMON,
  });
}

export function useCampaigns(
  accountId: string | null,
  range: RangeParams,
): UseQueryResult<CampaignsResponse, Error> {
  return useQuery({
    queryKey: ["campaigns", accountId, range.preset, range.since, range.until],
    queryFn: () => apiGet<CampaignsResponse>(`/accounts/${accountId}/campaigns`, rangeQuery(range)),
    enabled: accountId !== null,
    ...COMMON,
  });
}

// ─── Phase 2: drill-down ─────────────────────────────────────────

export function useAdSets(
  accountId: string | null,
  campaignId: string | null,
  range: RangeParams,
): UseQueryResult<EntityListResponse, Error> {
  return useQuery({
    queryKey: ["adsets", accountId, campaignId, range.preset, range.since, range.until],
    queryFn: () =>
      apiGet<EntityListResponse>(
        `/accounts/${accountId}/campaigns/${campaignId}/adsets`,
        rangeQuery(range),
      ),
    enabled: accountId !== null && campaignId !== null,
    ...COMMON,
  });
}

export function useAds(
  accountId: string | null,
  adSetId: string | null,
  range: RangeParams,
): UseQueryResult<EntityListResponse, Error> {
  return useQuery({
    queryKey: ["ads", accountId, adSetId, range.preset, range.since, range.until],
    queryFn: () =>
      apiGet<EntityListResponse>(`/accounts/${accountId}/adsets/${adSetId}/ads`, rangeQuery(range)),
    enabled: accountId !== null && adSetId !== null,
    ...COMMON,
  });
}

// ─── Phase 3: AI analysis ────────────────────────────────────────

/**
 * Whether Claude is usable at all. Cached longer than the data queries: it is
 * a server-side setting that rarely changes, and this answer gates a panel
 * rather than showing a number.
 */
export function useAiStatus(enabled: boolean): UseQueryResult<AiStatus, Error> {
  return useQuery({
    queryKey: ["ai-status"],
    queryFn: () => apiGet<AiStatus>("/ai/status"),
    enabled,
    ...COMMON,
    staleTime: 5 * 60_000,
  });
}

export interface AiChatVariables {
  accountId: string;
  message: string;
  /** Prior turns as plain text. No tool blocks ever leave the server. */
  history: ChatHistoryTurn[];
}

/**
 * One agent turn. A mutation, not a query: an answer is produced when the user
 * asks for one and must never be refetched in the background on a window focus,
 * where it would silently spend money and Meta quota.
 */
export function useAiChat(): UseMutationResult<AiChatResponse, Error, AiChatVariables> {
  return useMutation<AiChatResponse, Error, AiChatVariables>({
    mutationFn: ({ accountId, message, history }) =>
      apiPost<AiChatResponse>(`/accounts/${accountId}/ai/chat`, { message, history }),
    retry: false,
  });
}

export interface AiConfirmVariables {
  accountId: string;
  confirmationId: string;
  decision: "approve" | "cancel";
}

/**
 * Approving or discarding a staged change. The body carries the opaque id and
 * nothing else — the parameters live on the server, so this cannot alter what
 * the user was shown.
 */
export function useAiConfirm(): UseMutationResult<AiConfirmResponse, Error, AiConfirmVariables> {
  return useMutation<AiConfirmResponse, Error, AiConfirmVariables>({
    mutationFn: ({ accountId, confirmationId, decision }) =>
      apiPost<AiConfirmResponse>(`/accounts/${accountId}/ai/confirm`, { confirmationId, decision }),
    retry: false,
  });
}


/** Path segment for each level's insights endpoint. */
const INSIGHTS_SEGMENT: Record<Exclude<EntityLevel, "account">, string> = {
  campaign: "campaigns",
  adset: "adsets",
  ad: "ads",
};

/**
 * Detail payload for the drawer. Always asks for the comparison — the drawer
 * is the one surface where the extra Meta call is worth it, and it is only
 * fetched while a drawer is actually open.
 */
export function useEntityInsights(
  accountId: string | null,
  target: { level: Exclude<EntityLevel, "account">; id: string } | null,
  range: RangeParams,
): UseQueryResult<EntityInsightsResponse, Error> {
  return useQuery({
    queryKey: [
      "entity-insights",
      accountId,
      target?.level,
      target?.id,
      range.preset,
      range.since,
      range.until,
    ],
    queryFn: () =>
      apiGet<EntityInsightsResponse>(
        `/accounts/${accountId}/${INSIGHTS_SEGMENT[target!.level]}/${target!.id}/insights`,
        { ...rangeQuery(range), compare: "1" },
      ),
    enabled: accountId !== null && target !== null,
    ...COMMON,
  });
}
