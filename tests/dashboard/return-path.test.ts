import { describe, expect, it } from "vitest";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { safeReturnTo, validateMetaAuthReturn } from "../../src/transport/auth-routes.js";
import { DASHBOARD_PATH } from "../../src/dashboard/paths.js";

const noClients = async (_id: string): Promise<OAuthClientInformationFull | undefined> => undefined;

/**
 * The dashboard is reachable from a signed-out browser, so /auth/meta has to
 * accept it as a return destination. These pin that the allowance is exactly
 * one extra literal path and nothing wider.
 */
describe("dashboard OAuth return path", () => {
  it("accepts /dashboard as a standalone return target", async () => {
    await expect(validateMetaAuthReturn(DASHBOARD_PATH, noClients)).resolves.toBe(DASHBOARD_PATH);
  });

  it("still accepts the connections page", async () => {
    await expect(validateMetaAuthReturn("/auth/connections", noClients)).resolves.toBe(
      "/auth/connections",
    );
  });

  it("does not accept a dashboard sub-path or query", async () => {
    await expect(validateMetaAuthReturn("/dashboard/campaigns", noClients)).resolves.toBeNull();
    await expect(validateMetaAuthReturn("/dashboard?next=x", noClients)).resolves.toBeNull();
  });

  it("does not accept a prefix-matching impostor", async () => {
    await expect(validateMetaAuthReturn("/dashboardx", noClients)).resolves.toBeNull();
    await expect(validateMetaAuthReturn("/dashboard.evil", noClients)).resolves.toBeNull();
  });

  it("still rejects every off-site shape", async () => {
    for (const input of [
      "https://evil.example/dashboard",
      "//evil.example/dashboard",
      "/\\evil.example/dashboard",
      "/dashboard\n/evil",
      "dashboard",
    ]) {
      await expect(validateMetaAuthReturn(input, noClients), input).resolves.toBeNull();
    }
  });

  it("keeps /authorize gated on client_id and redirect_uri", async () => {
    await expect(
      validateMetaAuthReturn("/authorize?client_id=x", noClients),
    ).resolves.toBeNull();
  });

  it("allows /dashboard as an explicit safeReturnTo fallback", () => {
    expect(safeReturnTo(undefined, DASHBOARD_PATH)).toBe(DASHBOARD_PATH);
    expect(safeReturnTo("https://evil.example", DASHBOARD_PATH)).toBe(DASHBOARD_PATH);
  });

  it("leaves the default fallback untouched", () => {
    expect(safeReturnTo(undefined)).toBe("/authorize");
  });
});
