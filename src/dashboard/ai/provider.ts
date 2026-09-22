import {
  ClaudeError,
  getClaudeClient,
  isClaudeConfigured,
  resolveClaudeModel,
} from "../../claude/client.js";

/**
 * The seam between the dashboard's one-shot analysis endpoints and the model.
 *
 * Phase 3 ran this on Gemini with a per-tenant key; it now runs on Claude with
 * a single server-side `ANTHROPIC_API_KEY`, which is why availability is a
 * property of the *server* rather than of the signed-in user. The seam itself
 * is unchanged, so `/ai/ask` and `/ai/summary` keep their shape and their
 * tests — only what is behind it moved.
 *
 * The agentic `/ai/chat` surface does not go through here; it talks to
 * `src/claude/agent.ts` directly, because it needs tools and a loop.
 */

/** How long a failure keeps being reported after it happened. */
const HEALTH_COOLDOWN_MS = 60_000;

export interface AiAvailability {
  /** An API key is present on the server. */
  configured: boolean;
  /** Configured and not currently known to be failing. */
  available: boolean;
  rateLimited: boolean;
  unavailable: boolean;
  model: string;
}

export interface AiGenerateInput {
  systemInstruction: string;
  prompt: string;
  maxOutputTokens: number;
}

export interface AiGenerateResult {
  /** Parsed JSON when the model returned JSON; otherwise `{ answer: <text> }`. */
  json: unknown;
  model: string;
}

export interface AiProvider {
  availability(): Promise<AiAvailability>;
  generate(input: AiGenerateInput): Promise<AiGenerateResult>;
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super("No AI provider is configured on this server.");
    this.name = "AiNotConfiguredError";
  }
}

/**
 * Last observed failure, so `/ai/status` can say "rate limited" instead of
 * "available" right after the user hit a 429. Per instance and deliberately
 * short-lived: it is a hint for the UI, never an authorization decision.
 */
let lastFailure: { code: "rate_limited" | "unavailable"; at: number } | null = null;

export function noteProviderFailure(code: "rate_limited" | "unavailable", now = Date.now()): void {
  lastFailure = { code, at: now };
}

export function clearProviderHealth(): void {
  lastFailure = null;
}

function healthNow(now = Date.now()): { rateLimited: boolean; unavailable: boolean } {
  if (!lastFailure || now - lastFailure.at > HEALTH_COOLDOWN_MS) {
    return { rateLimited: false, unavailable: false };
  }
  return {
    rateLimited: lastFailure.code === "rate_limited",
    unavailable: lastFailure.code === "unavailable",
  };
}

/** Models fenced or prefixed their JSON often enough that this is worth having. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstBreak = trimmed.indexOf("\n");
  const lastFence = trimmed.lastIndexOf("```");
  if (firstBreak < 0 || lastFence <= firstBreak) return trimmed;
  return trimmed.slice(firstBreak + 1, lastFence).trim();
}

const claudeProvider: AiProvider = {
  async availability(): Promise<AiAvailability> {
    const configured = isClaudeConfigured();
    const health = healthNow();
    return {
      configured,
      available: configured && !health.rateLimited && !health.unavailable,
      rateLimited: health.rateLimited,
      unavailable: health.unavailable,
      model: resolveClaudeModel(),
    };
  },

  async generate(input: AiGenerateInput): Promise<AiGenerateResult> {
    if (!isClaudeConfigured()) throw new AiNotConfiguredError();

    const client = getClaudeClient();
    try {
      const response = await client.createMessage({
        system: input.systemInstruction,
        messages: [{ role: "user", content: input.prompt }],
        maxTokens: input.maxOutputTokens,
      });

      const text = response.content
        .filter((block): block is { type: "text"; text: string; citations: never } =>
          block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");

      if (response.stop_reason === "refusal") {
        throw new ClaudeError("invalid_request", "The model declined this request.");
      }

      // A non-JSON answer is still an answer: it becomes the `answer` field
      // rather than an error, so a formatting slip never costs the user a call.
      let json: unknown;
      try {
        json = JSON.parse(stripFence(text)) as unknown;
      } catch {
        json = { answer: text };
      }
      return { json, model: response.model };
    } catch (error) {
      if (error instanceof ClaudeError) {
        noteProviderFailure(error.code === "rate_limited" ? "rate_limited" : "unavailable");
      }
      throw error;
    }
  },
};

let activeProvider: AiProvider = claudeProvider;

export function getAiProvider(): AiProvider {
  return activeProvider;
}

/** Swaps the provider for tests; passing undefined restores the Claude one. */
export function configureAiProviderForTests(provider: AiProvider | undefined): void {
  activeProvider = provider ?? claudeProvider;
}

export { ClaudeError };
