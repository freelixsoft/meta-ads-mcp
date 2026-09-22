import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const SESSION_HEADER = "x-test-session";
const getSessionMock = vi.fn();

vi.mock("../../src/auth/session.js", () => ({
  getSession: (req: { headers: Record<string, string | undefined> }) =>
    getSessionMock(req.headers[SESSION_HEADER]),
  setSession: vi.fn(),
  clearSession: vi.fn(),
  configureSessionJtiStore: vi.fn(),
}));

const { default: express } = await import("express");
const { mountDashboardStatic } = await import("../../src/dashboard/static.js");

const SESSION = { fbUserId: "1000000000001", email: "ops@example.com", name: "Ops User" };

let server: Server;
let baseUrl: string;

function request(path: string, withSession: boolean): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: withSession ? { [SESSION_HEADER]: "valid" } : {},
    redirect: "manual",
  });
}

beforeAll(async () => {
  const app = express();
  mountDashboardStatic(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  getSessionMock.mockImplementation(async (marker: string | undefined) =>
    marker === "valid" ? SESSION : null,
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dashboard shell session gate", () => {
  it("redirects a signed-out page request into the existing Meta login flow", async () => {
    const response = await request("/dashboard", false);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/meta?return=%2Fdashboard");
  });

  it("redirects deep links the same way, so the SPA route survives login", async () => {
    const response = await request("/dashboard/campaigns", false);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/meta?return=%2Fdashboard");
  });

  it("gates the built assets too", async () => {
    const response = await request("/dashboard/assets/index.js", false);
    expect(response.status).toBe(302);
  });

  it("serves the shell to a signed-in user", async () => {
    const response = await request("/dashboard", true);
    // 200 with a build present, 503 with the dev notice when there is none;
    // either way it is served, not redirected.
    expect([200, 503]).toContain(response.status);
    expect(response.headers.get("location")).toBeNull();
  });

  it("locks the shell down with a script-src 'self' CSP and no inline allowance", async () => {
    const response = await request("/dashboard", true);
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("never lets the per-user shell into a shared cache", async () => {
    const response = await request("/dashboard", true);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
  });
});
