import type { NextFunction, Request, RequestHandler, Response } from "express";
import { hashPii, hashToken, requestContext } from "../../auth/token-store.js";
import { getDecryptedToken } from "../../store/meta-token-repo.js";
import { logger } from "../../utils/logger.js";
import { getDashboardSession, type DashboardRequest } from "./require-session.js";

export type MetaContextRequest = DashboardRequest & { metaTokenHash?: string };

/**
 * Puts the caller's decrypted Meta token into the same AsyncLocalStorage the
 * MCP path uses, so `metaApiClient` — and the shared rate limiter, circuit
 * breaker and per-tenant credential resolution hanging off it — behave
 * identically for a dashboard request and a tool call.
 *
 * This is the only place the dashboard touches a token, and it never leaves
 * the store: no request property, no response body, no log line. Only the
 * 12-hex hash is attached to the request, for cache partitioning.
 */
export function withMetaContext(serverUrl: URL): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const session = getDashboardSession(req);

      let accessToken: string;
      try {
        accessToken = await getDecryptedToken(session.fbUserId, undefined, serverUrl);
      } catch (error) {
        logger.warn(
          {
            event: "dashboard_meta_token_unavailable",
            fbUserId: hashPii(session.fbUserId),
            error: error instanceof Error ? error.message : String(error),
          },
          "Dashboard request could not resolve a Meta token",
        );
        res.status(401).json({
          error: {
            code: "meta_not_connected",
            message: "No Meta token is connected for this user.",
          },
        });
        return;
      }

      (req as MetaContextRequest).metaTokenHash = hashToken(accessToken);
      requestContext.run({ accessToken, fbUserId: session.fbUserId }, () => next());
    })();
  };
}

export function getMetaTokenHash(req: Request): string {
  const hash = (req as MetaContextRequest).metaTokenHash;
  if (!hash) throw new Error("Meta context missing — withMetaContext did not run");
  return hash;
}
