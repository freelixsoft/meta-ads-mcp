export interface SessionResponse {
  user: { name: string | null; email: string | null; initials: string };
  meta: {
    connected: boolean;
    tokenName: string | null;
    businessName: string | null;
    expiresAt: number | null;
    isExpired: boolean;
  };
}

export type AdAccountStatus =
  | "ACTIVE"
  | "DISABLED"
  | "UNSETTLED"
  | "PENDING_RISK_REVIEW"
  | "PENDING_SETTLEMENT"
  | "IN_GRACE_PERIOD"
  | "PENDING_CLOSURE"
  | "CLOSED"
  | "ANY_ACTIVE"
  | "ANY_CLOSED"
  | "UNKNOWN";

export interface AdAccount {
  id: string;
  accountId: string;
  name: string;
  status: AdAccountStatus;
  statusCode: number;
  currency: string;
  timezone: string | null;
  businessName: string | null;
}

export interface AccountsResponse {
  accounts: AdAccount[];
}

export interface Metrics {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  purchases: number;
  addToCart: number;
  purchaseValue: number | null;
  costPerPurchase: number | null;
  roas: number | null;
}

export interface SeriesPoint {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number | null;
}

export interface DateRange {
  preset: string;
  since: string | null;
  until: string | null;
}

export interface InsightsResponse {
  account: { id: string; name: string; currency: string };
  range: DateRange;
  summary: Metrics;
  series: SeriesPoint[];
  /** Present only when the request asked for it with compare=1. */
  comparison?: Comparison | null;
  resolvedRange?: { since: string; until: string } | null;
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string | null;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  metrics: Metrics;
}

export interface CampaignsResponse {
  account: { id: string; name: string; currency: string };
  range: DateRange;
  campaigns: Campaign[];
}

export type ApiErrorCode =
  | "unauthenticated"
  | "meta_not_connected"
  | "meta_connection_expired"
  | "account_forbidden"
  | "invalid_request"
  | "rate_limited"
  | "meta_rate_limited"
  | "upstream_error"
  | "server_error"
  | "ai_not_configured"
  | "ai_rate_limited"
  | "ai_unavailable"
  | "ai_confirmation_expired"
  | "ai_write_stale"
  | "ai_writes_disabled"
  /**
   * Client-side only: the request never reached the server. The server never
   * sends this code — `apiGet`/`apiPost` raise it when fetch itself rejects,
   * so a dropped connection reads as one rather than as an unexplained server
   * error.
   */
  | "network_error";

// ─── Phase 2: drill-down hierarchy ───────────────────────────────

export type EntityLevel = "account" | "campaign" | "adset" | "ad";

export interface EntityRow {
  id: string;
  level: EntityLevel;
  name: string;
  status: string;
  effectiveStatus: string | null;
  objective: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adSetId: string | null;
  adSetName: string | null;
  creativeId: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  metrics: Metrics;
}

export interface EntityListResponse {
  account: { id: string; name: string; currency: string };
  range: DateRange;
  parent: { level: EntityLevel; id: string; name: string } | null;
  rows: EntityRow[];
}

export interface MetricDelta {
  absolute: number | null;
  percent: number | null;
}

export type MetricKey = keyof Metrics;

export interface Comparison {
  range: { since: string; until: string };
  previous: Metrics;
  changes: Record<MetricKey, MetricDelta>;
  lowerIsBetter: string[];
}

// ─── Phase 3: AI analysis ────────────────────────────────────────

export interface AiStatus {
  /** An Anthropic API key is present on the server. */
  configured: boolean;
  available: boolean;
  rateLimited: boolean;
  unavailable: boolean;
  model: string;
  /** Whether the assistant may propose changes at all in this deployment. */
  writesEnabled: boolean;
}

/** One step the agent took, shown under an answer as its data sources. */
export interface AiToolTrace {
  name: string;
  label: string;
  status: "ok" | "error" | "awaiting_confirmation";
  /** What came back: "15/22 satır · 2026-09-12 – 2026-09-18". */
  detail?: string;
  errorCode?: string;
}

/**
 * A change the assistant proposed. Carries only what the dialog renders — the
 * parameters that would reach Meta stay on the server, keyed by `id`.
 */
export interface AiConfirmation {
  id: string;
  tool: string;
  title: string;
  description: string;
  /** Why the assistant is proposing the change. Plain text, never HTML. */
  reason: string;
  fields: Array<{ label: string; value: string }>;
  accountName: string;
  expiresAt: number;
}

/** One prior turn as the browser replays it: plain text only. */
export interface ChatHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AiChatResponse {
  /** Plain text. Rendered as text, never as HTML. */
  answer: string;
  toolTrace: AiToolTrace[];
  confirmation: AiConfirmation | null;
  stopReason: "answered" | "awaiting_confirmation" | "max_steps" | "timeout" | "refusal";
  model: string;
  generatedAt: string;
}

export interface AiConfirmResponse {
  applied: boolean;
  discarded?: boolean;
  title?: string;
  answer?: string;
  verified?: Record<string, string | number | boolean | null>;
  verificationFailed?: boolean;
  generatedAt?: string;
}

export interface EntityInsightsResponse {
  account: { id: string; name: string; currency: string };
  entity: {
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
  };
  range: DateRange;
  resolvedRange: { since: string; until: string } | null;
  summary: Metrics;
  comparison: Comparison | null;
  series: SeriesPoint[];
}
