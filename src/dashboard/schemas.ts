import { z } from "zod";

/**
 * The seven presets the UI offers, plus `custom`. Each maps onto a Meta
 * `date_preset` so the range is resolved in the ad account's own timezone —
 * resolving dates ourselves would silently shift every boundary for accounts
 * outside the server's timezone.
 */
export const DATE_PRESETS = [
  "today",
  "yesterday",
  "last_7d",
  "last_14d",
  "last_30d",
  "this_month",
  "last_month",
] as const;

export type DatePresetKey = (typeof DATE_PRESETS)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Date must be a real calendar date");

/** Exported so the Claude tool schemas can carry the identical range contract. */
export const dateRangeShape = {
  preset: z.enum([...DATE_PRESETS, "custom"]).default("last_30d"),
  since: isoDate.optional(),
  until: isoDate.optional(),
};

export interface RangeLike {
  preset: DatePresetKey | "custom";
  since?: string;
  until?: string;
}

/**
 * Cross-field checks shared by every schema that carries a range. Written as a
 * standalone refinement so each schema finishes its object shape first —
 * a refined schema can no longer be extended.
 */
export function checkRange(value: RangeLike, ctx: z.RefinementCtx): void {
  if (value.preset !== "custom") return;
  if (value.since === undefined || value.until === undefined) {
    ctx.addIssue({ code: "custom", message: "Custom ranges require both since and until" });
    return;
  }
  if (Date.parse(value.since) > Date.parse(value.until)) {
    ctx.addIssue({ code: "custom", message: "since must not be after until" });
  }
}

export const dateRangeSchema = z.object(dateRangeShape).superRefine(checkRange);

export type DateRangeInput = z.output<typeof dateRangeSchema>;

/** Account ids arriving from the browser are only ever the act_-prefixed numeric form. */
export const accountIdSchema = z
  .string()
  .regex(/^act_\d{1,30}$/, "Account id must look like act_<numeric>");

export const CAMPAIGN_STATUS_FILTERS = ["ALL", "ACTIVE", "PAUSED", "ARCHIVED", "DELETED"] as const;

export const campaignQuerySchema = z
  .object({
    ...dateRangeShape,
    status: z.enum(CAMPAIGN_STATUS_FILTERS).default("ALL"),
    q: z.string().max(200).optional(),
  })
  .superRefine(checkRange);

export type CampaignQueryInput = z.output<typeof campaignQuerySchema>;

export interface ResolvedRange {
  /** Passed to Meta as `date_preset`; null when the caller supplied explicit dates. */
  datePreset: DatePresetKey | null;
  timeRange: { since: string; until: string } | null;
  /** Echoed back to the browser so the header can render what was actually queried. */
  label: string;
  since: string | null;
  until: string | null;
}

export function resolveRange(input: RangeLike): ResolvedRange {
  if (input.preset === "custom") {
    // checkRange has already guaranteed both are present by the time a parsed
    // value reaches here.
    const since = input.since as string;
    const until = input.until as string;
    return { datePreset: null, timeRange: { since, until }, label: "custom", since, until };
  }
  return {
    datePreset: input.preset,
    timeRange: null,
    label: input.preset,
    since: null,
    until: null,
  };
}

// ─── Phase 2: drill-down ─────────────────────────────────────────

/**
 * Campaign, ad set and ad ids as they arrive from the browser: bare numerics.
 * The service layer re-validates with `validateMetaId` before the id touches a
 * Graph path; this is the cheap first gate so a malformed id never reaches a
 * Meta call.
 */
export const entityIdSchema = z
  .string()
  .regex(/^\d{1,30}$/, "Entity id must be numeric");

/** Query-string booleans arrive as "1"/"true"; anything else is false. */
const flag = z
  .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
  .optional()
  .transform((value) => value === "1" || value === "true");

/**
 * The previous-period comparison costs an extra Meta call against a quota
 * shared with the MCP tools, so it is opt-in rather than always-on: the
 * drill-down tables omit it, the overview and the detail drawer ask for it.
 */
export const entityInsightsQuerySchema = z
  .object({ ...dateRangeShape, compare: flag })
  .superRefine(checkRange);

export type EntityInsightsQueryInput = z.output<typeof entityInsightsQuerySchema>;

// ─── Phase 3: AI analysis ────────────────────────────────────────

/**
 * Which slice of the account the question is about. The id is authorized
 * through the same entity gates the drill-down uses, so a scope cannot reach an
 * object the caller could not already open in the UI.
 */
export const AI_SCOPE_LEVELS = ["account", "campaign", "adset"] as const;

export type AiScopeLevel = (typeof AI_SCOPE_LEVELS)[number];

/**
 * The question is only length-bounded here; `sanitizeQuestion` does the real
 * validation and normalization. Two gates rather than one: this one keeps an
 * oversized body from ever reaching the sanitizer, and it is the same schema
 * layer every other dashboard input goes through.
 */
export const aiRequestSchema = z
  .object({
    ...dateRangeShape,
    question: z.string().max(500).optional(),
    level: z.enum(AI_SCOPE_LEVELS).default("account"),
    entityId: entityIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    checkRange(value, ctx);
    if (value.level !== "account" && value.entityId === undefined) {
      ctx.addIssue({ code: "custom", message: "entityId is required for a campaign or adset scope" });
    }
  });

export type AiRequestInput = z.output<typeof aiRequestSchema>;

/**
 * The agentic chat turn.
 *
 * History arrives from the browser as plain text only — never tool blocks —
 * and is bounded here before `sanitizeHistory` strips it. A forged assistant
 * turn buys nothing: it carries no authority, and every tool call the model
 * makes is re-validated and re-authorized server-side regardless of what the
 * history claims happened earlier.
 */
export const aiChatSchema = z.object({
  message: z.string().max(500),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(4000),
      }),
    )
    .max(20)
    .optional(),
  /** Lets a caller opt out of write tools for one turn; the server can also disable them globally. */
  allowWrites: z.boolean().optional(),
});

export type AiChatInput = z.output<typeof aiChatSchema>;

/**
 * Approving or discarding a staged write. The id is the ONLY thing the browser
 * sends: the parameters live server-side, so an approval cannot change them.
 */
export const aiConfirmSchema = z.object({
  confirmationId: z.string().uuid(),
  decision: z.enum(["approve", "cancel"]).default("approve"),
});

export type AiConfirmInput = z.output<typeof aiConfirmSchema>;

export const entityListQuerySchema = z
  .object({
    ...dateRangeShape,
    status: z.string().max(40).optional(),
    q: z.string().max(200).optional(),
  })
  .superRefine(checkRange);

export type EntityListQueryInput = z.output<typeof entityListQuerySchema>;
