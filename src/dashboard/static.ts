import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { escapeHtml } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import { requireDashboardSession, DASHBOARD_PATH } from "./middleware/require-session.js";

/**
 * Where the built frontend lives, in preference order:
 *
 *  1. DASHBOARD_STATIC_DIR, for operators who stage the bundle elsewhere.
 *  2. `dist/public/`, one hop from `dist/dashboard/static.js` — the container
 *     layout the Dockerfile produces.
 *  3. `web/dist/`, where `npm run web:build` writes, so a local
 *     `npm run build && npm run web:build && npm start` serves the real SPA
 *     without an extra copy step.
 *
 * Running from source with tsx and no build at all matches none of them, which
 * is the dev path handled by renderDevNotice().
 */
function resolveStaticDir(): string | null {
  const override = process.env.DASHBOARD_STATIC_DIR?.trim();
  const candidates = override
    ? [path.resolve(override)]
    : [
        fileURLToPath(new URL("../public/", import.meta.url)),
        fileURLToPath(new URL("../../web/dist/", import.meta.url)),
      ];
  return candidates.find((dir) => existsSync(path.join(dir, "index.html"))) ?? null;
}

/**
 * No 'unsafe-inline' anywhere: Vite emits hashed external assets, so the
 * strictest policy that still works is the one we ship. `img-src` allows the
 * Meta CDN for profile and creative thumbnails; `connect-src 'self'` keeps the
 * SPA talking only to this origin.
 */
const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://*.fbcdn.net https://*.facebook.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

function setShellHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", DASHBOARD_CSP);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Cookie");
}

function renderDevNotice(res: Response): void {
  setShellHeaders(res);
  res.status(503).type("html").send(
    `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ads AI Manager</title></head>
    <body><h1>Panel derlenmemis</h1>
    <p>Gelistirme sunucusu icin <code>npm run dev:all</code> calistirin ve
    <code>${escapeHtml("http://localhost:5173/dashboard/")}</code> adresini acin.</p>
    <p>Uretim derlemesi icin <code>npm run web:build</code>.</p>
    </body></html>`,
  );
}

/**
 * Serves the SPA under /dashboard.
 *
 * The session gate runs before any bytes are served, and it redirects rather
 * than 401s here: this is a top-level navigation, so bouncing through Meta
 * login and back is the behaviour a browser expects.
 */
export function mountDashboardStatic(app: express.Application): void {
  const staticDir = resolveStaticDir();
  const indexPath = staticDir ? path.join(staticDir, "index.html") : null;

  if (indexPath) {
    logger.info({ event: "dashboard_static_ready", staticDir }, "Serving the dashboard bundle");
  } else {
    logger.warn(
      { event: "dashboard_build_missing" },
      "No built dashboard found; /dashboard will explain how to build or run the dev server",
    );
  }

  const gate = requireDashboardSession("redirect");

  // Hashed filenames make the assets immutable; the shell must not be cached
  // or a deploy would keep serving the previous bundle's script tags.
  if (staticDir) {
    app.use(
      `${DASHBOARD_PATH}/assets`,
      gate,
      express.static(path.join(staticDir, "assets"), {
        immutable: true,
        maxAge: "1y",
        index: false,
        fallthrough: false,
        setHeaders: (res) => {
          res.setHeader("Content-Security-Policy", DASHBOARD_CSP);
        },
      }),
    );
  }

  app.get(`${DASHBOARD_PATH}{/*path}`, gate, (_req: Request, res: Response) => {
    if (!indexPath) {
      renderDevNotice(res);
      return;
    }
    setShellHeaders(res);
    res.sendFile(indexPath);
  });
}
