import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createSlidingWindowLimiter } from "../../utils/sliding-window-limiter.js";
import { logger } from "../../utils/logger.js";
import { hashPii } from "../../auth/token-store.js";
import { getDashboardSession } from "./require-session.js";

/**
 * A much tighter ceiling than the general dashboard limiter, applied on top of
 * it, because an AI request is not like the others: it is billed to the
 * operator's Anthropic key, it costs an order of magnitude more per call than a
 * Meta read, and one agent turn fans out into several Meta calls of its own. A
 * stuck retry loop in one tab must not be able to empty the AI budget for
 * everyone else on the server.
 *
 * In memory, therefore per instance — the effective ceiling multiplies by the
 * running instance count, exactly like every other limiter here.
 */
const DEFAULT_LIMIT = 15;
const DEFAULT_WINDOW_MS = 10 * 60_000;

export function aiRateLimit(
  options: { limit?: number; windowMs?: number } = {},
): RequestHandler {
  const limiter = createSlidingWindowLimiter({
    limit: options.limit ?? DEFAULT_LIMIT,
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
  });

  return (req: Request, res: Response, next: NextFunction) => {
    const session = getDashboardSession(req);
    const permit = limiter.acquire(session.fbUserId);
    if (!permit) {
      logger.warn(
        { event: "dashboard_ai_rate_limited", fbUserId: hashPii(session.fbUserId) },
        "Dashboard AI rate limit exceeded",
      );
      res.status(429).json({
        error: {
          code: "ai_rate_limited",
          message: "Too many AI requests. Try again shortly.",
        },
      });
      return;
    }
    next();
  };
}
