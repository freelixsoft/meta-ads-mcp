import type { AdAccountDto } from "../dashboard/dto.js";
import type { DashboardContext } from "../dashboard/services/accounts.js";

/**
 * Domain types for the dashboard's Claude agent.
 *
 * Deliberately small: everything that describes a *message*, a *tool
 * definition* or a *content block* uses the Anthropic SDK's own types
 * (`Anthropic.MessageParam`, `Anthropic.Tool`, `Anthropic.ToolUseBlock`, …)
 * rather than a parallel set of interfaces. What lives here is only what the
 * SDK has no opinion about: who a tool runs as, what a pending write looks
 * like, and what one agent turn reports back to the browser.
 */

/** Conversation history as the browser keeps it: plain text, no tool blocks. */
export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/**
 * Everything a tool is allowed to know about its caller.
 *
 * Note what is absent: the Meta access token. It stays in the
 * AsyncLocalStorage that `withMetaContext` put it in, where `metaApiClient`
 * reads it. A tool cannot read it, log it, or hand it to Claude, because it is
 * never on this object in the first place. `tokenHash` is a 12-hex digest used
 * only to partition the cache.
 */
export interface ToolExecutionContext {
  ctx: DashboardContext;
  account: AdAccountDto;
}

/** What the UI shows under "kullanılan veri kaynakları". */
export interface ToolTrace {
  name: string;
  /** Turkish, human-readable: "Kampanyalar okundu (son 30 gün)". */
  label: string;
  status: "ok" | "error" | "awaiting_confirmation";
  /**
   * What actually came back, in a few words: "15/22 satır · 2026-09-12 – 2026-09-18".
   * This is the evidence under an answer — it lets a reader see the analysis was
   * built on a real read of a real period, and how much of the account it saw.
   */
  detail?: string;
  /** Stable machine code when status is "error"; never a raw upstream message. */
  errorCode?: string;
}

/** One line of the confirmation dialog: "Günlük bütçe" / "1.500,00 TRY". */
export interface ConfirmationField {
  label: string;
  value: string;
}

/**
 * A write Claude asked for and the user has not approved.
 *
 * The *parameters* live server-side, keyed by `id`; the browser only ever gets
 * this description and sends the opaque `id` back. That is what makes the
 * confirmation tamper-proof: an approval cannot smuggle different values than
 * the ones the user was shown, because the browser never holds the values in a
 * form the server would accept.
 */
export interface PendingConfirmation {
  id: string;
  tool: string;
  /** "Yeni kampanya oluşturulacak" */
  title: string;
  /** One short Turkish sentence about the consequence. */
  description: string;
  /** The model's argument for the change, shown next to the Onayla button. */
  reason: string;
  /** What could go wrong, when the model supplied one. */
  risk: string | null;
  /** How well the data supports acting, when the proposal came from a finding. */
  confidence: "low" | "medium" | "high" | null;
  fields: ConfirmationField[];
  accountName: string;
  expiresAt: number;
}

export type AgentStopReason =
  | "answered"
  | "awaiting_confirmation"
  | "max_steps"
  /** The turn ran out of wall-clock budget before the model finished. */
  | "timeout"
  | "refusal";

export interface AgentResult {
  answer: string;
  toolTrace: ToolTrace[];
  pendingConfirmation: PendingConfirmation | null;
  stopReason: AgentStopReason;
  model: string;
  steps: number;
}

