import type { NextFunction, Request, RequestHandler, Response } from "express";
import { isSameOriginRequest } from "../../transport/auth-routes.js";
import { logger } from "../../utils/logger.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Nothing in Phase 1 accepts a body; the ceiling is here so the first route that does inherits it. */
export const MAX_DASHBOARD_BODY_BYTES = 32 * 1024;

/**
 * State-changing dashboard routes must be same-origin.
 *
 * Reuses the exact check the Apify and Gemini forms already run
 * (Sec-Fetch-Site first, Origin compared against the origin the browser
 * actually contacted). The session cookie is SameSite=Lax, which stops a
 * cross-site POST but not a sibling subdomain on a custom domain — this closes
 * that gap. Phase 1 exposes only GET routes, so this is currently a no-op that
 * exists to be already in place when the first mutation lands.
 */
export function requireSameOriginForMutations(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const sameOrigin = isSameOriginRequest({
      secFetchSite: req.get("sec-fetch-site"),
      origin: req.get("origin"),
      selfOrigin: `${req.protocol}://${req.get("host")}`,
    });

    if (!sameOrigin) {
      logger.warn(
        { event: "dashboard_cross_origin_rejected", path: req.path, method: req.method },
        "Rejected a cross-origin dashboard request",
      );
      res.status(403).json({
        error: { code: "invalid_request", message: "Cross-origin request rejected." },
      });
      return;
    }

    next();
  };
}

/**
 * Declared-length ceiling for dashboard writes.
 *
 * Note the ordering caveat: the app-wide `express.json({ limit: "10mb" })` in
 * the HTTP transport runs before this router, so an oversize body has already
 * been buffered by the time this rejects it. This guard is the policy gate for
 * the dashboard surface; making it byte-effective needs the router mounted
 * ahead of that global parser, which is a transport change and not Phase 1.
 */
export function limitBodySize(maxBytes = MAX_DASHBOARD_BODY_BYTES): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const declared = Number.parseInt(req.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.status(413).json({
        error: { code: "invalid_request", message: "Request body too large." },
      });
      return;
    }
    next();
  };
}
