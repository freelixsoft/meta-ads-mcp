import type Anthropic from "@anthropic-ai/sdk";
import { ZodError } from "zod";
import { hashPii } from "../auth/token-store.js";
import { logger } from "../utils/logger.js";
import { toDashboardError } from "../dashboard/errors.js";
import { sanitizeModelText } from "../dashboard/ai/sanitize.js";
import { todayInTimezone } from "../dashboard/date-range.js";
import { getClaudeClient } from "./client.js";
import { stageWrite } from "./confirmations.js";
import { buildSystemPrompt, confirmationPendingResult } from "./prompt.js";
import {
  buildToolDefinitions,
  READ_TOOLS_BY_NAME,
  WRITE_TOOLS_BY_NAME,
} from "./tools.js";
import type {
  AgentResult,
  AgentStopReason,
  ChatTurn,
  PendingConfirmation,
  ToolExecutionContext,
  ToolTrace,
} from "./types.js";

/**
 * The agent loop.
 *
 * Bounded in five independent ways, because an unbounded loop against a paid
 * API with a shared Meta quota is the failure mode that actually costs money:
 *
 *  - `MAX_STEPS` model round-trips per question.
 *  - `MAX_TOOL_CALLS` tool executions per question, across all steps.
 *  - A byte ceiling per tool result and across the whole turn, so one large
 *    account cannot grow the context without limit.
 *  - `MAX_TURN_MS` of wall clock for the whole turn.
 *  - At most one proposed write per question, and it is staged, never sent.
 *
 * Every exit path returns an `AgentResult`; the loop cannot fall off the end.
 */

const MAX_STEPS = 6;
const MAX_TOOL_CALLS = 12;
const MAX_TOOL_RESULT_BYTES = 12_000;
const MAX_TOTAL_TOOL_BYTES = 60_000;

/**
 * Wall-clock ceiling for one turn.
 *
 * Six round-trips at the client's own 90 s timeout is nine minutes, which is
 * far past the point where the browser — and Cloud Run's request timeout — have
 * given up, leaving the user with a dead connection while the server keeps
 * spending. Two minutes sits inside both, and each step is given only what is
 * left of it.
 */
const MAX_TURN_MS = 120_000;

/** Below this there is no point starting another round-trip. */
const MIN_STEP_MS = 8_000;

/** Appended when the model's reply hit the output ceiling mid-thought. */
const TRUNCATED_NOTE =
  "(Yanıt uzunluk sınırına takıldığı için burada kesildi. Soruyu daraltırsanız tamamını verebilirim.)";

export interface AgentInput {
  /** Already sanitized by the caller. */
  question: string;
  /** Already sanitized and bounded by the caller. */
  history: ChatTurn[];
  /** False turns the write tools off entirely — they are not even declared. */
  allowWrites: boolean;
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return sanitizeModelText(
    content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n\n"),
  );
}

function toolUsesOf(content: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock[] {
  return content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
}

function resultBlock(
  toolUseId: string,
  payload: unknown,
  isError = false,
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: typeof payload === "string" ? payload : JSON.stringify(payload),
    ...(isError ? { is_error: true } : {}),
  };
}

/**
 * Keep a result inside the byte ceiling. Row-bearing results lose rows (the
 * cheapest information per byte, and already sorted so the important ones are
 * first); anything else that is still too big is refused outright rather than
 * cut mid-JSON into something the model would misread.
 */
function boundResult(value: unknown): { payload: unknown; bytes: number } {
  let serialized = JSON.stringify(value) ?? "null";
  if (serialized.length <= MAX_TOOL_RESULT_BYTES) {
    return { payload: value, bytes: serialized.length };
  }

  if (value && typeof value === "object" && Array.isArray((value as { rows?: unknown }).rows)) {
    const record = value as Record<string, unknown> & { rows: unknown[] };
    const trimmed = { ...record, rows: record.rows.slice(0, 10), truncatedForSize: true };
    serialized = JSON.stringify(trimmed);
    if (serialized.length <= MAX_TOOL_RESULT_BYTES) {
      return { payload: trimmed, bytes: serialized.length };
    }
  }

  const refusal = {
    error: "result_too_large",
    message: "The result exceeded the size limit. Ask for fewer rows or a narrower period.",
  };
  return { payload: refusal, bytes: JSON.stringify(refusal).length };
}

/**
 * A short Turkish description of what a tool result actually contained.
 *
 * Derived generically from the result shape rather than per tool, so a new tool
 * gets a useful trace line without remembering to add one.
 */
export function describeResult(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];

  if (Array.isArray(record.rows)) {
    const total = typeof record.totalRows === "number" ? record.totalRows : record.rows.length;
    parts.push(
      record.rows.length < total ? `${record.rows.length}/${total} satır` : `${total} satır`,
    );
  } else if (Array.isArray(record.accounts)) {
    parts.push(`${record.accounts.length} hesap`);
  }

  const period = record.period ?? record.currentPeriod;
  if (period && typeof period === "object") {
    const { since, until } = period as { since?: unknown; until?: unknown };
    if (typeof since === "string" && typeof until === "string") parts.push(`${since} – ${until}`);
    else if (typeof (period as { preset?: unknown }).preset === "string") {
      parts.push(String((period as { preset: string }).preset));
    }
  }

  const quality = record.dataQuality as { metricsMissingOnEveryRow?: unknown } | undefined;
  if (Array.isArray(quality?.metricsMissingOnEveryRow) && quality.metricsMissingOnEveryRow.length > 0) {
    parts.push(`${quality.metricsMissingOnEveryRow.length} metrik yok`);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * A stable key for one tool call, so the same read asked for twice in a turn is
 * recognised regardless of the order the model happened to serialize its
 * arguments in. Built from the *parsed* input, so two calls that normalize to
 * the same request (defaults filled in) also match.
 */
export function toolCallKey(name: string, input: unknown): string {
  const sorted = JSON.stringify(input, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]]),
        )
      : value,
  );
  return `${name}:${sorted ?? ""}`;
}

interface StepState {
  toolCalls: number;
  toolBytes: number;
  trace: ToolTrace[];
  pending: PendingConfirmation | null;
  /** Read calls already served this turn, so an identical repeat costs nothing. */
  served: Set<string>;
}

/** One tool_use block: validate, authorize, execute (or stage), and describe. */
async function executeToolUse(
  use: Anthropic.ToolUseBlock,
  tools: ToolExecutionContext,
  state: StepState,
  allowWrites: boolean,
): Promise<Anthropic.ToolResultBlockParam> {
  const readTool = READ_TOOLS_BY_NAME.get(use.name);
  const writeTool = WRITE_TOOLS_BY_NAME.get(use.name);

  if (!readTool && !writeTool) {
    state.trace.push({ name: use.name, label: `Bilinmeyen araç: ${use.name}`, status: "error", errorCode: "unknown_tool" });
    return resultBlock(use.id, { error: "unknown_tool", message: "No such tool." }, true);
  }

  if (writeTool && !allowWrites) {
    state.trace.push({ name: use.name, label: "Değişiklik isteği reddedildi", status: "error", errorCode: "writes_disabled" });
    return resultBlock(
      use.id,
      { error: "writes_disabled", message: "Changes are disabled for this conversation." },
      true,
    );
  }

  if (writeTool && state.pending) {
    return resultBlock(
      use.id,
      {
        error: "confirmation_already_pending",
        message: "One change is already waiting for approval. Explain it and stop.",
      },
      true,
    );
  }

  const tool = readTool ?? writeTool;
  if (!tool) {
    return resultBlock(use.id, { error: "unknown_tool", message: "No such tool." }, true);
  }

  let input: unknown;
  try {
    input = tool.schema.parse(use.input);
  } catch (error) {
    const message =
      error instanceof ZodError
        ? error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ").slice(0, 400)
        : "Invalid arguments.";
    state.trace.push({ name: use.name, label: `Geçersiz araç girdisi: ${use.name}`, status: "error", errorCode: "invalid_arguments" });
    return resultBlock(use.id, { error: "invalid_arguments", message }, true);
  }

  // A repeat of a read already served this turn buys nothing: the result is
  // still in the context above. Refusing it here — without spending a tool
  // slot, a Meta call or more context — is the cheapest correction available,
  // and models do re-ask when a turn runs long.
  if (readTool) {
    const key = toolCallKey(use.name, input);
    if (state.served.has(key)) {
      // Refund the slot the loop reserved: nothing was read, so nothing was
      // spent, and the budget should be available for a call that adds data.
      state.toolCalls -= 1;
      return resultBlock(
        use.id,
        {
          error: "duplicate_call",
          message:
            "You already called this tool with these arguments in this turn. Its result is earlier in this conversation — use that instead of reading again.",
        },
        true,
      );
    }
    state.served.add(key);
  }

  try {
    if (writeTool) {
      const plan = await writeTool.plan(input, tools);
      state.pending = stageWrite({
        plan,
        fbUserId: tools.ctx.fbUserId,
        accountId: tools.account.id,
        accountName: tools.account.name,
      });
      state.trace.push({ name: use.name, label: `${plan.title} — onay bekliyor`, status: "awaiting_confirmation" });
      return resultBlock(use.id, confirmationPendingResult(plan.title));
    }

    const value = await readTool!.run(input, tools);
    const bounded = boundResult(value);
    state.toolBytes += bounded.bytes;
    state.trace.push({
      name: use.name,
      label: readTool!.label(input),
      status: "ok",
      detail: describeResult(bounded.payload),
    });
    return resultBlock(use.id, bounded.payload);
  } catch (error) {
    // Meta failures, authorization refusals and guardrail rejections all land
    // here. `toDashboardError` is the same mapper the HTTP layer uses, so the
    // model sees a stable code and never an upstream trace id.
    const mapped = toDashboardError(error);
    state.trace.push({ name: use.name, label: `${use.name} başarısız`, status: "error", errorCode: mapped.code });
    logger.warn(
      {
        event: "claude_tool_failed",
        tool: use.name,
        code: mapped.code,
        fbUserId: hashPii(tools.ctx.fbUserId),
        error: error instanceof Error ? error.message : String(error),
      },
      "Claude tool execution failed",
    );
    return resultBlock(
      use.id,
      {
        error: mapped.code,
        message: mapped.message,
        // Without this a failed read reads as an invitation to find another
        // way to be helpful, and the model retargets: it could not read the ad
        // set, so it proposed a campaign budget instead. A read that failed is
        // missing information, not permission to change the question.
        guidance:
          "This read failed, so you do not have the value you asked for. Tell the user which read " +
          "failed and why, and stop. Do NOT propose a change to a different object, do not fall " +
          "back to a parent, and do not state or estimate a number this call did not return.",
      },
      true,
    );
  }
}

export async function runAgent(
  tools: ToolExecutionContext,
  input: AgentInput,
): Promise<AgentResult> {
  const client = getClaudeClient();
  const toolDefinitions = buildToolDefinitions({ allowWrites: input.allowWrites });
  const system = buildSystemPrompt(tools.account, todayInTimezone(tools.account.timezone));

  const messages: Anthropic.MessageParam[] = [
    ...input.history.map((turn) => ({ role: turn.role, content: turn.content }) as Anthropic.MessageParam),
    { role: "user", content: input.question },
  ];

  const state: StepState = { toolCalls: 0, toolBytes: 0, trace: [], pending: null, served: new Set() };
  let lastText = "";
  let steps = 0;
  let truncated = false;
  const startedAt = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  const finish = (answer: string, stopReason: AgentStopReason): AgentResult => {
    logger.info(
      {
        event: "claude_agent_turn",
        fbUserId: hashPii(tools.ctx.fbUserId),
        stopReason,
        steps,
        toolCalls: state.toolCalls,
        elapsedMs: Date.now() - startedAt,
        truncated,
        ...usage,
      },
      "Claude agent turn finished",
    );
    return {
      answer: truncated ? `${answer}

${TRUNCATED_NOTE}` : answer,
      toolTrace: state.trace,
      pendingConfirmation: state.pending,
      stopReason,
      model: client.model,
      steps,
    };
  };

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const remainingMs = MAX_TURN_MS - (Date.now() - startedAt);
    if (remainingMs < MIN_STEP_MS) {
      return finish(
        lastText ||
          "Bu soru için gereken verileri ayrılan sürede toplayamadım. Soruyu biraz daraltıp (tek bir kampanya ya da daha kısa bir tarih aralığı) tekrar dener misiniz?",
        "timeout",
      );
    }

    steps = step + 1;
    const response = await client.createMessage({
      system,
      messages,
      tools: toolDefinitions,
      timeoutMs: remainingMs,
    });

    usage.inputTokens += response.usage?.input_tokens ?? 0;
    usage.outputTokens += response.usage?.output_tokens ?? 0;
    usage.cacheReadTokens += response.usage?.cache_read_input_tokens ?? 0;

    // The whole content array goes back, thinking blocks included: the API
    // needs them verbatim to continue the same reasoning across tool calls.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      return finish(
        "Bu isteği yanıtlayamıyorum. Lütfen reklam verilerinizle ilgili başka bir soru sorun.",
        "refusal",
      );
    }

    // A reply cut at the output ceiling is not a complete answer, and handing
    // it over as though it were is exactly the kind of quiet wrongness this
    // assistant must not produce.
    if (response.stop_reason === "max_tokens") truncated = true;

    const text = textOf(response.content);
    if (text) lastText = text;

    const toolUses = toolUsesOf(response.content);
    if (toolUses.length === 0) {
      return finish(lastText || fallbackAnswer(state.pending), state.pending ? "awaiting_confirmation" : "answered");
    }

    // A write was staged on the previous step and the model reached for another
    // tool instead of explaining. Stop here rather than spending more steps.
    if (state.pending) {
      return finish(lastText || fallbackAnswer(state.pending), "awaiting_confirmation");
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (state.toolCalls >= MAX_TOOL_CALLS || state.toolBytes >= MAX_TOTAL_TOOL_BYTES) {
        results.push(
          resultBlock(
            use.id,
            {
              error: "tool_budget_exhausted",
              message: "No further data can be read for this question. Answer with what you already have.",
            },
            true,
          ),
        );
        continue;
      }
      state.toolCalls += 1;
      results.push(await executeToolUse(use, tools, state, input.allowWrites));
    }

    // All results for one assistant turn go back in a single user message —
    // splitting them would train the model out of parallel tool calls.
    messages.push({ role: "user", content: results });
  }

  return finish(
    lastText ||
      "Bu soruyu yanıtlamak için gereken veri adımlarını tamamlayamadım. Soruyu biraz daraltıp tekrar dener misiniz?",
    "max_steps",
  );
}

function fallbackAnswer(pending: PendingConfirmation | null): string {
  return pending
    ? `Onayınızı bekleyen bir işlem var: ${pending.title}. Ayrıntıları onay kutusunda görebilirsiniz.`
    : "Bu soruya verecek bir yanıt üretemedim. Soruyu biraz daha açık yazar mısınız?";
}

export { MAX_STEPS, MAX_TOOL_CALLS, MAX_TOOL_RESULT_BYTES, MAX_TURN_MS, TRUNCATED_NOTE };
