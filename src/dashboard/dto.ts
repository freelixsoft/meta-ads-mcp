/**
 * Response shapes for /api/dashboard/*.
 *
 * Every DTO is built field by field from the Meta payload — no spreads, no
 * `JSON.stringify(raw)`. Graph objects carry fields the browser has no
 * business seeing (page access tokens on Page objects, funding-source details
 * on accounts), and a whitelist is the only mapping that stays safe when Meta
 * adds a field.
 */

export interface DashboardUserDto {
  name: string | null;
  email: string | null;
  initials: string;
}

export interface MetaConnectionDto {
  connected: boolean;
  tokenName: string | null;
  businessName: string | null;
  expiresAt: number | null;
  isExpired: boolean;
}

export interface SessionResponseDto {
  user: DashboardUserDto;
  meta: MetaConnectionDto;
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

export interface AdAccountDto {
  /** Always the act_-prefixed form; the only id the frontend ever sends back. */
  id: string;
  accountId: string;
  name: string;
  status: AdAccountStatus;
  statusCode: number;
  currency: string;
  timezone: string | null;
  businessName: string | null;
}

export interface AccountsResponseDto {
  accounts: AdAccountDto[];
}

export interface MetricsDto {
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

export interface SeriesPointDto {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number | null;
}

export interface DateRangeDto {
  preset: string;
  since: string | null;
  until: string | null;
}

export interface InsightsResponseDto {
  account: { id: string; name: string; currency: string };
  range: DateRangeDto;
  summary: MetricsDto;
  series: SeriesPointDto[];
  /** Present only when the caller asked for it with ?compare=1. */
  comparison?: ComparisonDto | null;
  resolvedRange?: { since: string; until: string } | null;
}

export interface CampaignDto {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string | null;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  metrics: MetricsDto;
}

export interface CampaignsResponseDto {
  account: { id: string; name: string; currency: string };
  range: DateRangeDto;
  campaigns: CampaignDto[];
}

const ACCOUNT_STATUS_BY_CODE: Record<number, AdAccountStatus> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
};

export function accountStatusFromCode(code: unknown): AdAccountStatus {
  return typeof code === "number" ? (ACCOUNT_STATUS_BY_CODE[code] ?? "UNKNOWN") : "UNKNOWN";
}

export function userInitialsFrom(name: string | null, email: string | null): string {
  const source = (name ?? email ?? "").trim();
  if (!source) return "?";
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

// ─── Phase 2: drill-down hierarchy ───────────────────────────────

/** Where an entity sits in the campaign → ad set → ad hierarchy. */
export type EntityLevel = "account" | "campaign" | "adset" | "ad";

/**
 * One row in any of the three drill-down tables. The optional parent fields
 * are populated by level: an ad set carries its campaign, an ad carries both.
 */
export interface EntityRowDto {
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
  metrics: MetricsDto;
}

export interface EntityListResponseDto {
  account: { id: string; name: string; currency: string };
  range: DateRangeDto;
  parent: { level: EntityLevel; id: string; name: string } | null;
  rows: EntityRowDto[];
}

export interface MetricDelta {
  absolute: number | null;
  percent: number | null;
}

export type MetricsComparison = Record<keyof MetricsDto, MetricDelta>;

export interface ComparisonDto {
  range: { since: string; until: string };
  previous: MetricsDto;
  changes: MetricsComparison;
  /** Metric keys where a decrease is an improvement, so the UI colours them correctly. */
  lowerIsBetter: string[];
}

// ─── Phase 3: AI analysis ────────────────────────────────────────

/**
 * Whether the dashboard's AI is usable right now, and with what.
 *
 * The Anthropic API key is a server-side setting, so this describes the
 * *server*, not the signed-in user. No part of the key — not a prefix, not a
 * fingerprint, not its length — appears here or anywhere else in a response.
 */
export interface AiStatusResponseDto {
  /** An Anthropic API key is present on the server. */
  configured: boolean;
  /** Configured and not currently known to be failing. */
  available: boolean;
  rateLimited: boolean;
  unavailable: boolean;
  model: string;
  /** Whether the write tools are offered at all in this deployment. */
  writesEnabled: boolean;
}

/** One step the agent took, for the "hangi veriyi okudu" trace under an answer. */
export interface AiToolTraceDto {
  name: string;
  label: string;
  status: "ok" | "error" | "awaiting_confirmation";
  /** What came back: "15/22 satır · 2026-09-12 – 2026-09-18". */
  detail?: string;
  errorCode?: string;
}

/**
 * A change the agent proposed and the user has not approved.
 *
 * Carries only what the dialog renders. The parameters that would actually be
 * sent to Meta stay on the server, keyed by `id`, so an approval cannot carry
 * different values than the ones shown here.
 */
export interface AiConfirmationDto {
  id: string;
  tool: string;
  title: string;
  description: string;
  /** Why the assistant is proposing the change. */
  reason: string;
  risk: string | null;
  confidence: "low" | "medium" | "high" | null;
  fields: Array<{ label: string; value: string }>;
  accountName: string;
  expiresAt: number;
}

export interface AiChatResponseDto {
  /** Plain text. Rendered as text, never as HTML. */
  answer: string;
  toolTrace: AiToolTraceDto[];
  confirmation: AiConfirmationDto | null;
  stopReason: "answered" | "awaiting_confirmation" | "max_steps" | "timeout" | "refusal";
  model: string;
  generatedAt: string;
}

/** Result of an approved write, after the object was re-read from Meta. */
export interface AiConfirmResponseDto {
  applied: boolean;
  title: string;
  /** One Turkish sentence describing what happened. */
  answer: string;
  verified: Record<string, string | number | boolean | null>;
  /** True when Meta accepted the write but the read-back failed. */
  verificationFailed: boolean;
  generatedAt: string;
}

/**
 * The answer, as plain text.
 *
 * Every string here is model output that has been length-bounded and stripped
 * of control characters, and the frontend renders all of it as text — never as
 * HTML. No part of the payload the model saw is echoed back: the browser
 * already has the underlying numbers from the other endpoints.
 */
export interface AiAnalysisResponseDto {
  scope: { level: EntityLevel; name: string };
  range: DateRangeDto;
  resolvedRange: { since: string; until: string } | null;
  /** The sanitized question, echoed so the UI can render the exact text that was sent. */
  question: string | null;
  answer: string;
  highlights: string[];
  dataGaps: string[];
  /** Metric keys Meta returned no value for, straight from the data — not from the model. */
  missingMetrics: string[];
  /** What was dropped to stay inside the payload limit, if anything. */
  truncation: string[];
  model: string;
  generatedAt: string;
}

/** Detail payload behind a drawer: who the entity is, how it did, and versus when. */
export interface EntityInsightsResponseDto {
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
  range: DateRangeDto;
  /** The dates Meta actually resolved the range to, in the account's timezone. */
  resolvedRange: { since: string; until: string } | null;
  summary: MetricsDto;
  comparison: ComparisonDto | null;
  series: SeriesPointDto[];
}
