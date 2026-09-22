import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { logger } from "../utils/logger.js";
import { hashPii } from "../auth/token-store.js";
import { getDefaultTokenName, listTokens } from "../store/meta-token-repo.js";
import { toDashboardError } from "./errors.js";
import {
  userInitialsFrom,
  type AdAccountDto,
  type EntityListResponseDto,
  type EntityRowDto,
  type SessionResponseDto,
} from "./dto.js";
import {
  accountIdSchema,
  aiChatSchema,
  aiConfirmSchema,
  aiRequestSchema,
  campaignQuerySchema,
  entityIdSchema,
  entityInsightsQuerySchema,
  entityListQuerySchema,
  resolveRange,
  type ResolvedRange,
} from "./schemas.js";
import { requireDashboardSession, getDashboardSession } from "./middleware/require-session.js";
import { getMetaTokenHash, withMetaContext } from "./middleware/with-meta-context.js";
import { limitBodySize, requireSameOriginForMutations } from "./middleware/csrf.js";
import { dashboardRateLimit } from "./middleware/rate-limit.js";
import { aiRateLimit } from "./middleware/ai-rate-limit.js";
import {
  applyDashboardConfirmation,
  getAiStatus,
  runDashboardAnalysis,
  runDashboardChat,
} from "./ai/service.js";
import { discardWrite } from "../claude/confirmations.js";
import { recordAudit } from "../store/audit-log.js";
import { authorizeAccount, listAccessibleAccounts, type DashboardContext } from "./services/accounts.js";
import { getCampaignsWithMetrics } from "./services/campaigns.js";
import {
  authorizeAd,
  authorizeAdSet,
  authorizeCampaign,
  listAdSetsOfCampaign,
  listAdsOfAdSet,
  type EntityRef,
} from "./services/entities.js";
import { getAccountInsights, getChildRows, getEntityInsights } from "./services/entity-insights.js";
import { filterEntityRows } from "./services/entity-filters.js";

/** Express 5 forwards rejected promises, but wrapping keeps that explicit at every route. */
function wrap(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

function contextOf(req: Request): DashboardContext {
  return {
    fbUserId: getDashboardSession(req).fbUserId,
    tokenHash: getMetaTokenHash(req),
  };
}

/** Express 5 keeps `req.query` a null-prototype object; zod needs a plain one. */
function queryOf(req: Request): Record<string, unknown> {
  return { ...(req.query as Record<string, unknown>) };
}

/**
 * A JSON body, or an empty object. A missing, array or scalar body is treated
 * as "no fields supplied" so the schema decides what is required, rather than
 * the handler throwing on a shape it did not expect.
 */
function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>) }
    : {};
}

/**
 * Every account-scoped route starts here: the `act_*` in the path is checked
 * against the accounts the connected token can actually reach, before anything
 * else runs.
 */
async function resolveAccount(
  req: Request,
): Promise<{ ctx: DashboardContext; account: AdAccountDto }> {
  const ctx = contextOf(req);
  const accountId = accountIdSchema.parse(req.params.accountId);
  return { ctx, account: await authorizeAccount(ctx, accountId) };
}

function buildListResponse(
  account: AdAccountDto,
  range: ResolvedRange,
  parent: EntityRef,
  rows: EntityRowDto[],
  filter: { status?: string; q?: string },
): EntityListResponseDto {
  const filtered = filterEntityRows(rows, filter);
  filtered.sort((a, b) => b.metrics.spend - a.metrics.spend);
  return {
    account: { id: account.id, name: account.name, currency: account.currency },
    range: { preset: range.label, since: range.since, until: range.until },
    parent: { level: parent.level, id: parent.id, name: parent.name },
    rows: filtered,
  };
}

export function createDashboardApiRouter(serverUrl: URL): express.Router {
  const router = express.Router();

  router.use(limitBodySize());
  router.use(requireDashboardSession("json"));
  router.use(requireSameOriginForMutations());
  router.use(dashboardRateLimit());
  // Dashboard responses are per-user and must never enter a shared cache.
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");
    next();
  });

  // Deliberately outside withMetaContext: the UI needs to render the shell and
  // a "reconnect Meta" state for a signed-in user whose token is gone.
  router.get(
    "/session",
    wrap(async (req, res) => {
      const session = getDashboardSession(req);
      const [tokens, activeName] = await Promise.all([
        listTokens(session.fbUserId),
        getDefaultTokenName(session.fbUserId),
      ]);
      const active = tokens.find((token) => token.name === activeName) ?? null;

      const payload: SessionResponseDto = {
        user: {
          name: session.name,
          email: session.email,
          initials: userInitialsFrom(session.name, session.email),
        },
        meta: {
          connected: active !== null && !active.isExpired,
          tokenName: active?.name ?? null,
          businessName: active?.businessName ?? null,
          expiresAt: active?.expiresAt ?? null,
          isExpired: active?.isExpired ?? false,
        },
      };
      res.json(payload);
    }),
  );

  const metaContext = withMetaContext(serverUrl);

  router.get(
    "/accounts",
    metaContext,
    wrap(async (req, res) => {
      const accounts = await listAccessibleAccounts(contextOf(req));
      res.json({ accounts });
    }),
  );

  router.get(
    "/accounts/:accountId/insights",
    metaContext,
    wrap(async (req, res) => {
      const { ctx, account } = await resolveAccount(req);
      const query = entityInsightsQuerySchema.parse(queryOf(req));
      const range = resolveRange(query);
      res.json(await getAccountInsights(ctx, account, range, { compare: query.compare }));
    }),
  );

  router.get(
    "/accounts/:accountId/campaigns",
    metaContext,
    wrap(async (req, res) => {
      const { ctx, account } = await resolveAccount(req);
      const query = campaignQuerySchema.parse(queryOf(req));
      res.json(await getCampaignsWithMetrics(ctx, account, resolveRange(query), query));
    }),
  );

  // ─── Drill-down: campaign → ad set → ad ──────────────────────
  //
  // The parent is authorized as well as the child, so an ad set id cannot be
  // read through a campaign it does not belong to, and neither can be read
  // through an account that does not own it.

  router.get(
    "/accounts/:accountId/campaigns/:campaignId/adsets",
    metaContext,
    wrap(async (req, res) => {
      const { ctx, account } = await resolveAccount(req);
      const campaign = await authorizeCampaign(
        ctx,
        account,
        entityIdSchema.parse(req.params.campaignId),
      );
      const query = entityListQuerySchema.parse(queryOf(req));
      const range = resolveRange(query);
      const children = await listAdSetsOfCampaign(ctx, account, campaign);
      const rows = await getChildRows(ctx, account, campaign, "adset", range, children);
      res.json(buildListResponse(account, range, campaign, rows, query));
    }),
  );

  router.get(
    "/accounts/:accountId/adsets/:adsetId/ads",
    metaContext,
    wrap(async (req, res) => {
      const { ctx, account } = await resolveAccount(req);
      const adSet = await authorizeAdSet(ctx, account, entityIdSchema.parse(req.params.adsetId));
      const query = entityListQuerySchema.parse(queryOf(req));
      const range = resolveRange(query);
      const children = await listAdsOfAdSet(ctx, account, adSet);
      const rows = await getChildRows(ctx, account, adSet, "ad", range, children);
      res.json(buildListResponse(account, range, adSet, rows, query));
    }),
  );

  type Authorizer = (
    ctx: DashboardContext,
    account: AdAccountDto,
    id: string,
  ) => Promise<EntityRef>;

  /** One handler shape for all three levels — the only difference is who authorizes the id. */
  const mountEntityInsights = (segment: string, param: string, authorize: Authorizer): void => {
    router.get(
      `/accounts/:accountId/${segment}/:${param}/insights`,
      metaContext,
      wrap(async (req, res) => {
        const { ctx, account } = await resolveAccount(req);
        const entity = await authorize(ctx, account, entityIdSchema.parse(req.params[param]));
        const query = entityInsightsQuerySchema.parse(queryOf(req));
        res.json(
          await getEntityInsights(ctx, account, entity, resolveRange(query), {
            compare: query.compare,
          }),
        );
      }),
    );
  };

  mountEntityInsights("campaigns", "campaignId", authorizeCampaign);
  mountEntityInsights("adsets", "adsetId", authorizeAdSet);
  mountEntityInsights("ads", "adId", authorizeAd);

  // ─── Phase 3: AI analysis ────────────────────────────────────
  //
  // POST rather than GET for both analysis routes: the question is user text
  // that has no business in a URL, an access log or the browser's history, and
  // POST puts it behind the same-origin check that GETs do not need.

  router.get(
    "/ai/status",
    metaContext,
    wrap(async (_req, res) => {
      res.json(await getAiStatus());
    }),
  );

  const aiLimiter = aiRateLimit();

  /** Both routes share one service call; they differ only in whether a question is required. */
  const mountAiAnalysis = (segment: "ask" | "summary"): void => {
    router.post(
      `/accounts/:accountId/ai/${segment}`,
      aiLimiter,
      metaContext,
      wrap(async (req, res) => {
        const { ctx, account } = await resolveAccount(req);
        const input = aiRequestSchema.parse(bodyOf(req));
        res.json(
          await runDashboardAnalysis(ctx, account, resolveRange(input), input, {
            requireQuestion: segment === "ask",
          }),
        );
      }),
    );
  };

  mountAiAnalysis("ask");
  mountAiAnalysis("summary");

  // The agentic surface: Claude may call bounded read tools on its own, and may
  // *propose* a write — which is staged for confirmation, never sent.
  router.post(
    "/accounts/:accountId/ai/chat",
    aiLimiter,
    metaContext,
    wrap(async (req, res) => {
      const { ctx, account } = await resolveAccount(req);
      const input = aiChatSchema.parse(bodyOf(req));
      res.json(await runDashboardChat(ctx, account, input));
    }),
  );

  // The one route in the dashboard that can reach Meta with a write. It carries
  // no parameters of its own: the change was validated, authorized and stored
  // server-side when it was proposed, and this only says yes or no to it.
  const confirmLimiter = aiRateLimit({ limit: 10, windowMs: 10 * 60_000 });
  router.post(
    "/accounts/:accountId/ai/confirm",
    confirmLimiter,
    metaContext,
    wrap(async (req, res) => {
      const { ctx, account } = await resolveAccount(req);
      const input = aiConfirmSchema.parse(bodyOf(req));

      if (input.decision === "cancel") {
        const staged = discardWrite(input.confirmationId, {
          fbUserId: ctx.fbUserId,
          accountId: account.id,
        });
        // A proposal the user turned down is evidence about the assistant's
        // judgement; a trail that keeps only the approvals flatters it.
        if (staged) {
          await recordAudit(ctx.fbUserId, {
            at: new Date().toISOString(),
            userHash: hashPii(ctx.fbUserId),
            accountId: account.id,
            accountName: staged.accountName,
            tool: staged.plan.tool,
            level: staged.plan.verify.level,
            objectId: staged.plan.verify.id,
            objectName: staged.plan.fields[0]?.value ?? null,
            before: staged.plan.expected,
            after: staged.plan.body,
            reason: staged.plan.reason,
            outcome: "rejected",
            verified: null,
            errorCode: null,
          });
        }
        res.json({ applied: false, discarded: staged !== null });
        return;
      }

      res.json(await applyDashboardConfirmation(ctx, account, input.confirmationId));
    }),
  );

  router.use((_req, res) => {
    res.status(404).json({ error: { code: "invalid_request", message: "Unknown endpoint." } });
  });

  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const mapped = toDashboardError(error);
    const session = (req as Request & { dashboardSession?: { fbUserId: string } }).dashboardSession;
    logger[mapped.status >= 500 ? "error" : "warn"](
      {
        event: "dashboard_request_failed",
        path: req.path,
        code: mapped.code,
        status: mapped.status,
        fbUserId: hashPii(session?.fbUserId),
        error: error instanceof Error ? error.message : String(error),
      },
      "Dashboard request failed",
    );
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
  });

  return router;
}
