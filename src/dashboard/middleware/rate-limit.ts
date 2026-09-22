import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createSlidingWindowLimiter } from "../../utils/sliding-window-limiter.js";
import { logger } from "../../utils/logger.js";
import { hashPii } from "../../auth/token-store.js";
import { getDashboardSession } from "./require-session.js";

/**
 * Per-signed-in-user ceiling, on top of the per-IP limiter in the HTTP
 * transport. A dashboard page load costs several Meta calls against a quota
 * shared with the MCP tools, so a stuck refresh loop in one tab must not be
 * able to trip the circuit breaker for the agent using the same token.
 *
 * In-memory, therefore per instance — the effective ceiling multiplies by the
 * running instance count, exactly like every other limiter here.
 */
const DEFAULT_LIMIT = 120;
const DEFAULT_WINDOW_MS = 60_000;

export function dashboardRateLimit(
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
        { event: "dashboard_rate_limited", fbUserId: hashPii(session.fbUserId) },
        "Dashboard rate limit exceeded",
      );
      res.status(429).json({
        error: { code: "rate_limited", message: "Too many requests. Try again shortly." },
      });
      return;
    }
    next();
  };
}
