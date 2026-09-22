import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

/**
 * Machine-readable error codes the frontend switches on. The Turkish copy for
 * each lives in the frontend, so the API stays language-agnostic; `message` is
 * a fallback for anything the UI does not recognise.
 */
export type DashboardErrorCode =
  | "unauthenticated"
  | "meta_not_connected"
  | "meta_connection_expired"
  | "account_forbidden"
  | "invalid_request"
  | "rate_limited"
  | "meta_rate_limited"
  | "upstream_error"
  | "server_error"
  // Phase 3: the AI analysis layer. Kept distinct from the Meta codes because
  // the fix differs — configuring an Anthropic key, waiting out an AI quota, or
  // retrying a model failure has nothing to do with the Meta connection.
  | "ai_not_configured"
  | "ai_rate_limited"
  | "ai_unavailable"
  /** A staged write was approved too late, twice, or by the wrong session. */
  | "ai_confirmation_expired"
  /**
   * The object moved between the proposal and the approval, so the change was
   * refused rather than applied on top of someone else's edit. Distinct from
   * `ai_confirmation_expired`: the approval was valid, the world was not.
   */
  | "ai_write_stale"
  /** The operator kill switch is off, so an approved write was declined. */
  | "ai_writes_disabled";

export class DashboardError extends Error {
  constructor(
    readonly code: DashboardErrorCode,
    readonly status: number,
    message: string,
    /** `cause` keeps the upstream failure for the log line; it is never serialized to the browser. */
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DashboardError";
  }
}

/**
 * Prefixes emitted by classifyMetaError() for the `auth` category
 * (src/meta/errors.ts). The client collapses its classification into an
 * McpError before it reaches us, and we deliberately do not change that shared
 * code path, so the category is recovered from the message. Each prefix is a
 * literal from that file; the test suite pins them.
 */
const META_AUTH_MESSAGE_PREFIXES = [
  "Invalid or expired access token",
  "Insufficient permissions for this operation",
  "Authentication required",
] as const;

const META_THROTTLE_MARKERS = [
  "rate limit",
  "temporarily blocked",
] as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map anything thrown inside a dashboard request to a status + stable code.
 *
 * Never returns the original message for a 500: upstream text can carry Meta
 * trace ids and query echoes that do not belong in a browser response.
 */
export function toDashboardError(error: unknown): DashboardError {
  if (error instanceof DashboardError) return error;

  if (error instanceof ZodError) {
    return new DashboardError("invalid_request", 400, "Invalid request parameters.");
  }

  const message = messageOf(error);

  if (META_AUTH_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return new DashboardError(
      "meta_connection_expired",
      401,
      "The Meta connection is no longer valid.",
    );
  }

  const lower = message.toLowerCase();
  if (META_THROTTLE_MARKERS.some((marker) => lower.includes(marker))) {
    return new DashboardError(
      "meta_rate_limited",
      429,
      "Meta is throttling this account. Try again shortly.",
    );
  }

  if (error instanceof McpError) {
    // Guardrail rejections and parameter errors land here — they are caused by
    // the request, so the message is ours and safe to forward.
    return new DashboardError("invalid_request", 400, message);
  }

  return new DashboardError("server_error", 500, "Unexpected server error.");
}
