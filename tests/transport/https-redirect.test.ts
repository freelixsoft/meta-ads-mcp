import { describe, expect, it } from "vitest";
import { shouldRedirectToHttps } from "../../src/transport/http.js";

/**
 * In production every request arrives through Cloud Run's proxy, which sets
 * `x-forwarded-proto`, and anything that did not is bounced to https.
 *
 * Health probes are the exception, and the reason is operational rather than
 * cosmetic: they reach the container port directly, with no proxy and so no
 * header, and a 301 makes a healthy instance look dead. The Dockerfile's own
 * HEALTHCHECK does exactly that, and so would an HTTP startup probe.
 */
describe("shouldRedirectToHttps", () => {
  it("lets an https request through", () => {
    expect(shouldRedirectToHttps({ path: "/dashboard", forwardedProto: "https" })).toBe(false);
  });

  it("redirects plain http on every ordinary path", () => {
    for (const path of ["/", "/dashboard", "/api/dashboard/ai/status", "/auth/meta", "/mcp"]) {
      expect(shouldRedirectToHttps({ path, forwardedProto: "http" })).toBe(true);
      expect(shouldRedirectToHttps({ path })).toBe(true);
    }
  });

  it("never redirects the health endpoint, with or without the header", () => {
    expect(shouldRedirectToHttps({ path: "/health" })).toBe(false);
    expect(shouldRedirectToHttps({ path: "/health", forwardedProto: "http" })).toBe(false);
    expect(shouldRedirectToHttps({ path: "/health", forwardedProto: "https" })).toBe(false);
  });

  it("exempts only that exact path, not anything that merely starts with it", () => {
    // A prefix match here would exempt a future /healthz-style route, or worse,
    // anything an attacker could shape into the prefix.
    expect(shouldRedirectToHttps({ path: "/healthz" })).toBe(true);
    expect(shouldRedirectToHttps({ path: "/health/secrets" })).toBe(true);
    expect(shouldRedirectToHttps({ path: "/api/health" })).toBe(true);
  });
});
