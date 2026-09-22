import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getSession, type SessionPayload } from "../../auth/session.js";
import { DASHBOARD_PATH } from "../paths.js";

/**
 * The dashboard has no login of its own. It reads the same `__Host-mcp_session`
 * cookie the consent and connections pages already use, so signing out there
 * signs out here, and a revoked jti kills both at once.
 */
export { DASHBOARD_PATH };

export type DashboardRequest = Request & { dashboardSession?: SessionPayload };

export function getDashboardSession(req: Request): SessionPayload {
  const session = (req as DashboardRequest).dashboardSession;
  if (!session) {
    // Unreachable behind requireDashboardSession; thrown rather than typed
    // away so a future route that forgets the middleware fails loudly.
    throw new Error("Dashboard session missing — requireDashboardSession did not run");
  }
  return session;
}

/**
 * `onMissing` splits the two callers: the SPA shell is a top-level navigation
 * that should bounce through Meta login, while an XHR must get a status the
 * frontend can act on — a 302 to Meta inside fetch() would be followed
 * opaquely and surface as a CORS failure instead of a sign-in prompt.
 */
export function requireDashboardSession(
  onMissing: "json" | "redirect",
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const session = await getSession(req);
      if (session) {
        (req as DashboardRequest).dashboardSession = session;
        next();
        return;
      }

      if (onMissing === "redirect") {
        res.redirect(302, `/auth/meta?return=${encodeURIComponent(DASHBOARD_PATH)}`);
        return;
      }

      res.status(401).json({
        error: {
          code: "unauthenticated",
          message: "Sign in with Meta to use the dashboard.",
        },
      });
    })();
  };
}
