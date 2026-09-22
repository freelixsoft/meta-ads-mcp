import { hashPii } from "../../auth/token-store.js";
import { logger } from "../../utils/logger.js";
import { runAgent } from "../../claude/agent.js";
import { ClaudeError } from "../../claude/client.js";
import { discardWrite, takeWrite } from "../../claude/confirmations.js";
import { applyWritePlan, StaleWriteError, type WritePlan } from "../../claude/tools.js";
import type { ChatTurn } from "../../claude/types.js";
import { invalidateTenantCache } from "../cache.js";
import { DashboardError, toDashboardError } from "../errors.js";
import { recordAudit, type AuditEntry } from "../../store/audit-log.js";
import type {
  AdAccountDto,
  AiAnalysisResponseDto,
  AiChatResponseDto,
  AiConfirmResponseDto,
  AiStatusResponseDto,
  CampaignDto,
  EntityInsightsResponseDto,
  EntityLevel,
  EntityRowDto,
} from "../dto.js";
import type { AiChatInput, AiRequestInput, ResolvedRange } from "../schemas.js";
import type { DashboardContext } from "../services/accounts.js";
import { getCampaignsWithMetrics } from "../services/campaigns.js";
import {
  authorizeAdSet,
  authorizeCampaign,
  listAdSetsOfCampaign,
  listAdsOfAdSet,
} from "../services/entities.js";
import { getAccountInsights, getChildRows, getEntityInsights } from "../services/entity-insights.js";
import { buildAnalysisContext, serializedSize, type AiAnalysisContext } from "./context.js";
import {
  buildUserPrompt,
  MAX_DATA_GAPS,
  MAX_HIGHLIGHTS,
  MAX_OUTPUT_TOKENS,
  SYSTEM_INSTRUCTION,
} from "./prompt.js";
import { AiNotConfiguredError, getAiProvider, noteProviderFailure } from "./provider.js";
import { sanitizeBullets, sanitizeLine, sanitizeModelText, sanitizeQuestion } from "./sanitize.js";

/**
 * The dashboard's AI service.
 *
 * Two surfaces, one security model:
 *
 *  - **One-shot analysis** (`/ai/ask`, `/ai/summary`) sends a single bounded
 *    snapshot and gets prose back. No tools, no loop.
 *  - **Agentic chat** (`/ai/chat`) gives Claude a bounded tool surface and lets
 *    it drill down, then stages any proposed change for confirmation.
 *
 * Neither calls Meta itself. Every number comes from the same
 * `getAccountInsights` / `getEntityInsights` / `getChildRows` /
 * `getCampaignsWithMetrics` functions the drill-down UI uses, so there is one
 * Meta client, one cache, one guardrail path and one authorization model.
 */

const QUESTION_ERRORS: Record<"empty" | "too-short" | "too-long", string> = {
  empty: "The question is empty.",
  "too-short": "The question is too short.",
  "too-long": "The question is too long.",
};

/** Operator kill switch: set to "off" to run the assistant read-only. */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DASHBOARD_AI_WRITES?.trim().toLowerCase() !== "off";
}

/** History is untrusted browser input: bounded in turns and in characters. */
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_CHARS = 2000;

export function sanitizeHistory(history: AiChatInput["history"]): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({
      role: turn.role,
      content: sanitizeModelText(turn.content, MAX_HISTORY_CHARS),
    }))
    .filter((turn) => turn.content.length > 0);
}

/**
 * The campaigns endpoint predates the drill-down and keeps its Phase 1 shape,
 * so its rows are lifted into the shared row type here rather than by changing
 * an endpoint the existing tests pin.
 */
function campaignToRow(campaign: CampaignDto): EntityRowDto {
  return {
    id: campaign.id,
    level: "campaign",
    name: campaign.name,
    status: campaign.status,
    effectiveStatus: campaign.effectiveStatus,
    objective: campaign.objective,
    campaignId: campaign.id,
    campaignName: campaign.name,
    adSetId: null,
    adSetName: null,
    creativeId: null,
    dailyBudget: campaign.dailyBudget,
    lifetimeBudget: campaign.lifetimeBudget,
    metrics: campaign.metrics,
  };
}

interface ScopeData {
  insights: EntityInsightsResponseDto;
  breakdown: { level: EntityLevel; rows: EntityRowDto[] } | null;
}

async function loadScope(
  ctx: DashboardContext,
  account: AdAccountDto,
  range: ResolvedRange,
  input: AiRequestInput,
): Promise<ScopeData> {
  if (input.level === "campaign") {
    const campaign = await authorizeCampaign(ctx, account, input.entityId as string);
    const [insights, children] = await Promise.all([
      getEntityInsights(ctx, account, campaign, range, { compare: true }),
      listAdSetsOfCampaign(ctx, account, campaign),
    ]);
    const rows = await getChildRows(ctx, account, campaign, "adset", range, children);
    return { insights, breakdown: { level: "adset", rows } };
  }

  if (input.level === "adset") {
    const adSet = await authorizeAdSet(ctx, account, input.entityId as string);
    const [insights, children] = await Promise.all([
      getEntityInsights(ctx, account, adSet, range, { compare: true }),
      listAdsOfAdSet(ctx, account, adSet),
    ]);
    const rows = await getChildRows(ctx, account, adSet, "ad", range, children);
    return { insights, breakdown: { level: "ad", rows } };
  }

  const [insights, campaigns] = await Promise.all([
    getAccountInsights(ctx, account, range, { compare: true }),
    getCampaignsWithMetrics(ctx, account, range, { status: "ALL" }),
  ]);
  return {
    insights,
    breakdown: { level: "campaign", rows: campaigns.campaigns.map(campaignToRow) },
  };
}

/**
 * Failures are reported with a fixed message per code.
 *
 * Anthropic's own text is deliberately not forwarded: like Meta's, it can carry
 * request ids and provider detail that have no business in a browser response.
 * The original is logged server-side instead.
 */
export function toAiError(error: unknown): DashboardError {
  if (error instanceof DashboardError) return error;

  if (error instanceof AiNotConfiguredError) {
    return new DashboardError("ai_not_configured", 409, "No AI provider is configured on this server.");
  }

  if (error instanceof ClaudeError) {
    switch (error.code) {
      case "not_configured":
        return new DashboardError("ai_not_configured", 409, "The configured AI key was rejected.");
      case "rate_limited":
        return new DashboardError("ai_rate_limited", 429, "The AI provider is throttling this server.");
      default:
        return new DashboardError("ai_unavailable", 502, "The AI provider could not answer.");
    }
  }

  return new DashboardError("ai_unavailable", 502, "The AI request could not be completed.");
}

async function assertAvailable(): Promise<void> {
  const availability = await getAiProvider().availability();
  if (!availability.configured) throw toAiError(new AiNotConfiguredError());
}

interface ParsedAnswer {
  answer: string;
  highlights: string[];
  dataGaps: string[];
}

/** Model output is untrusted: shape-checked, bounded and stripped before it is trusted to be text. */
function parseModelAnswer(json: unknown): ParsedAnswer {
  const record = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const answer = sanitizeModelText(record.answer);
  if (answer.length === 0) {
    throw new DashboardError("ai_unavailable", 502, "The AI provider returned an empty answer.");
  }
  return {
    answer,
    highlights: sanitizeBullets(record.highlights, MAX_HIGHLIGHTS),
    dataGaps: sanitizeBullets(record.dataGaps, MAX_DATA_GAPS),
  };
}

export interface AnalysisOptions {
  /** Set by the /ai/ask route, where a question is the whole point. */
  requireQuestion: boolean;
}

export async function runDashboardAnalysis(
  ctx: DashboardContext,
  account: AdAccountDto,
  range: ResolvedRange,
  input: AiRequestInput,
  options: AnalysisOptions,
): Promise<AiAnalysisResponseDto> {
  let question: string | null = null;
  if (options.requireQuestion || input.question !== undefined) {
    const validated = sanitizeQuestion(input.question);
    if (!validated.ok) {
      throw new DashboardError("invalid_request", 400, QUESTION_ERRORS[validated.reason]);
    }
    question = validated.question;
  }

  await assertAvailable();

  const scope = await loadScope(ctx, account, range, input);
  const context: AiAnalysisContext = buildAnalysisContext({
    insights: scope.insights,
    breakdown: scope.breakdown,
  });

  const contextBytes = serializedSize(context);
  let result;
  try {
    result = await getAiProvider().generate({
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: buildUserPrompt({ context, question }),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (error) {
    logger.warn(
      {
        event: "dashboard_ai_generate_failed",
        fbUserId: hashPii(ctx.fbUserId),
        level: input.level,
        contextBytes,
        error: error instanceof Error ? error.message : String(error),
      },
      "Dashboard AI generation failed",
    );
    throw toAiError(error);
  }

  const parsed = parseModelAnswer(result.json);

  logger.info(
    {
      event: "dashboard_ai_analysis",
      fbUserId: hashPii(ctx.fbUserId),
      level: input.level,
      model: result.model,
      contextBytes,
      // The question text itself is never logged — only that there was one.
      questionChars: question?.length ?? 0,
    },
    "Dashboard AI analysis completed",
  );

  return {
    scope: { level: context.scope.level, name: context.scope.name },
    range: scope.insights.range,
    resolvedRange: scope.insights.resolvedRange,
    question,
    answer: parsed.answer,
    highlights: parsed.highlights,
    dataGaps: parsed.dataGaps,
    missingMetrics: context.missingMetrics,
    truncation: context.truncation,
    model: result.model,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Agentic chat ────────────────────────────────────────────────

export async function runDashboardChat(
  ctx: DashboardContext,
  account: AdAccountDto,
  input: AiChatInput,
): Promise<AiChatResponseDto> {
  const validated = sanitizeQuestion(input.message);
  if (!validated.ok) {
    throw new DashboardError("invalid_request", 400, QUESTION_ERRORS[validated.reason]);
  }

  await assertAvailable();

  const allowWrites = writesEnabled() && input.allowWrites !== false;

  let result;
  try {
    result = await runAgent(
      { ctx, account },
      { question: validated.question, history: sanitizeHistory(input.history), allowWrites },
    );
  } catch (error) {
    // The one-shot path records provider health inside the provider; the agent
    // talks to the Claude client directly, so without this a throttled or
    // unreachable provider would keep showing as "available" on /ai/status
    // while every chat turn failed.
    if (error instanceof ClaudeError) {
      noteProviderFailure(error.code === "rate_limited" ? "rate_limited" : "unavailable");
    }
    logger.warn(
      {
        event: "dashboard_ai_chat_failed",
        fbUserId: hashPii(ctx.fbUserId),
        code: error instanceof ClaudeError ? error.code : undefined,
        error: error instanceof Error ? error.message : String(error),
      },
      "Dashboard AI chat failed",
    );
    throw toAiError(error);
  }

  logger.info(
    {
      event: "dashboard_ai_chat",
      fbUserId: hashPii(ctx.fbUserId),
      model: result.model,
      steps: result.steps,
      tools: result.toolTrace.length,
      stopReason: result.stopReason,
      pendingWrite: result.pendingConfirmation?.tool ?? null,
      messageChars: validated.question.length,
    },
    "Dashboard AI chat completed",
  );

  return {
    answer: result.answer,
    toolTrace: result.toolTrace,
    confirmation: result.pendingConfirmation,
    stopReason: result.stopReason,
    model: result.model,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Confirmed writes ────────────────────────────────────────────

const APPLIED_MESSAGE: Record<string, string> = {
  meta_create_campaign: "Kampanya Meta'da oluşturuldu.",
  meta_update_campaign: "Kampanya güncellendi.",
  meta_create_ad_set: "Reklam seti oluşturuldu.",
  meta_update_ad_set: "Reklam seti güncellendi.",
  meta_create_ad: "Reklam oluşturuldu.",
  meta_update_ad: "Reklam güncellendi.",
};

/**
 * Execute a staged write, but only for the session and account that staged it,
 * only once, and only inside its ten-minute window. This is the single place in
 * the dashboard where a request reaches Meta with a method other than GET.
 */
/** The audit shape of one plan, before we know what happened to it. */
function auditOf(
  plan: WritePlan,
  accountId: string,
  accountName: string,
  fbUserId: string,
): Omit<AuditEntry, "outcome" | "verified" | "errorCode"> {
  return {
    at: new Date().toISOString(),
    userHash: hashPii(fbUserId),
    accountId,
    accountName,
    tool: plan.tool,
    level: plan.verify.level,
    objectId: plan.verify.id,
    objectName: plan.fields[0]?.value ?? null,
    before: plan.expected,
    after: plan.body,
    reason: plan.reason,
  };
}

export async function applyDashboardConfirmation(
  ctx: DashboardContext,
  account: AdAccountDto,
  confirmationId: string,
): Promise<AiConfirmResponseDto> {
  const owner = { fbUserId: ctx.fbUserId, accountId: account.id };

  // The kill switch is checked before the plan is claimed, so an operator who
  // turns writes off does not also consume the user's pending confirmation:
  // turning them back on leaves it usable rather than mysteriously gone.
  if (!writesEnabled()) {
    const staged = discardWrite(confirmationId, owner);
    if (staged) {
      await recordAudit(ctx.fbUserId, {
        ...auditOf(staged.plan, account.id, staged.accountName, ctx.fbUserId),
        outcome: "refused_writes_disabled",
        verified: null,
        errorCode: "writes_disabled",
      });
    }
    throw new DashboardError(
      "ai_writes_disabled",
      403,
      "Reklam değiştirme yetkisi bu sunucuda kapalı. Öneri hazırlandı ama Meta'ya hiçbir istek gönderilmedi.",
    );
  }

  const claimed = takeWrite(confirmationId, owner);
  if (!claimed.ok) {
    throw new DashboardError(
      "ai_confirmation_expired",
      409,
      "This confirmation is no longer valid. Ask for the change again.",
    );
  }

  const base = auditOf(claimed.plan, account.id, account.name, ctx.fbUserId);

  let applied;
  try {
    applied = await applyWritePlan(claimed.plan);
  } catch (error) {
    await recordAudit(ctx.fbUserId, {
      ...base,
      outcome: error instanceof StaleWriteError ? "refused_stale" : "failed",
      verified: null,
      errorCode: toDashboardError(error).code,
    });
    logger.error(
      {
        event: "dashboard_ai_write_failed",
        fbUserId: hashPii(ctx.fbUserId),
        tool: claimed.plan.tool,
        error: error instanceof Error ? error.message : String(error),
      },
      "Confirmed Meta write failed",
    );
    // Meta's own failure keeps its own classification (throttle, expired
    // connection, invalid parameters) — it is not an AI failure.
    throw error;
  }

  // The object at Meta is no longer what the cache holds. Dropped before the
  // response is built, so the next read — the chat turn the user almost always
  // takes next, asking whether it worked — cannot be served the pre-write
  // value out of a 60-second TTL. `applyWritePlan` throws if Meta refused the
  // write, so reaching this line means something did change.
  invalidateTenantCache(ctx);

  logger.info(
    {
      event: "dashboard_ai_write_applied",
      fbUserId: hashPii(ctx.fbUserId),
      tool: claimed.plan.tool,
      objectId: applied.id,
      verified: !applied.verificationFailed,
    },
    "Confirmed Meta write applied",
  );

  await recordAudit(ctx.fbUserId, {
    ...base,
    outcome: "applied",
    verified: applied.verified,
    errorCode: null,
  });

  const message = APPLIED_MESSAGE[claimed.plan.tool] ?? "İşlem tamamlandı.";
  return {
    applied: true,
    title: sanitizeLine(claimed.title, 200),
    answer: applied.verificationFailed
      ? `${message} Ancak sonucu Meta'dan doğrulayamadım; Ads Manager'dan kontrol edin.`
      : message,
    verified: applied.verified,
    verificationFailed: applied.verificationFailed,
    generatedAt: new Date().toISOString(),
  };
}

/** Discarding a staged write needs no Meta call and no confirmation of its own. */
export async function getAiStatus(): Promise<AiStatusResponseDto> {
  const availability = await getAiProvider().availability();
  return {
    configured: availability.configured,
    available: availability.available,
    rateLimited: availability.rateLimited,
    unavailable: availability.unavailable,
    model: availability.model,
    writesEnabled: writesEnabled(),
  };
}
