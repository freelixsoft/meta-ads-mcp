import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger.js";

/**
 * The only place this server talks to Anthropic.
 *
 * Three rules shape it:
 *
 *  1. **Server-side only.** `ANTHROPIC_API_KEY` is read from the process
 *     environment and never leaves it — not into a response, not into a log
 *     line, not into a tool result. Nothing here accepts a key as an argument,
 *     so no caller can pass one in from a request.
 *  2. **One stable error vocabulary.** The SDK's typed error classes are
 *     mapped to a small set of codes the dashboard can act on; Anthropic's own
 *     message text is logged but never forwarded to the browser, for the same
 *     reason Meta's is not.
 *  3. **A swappable seam.** `configureClaudeClientForTests` replaces the whole
 *     client, so no test ever reaches the network.
 */

/**
 * Default model. Claude Opus 5 is the current flagship; `ANTHROPIC_MODEL`
 * overrides it, but only with a `claude-*` id — an arbitrary string here would
 * be interpolated into an API request, and a typo should fall back to a model
 * that works rather than fail every request.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";
const MODEL_PATTERN = /^claude-[A-Za-z0-9._-]{1,60}$/;

/**
 * Generous enough that an analysis with several tool calls is never truncated
 * mid-sentence. Adaptive thinking draws from the same ceiling.
 */
const MAX_TOKENS = 16_000;

/**
 * `medium` rather than the default `high`: this runs inside a browser request
 * where a person is watching a spinner, and ad-account analysis over
 * pre-aggregated numbers is not the kind of problem that repays maximum
 * deliberation. Raise it if answers get shallow.
 */
const EFFORT = "medium" as const;

/** A dashboard request must not hold a connection the way a batch job can. */
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 1;

export type ClaudeErrorCode =
  | "not_configured"
  | "rate_limited"
  | "unavailable"
  | "invalid_request";

export class ClaudeError extends Error {
  constructor(
    readonly code: ClaudeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeError";
  }
}

export function resolveClaudeModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ANTHROPIC_MODEL?.trim();
  return configured && MODEL_PATTERN.test(configured) ? configured : DEFAULT_CLAUDE_MODEL;
}

export function isClaudeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

export interface ClaudeRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  /** Overrides the ceiling for short, single-shot calls. */
  maxTokens?: number;
  /**
   * Shrinks this one call's deadline. The agent uses it to keep a whole turn
   * inside its own wall-clock budget instead of letting six calls each take
   * the full default.
   */
  timeoutMs?: number;
}

export interface ClaudeClient {
  readonly model: string;
  createMessage(request: ClaudeRequest): Promise<Anthropic.Message>;
}

/**
 * Map the SDK's typed errors onto our codes.
 *
 * Checked most specific first, as the SDK documents. The upstream message is
 * attached as `cause` for the log line and dropped from what the caller shows.
 */
function toClaudeError(error: unknown): ClaudeError {
  if (error instanceof ClaudeError) return error;

  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeError("not_configured", "Anthropic rejected the configured API key.", { cause: error });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ClaudeError("rate_limited", "Anthropic is rate limiting this key.", { cause: error });
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    // A bad model id or a malformed request is ours to fix, not the user's to retry.
    return new ClaudeError("invalid_request", "The request to Anthropic was rejected.", { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new ClaudeError("unavailable", "Anthropic could not be reached.", { cause: error });
  }
  return new ClaudeError("unavailable", "The AI request failed.", { cause: error });
}

/**
 * The whole request shape lives here, under a unit test, so a change to what
 * this server sends Anthropic touches one reviewable function — the same
 * arrangement `buildGenerateBody` has on the Gemini side.
 */
export function buildCreateParams(
  request: ClaudeRequest,
  model: string,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: request.maxTokens ?? MAX_TOKENS,
    // Adaptive thinking: the agent has to decide which of a dozen tools to
    // call and how to read the numbers that come back, which is exactly the
    // kind of work it helps with. `display` is left at the default, so no
    // reasoning text is returned or shown.
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    // The cache breakpoint sits at the end of the system prompt, which in
    // render order (tools -> system -> messages) covers the tool schemas too.
    // Those two are the largest and most stable part of every request and are
    // re-sent on every step of every turn; without this they are the dominant
    // cost of running the assistant. Keep the system prompt free of timestamps
    // and per-request ids or the prefix stops matching and this silently does
    // nothing — `usage.cache_read_input_tokens` is the check.
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: request.messages,
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
  };
}

function createAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new ClaudeError("not_configured", "ANTHROPIC_API_KEY is not set on this server.");
  }
  // The key is passed explicitly rather than left to the SDK's environment
  // lookup so that the "not configured" case is a clean error here, before any
  // request is built.
  return new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
}

let cached: { key: string; client: Anthropic } | undefined;

/** Rebuilt when the key changes, so a rotated key takes effect without a restart. */
function anthropicClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (!cached || cached.key !== key) {
    cached = { key, client: createAnthropicClient() };
  }
  return cached.client;
}

const liveClient: ClaudeClient = {
  get model() {
    return resolveClaudeModel();
  },

  async createMessage(request: ClaudeRequest): Promise<Anthropic.Message> {
    const client = anthropicClient();
    const model = resolveClaudeModel();
    try {
      const response = await client.messages.create(
        buildCreateParams(request, model),
        request.timeoutMs ? { timeout: request.timeoutMs } : undefined,
      );

      logger.info(
        {
          event: "claude_request",
          model: response.model,
          stopReason: response.stop_reason,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          // Zero across repeated turns means the cached prefix is not matching.
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        "Claude request completed",
      );
      return response;
    } catch (error) {
      const mapped = toClaudeError(error);
      logger.warn(
        {
          event: "claude_request_failed",
          code: mapped.code,
          model,
          status: error instanceof Anthropic.APIError ? error.status : undefined,
          error: error instanceof Error ? error.message : String(error),
        },
        "Claude request failed",
      );
      throw mapped;
    }
  },
};

let activeClient: ClaudeClient = liveClient;

export function getClaudeClient(): ClaudeClient {
  return activeClient;
}

/** Swaps the client for tests; passing undefined restores the live one. */
export function configureClaudeClientForTests(client: ClaudeClient | undefined): void {
  activeClient = client ?? liveClient;
}

/** Exported for the unit test that pins the mapping. */
export { toClaudeError };
