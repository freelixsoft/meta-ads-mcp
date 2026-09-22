import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * The dashboard layer is exercised over real HTTP against a real Express app.
 * Only its three seams are mocked — the browser session, the token store and
 * the Meta client — because those are exactly the boundaries the dashboard is
 * not allowed to reimplement.
 */

const SESSION_HEADER = "x-test-session";

const getSessionMock = vi.fn();
const getDecryptedTokenMock = vi.fn();
const listTokensMock = vi.fn();
const getDefaultTokenNameMock = vi.fn();
const metaGetMock = vi.fn();
const metaGetPaginatedMock = vi.fn();

vi.mock("../../src/auth/session.js", () => ({
  getSession: (req: { headers: Record<string, string | undefined> }) =>
    getSessionMock(req.headers[SESSION_HEADER]),
  setSession: vi.fn(),
  clearSession: vi.fn(),
  configureSessionJtiStore: vi.fn(),
}));

vi.mock("../../src/store/meta-token-repo.js", () => ({
  getDecryptedToken: (...args: unknown[]) => getDecryptedTokenMock(...args),
  listTokens: (...args: unknown[]) => listTokensMock(...args),
  getDefaultTokenName: (...args: unknown[]) => getDefaultTokenNameMock(...args),
}));

vi.mock("../../src/meta/client.js", () => ({
  metaApiClient: {
    get: (...args: unknown[]) => metaGetMock(...args),
    getPaginated: (...args: unknown[]) => metaGetPaginatedMock(...args),
  },
}));

const { default: express } = await import("express");
const { createDashboardApiRouter } = await import("../../src/dashboard/router.js");
const { dashboardCache } = await import("../../src/dashboard/cache.js");

const SESSION = { fbUserId: "1000000000001", email: "ops@example.com", name: "Ops User" };
const META_TOKEN = "EAAtest_never_leaves_the_server_0123456789";

/** Carries fields a naive mapper would leak, so the whitelist is actually under test. */
const RAW_ACCOUNTS = [
  {
    id: "act_111",
    account_id: "111",
    name: "Acme TR",
    account_status: 1,
    currency: "TRY",
    timezone_name: "Europe/Istanbul",
    business_name: "Acme Holding",
    amount_spent: "123456",
    balance: "0",
    funding_source_details: { id: "fs_1", display_string: "**** 4242" },
    access_token: META_TOKEN,
    owner: "999",
  },
  {
    id: "act_222",
    account_id: "222",
    name: "Beta US",
    account_status: 2,
    currency: "USD",
    timezone_name: "America/New_York",
    business_name: null,
    amount_spent: "0",
    balance: "0",
  },
];

let server: Server;
let baseUrl: string;

function request(
  path: string,
  options: { session?: boolean; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.session !== false) headers[SESSION_HEADER] = "valid";
  return fetch(`${baseUrl}${path}`, { headers, redirect: "manual" });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/dashboard", createDashboardApiRouter(new URL("http://localhost:3000")));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  dashboardCache.clear();
  getSessionMock.mockImplementation(async (marker: string | undefined) =>
    marker === "valid" ? SESSION : null,
  );
  getDecryptedTokenMock.mockResolvedValue(META_TOKEN);
  listTokensMock.mockResolvedValue([
    {
      name: "personal",
      kind: "user",
      expiresAt: 4102444800,
      metaUserId: "1000000000001",
      metaUserName: "Ops User",
      businessId: "b1",
      businessName: "Acme Holding",
      isDefault: true,
      isExpired: false,
    },
  ]);
  getDefaultTokenNameMock.mockResolvedValue("personal");
  metaGetPaginatedMock.mockResolvedValue(RAW_ACCOUNTS);
  metaGetMock.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("session gate", () => {
  it("returns JSON 401 for an API request with no session", async () => {
    const response = await request("/api/dashboard/accounts", { session: false });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: { code: "unauthenticated", message: expect.any(String) },
    });
  });

  it("never redirects an API request — a 302 inside fetch() is unusable to the SPA", async () => {
    const response = await request("/api/dashboard/accounts", { session: false });
    expect(response.status).not.toBe(302);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not resolve a Meta token for an unauthenticated caller", async () => {
    await request("/api/dashboard/accounts", { session: false });
    expect(getDecryptedTokenMock).not.toHaveBeenCalled();
    expect(metaGetPaginatedMock).not.toHaveBeenCalled();
  });

  it("marks every response private to the signed-in user", async () => {
    const response = await request("/api/dashboard/accounts");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
  });
});

describe("meta context middleware", () => {
  it("resolves the token through the shared store, scoped to the session user", async () => {
    await request("/api/dashboard/accounts");
    expect(getDecryptedTokenMock).toHaveBeenCalledWith(
      SESSION.fbUserId,
      undefined,
      expect.any(URL),
    );
  });

  it("returns meta_not_connected when no token can be resolved", async () => {
    getDecryptedTokenMock.mockRejectedValue(new Error("No Meta token registered for user"));
    const response = await request("/api/dashboard/accounts");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "meta_not_connected" },
    });
  });

  it("maps a revoked token mid-flight to meta_connection_expired", async () => {
    metaGetPaginatedMock.mockRejectedValue(
      new Error("Invalid or expired access token. Please provide a valid token. (Meta: ...)"),
    );
    const response = await request("/api/dashboard/accounts");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "meta_connection_expired" },
    });
  });

  it("serves /session without a Meta token so the reconnect state can render", async () => {
    getDecryptedTokenMock.mockRejectedValue(new Error("No Meta token registered for user"));
    const response = await request("/api/dashboard/session");
    expect(response.status).toBe(200);
  });
});

describe("DTO field whitelisting", () => {
  it("never emits the access token or any raw Meta field", async () => {
    const response = await request("/api/dashboard/accounts");
    const body = await response.text();

    expect(body).not.toContain(META_TOKEN);
    expect(body).not.toContain("access_token");
    expect(body).not.toContain("funding_source_details");
    expect(body).not.toContain("amount_spent");
    expect(body).not.toContain("4242");
    expect(body).not.toContain("owner");
  });

  it("maps accounts to exactly the documented keys", async () => {
    const response = await request("/api/dashboard/accounts");
    const body = (await response.json()) as { accounts: Array<Record<string, unknown>> };

    expect(Object.keys(body.accounts[0]).sort()).toEqual([
      "accountId",
      "businessName",
      "currency",
      "id",
      "name",
      "status",
      "statusCode",
      "timezone",
    ]);
  });

  it("preserves the account currency verbatim", async () => {
    const response = await request("/api/dashboard/accounts");
    const body = (await response.json()) as { accounts: Array<{ name: string; currency: string }> };
    const byName = Object.fromEntries(body.accounts.map((a) => [a.name, a.currency]));

    expect(byName["Acme TR"]).toBe("TRY");
    expect(byName["Beta US"]).toBe("USD");
  });

  it("translates the numeric account status into a stable enum", async () => {
    const response = await request("/api/dashboard/accounts");
    const body = (await response.json()) as { accounts: Array<{ name: string; status: string }> };
    const byName = Object.fromEntries(body.accounts.map((a) => [a.name, a.status]));

    expect(byName["Acme TR"]).toBe("ACTIVE");
    expect(byName["Beta US"]).toBe("DISABLED");
  });

  it("omits the raw token from the session payload", async () => {
    const response = await request("/api/dashboard/session");
    const body = await response.text();
    expect(body).not.toContain(META_TOKEN);
    expect(JSON.parse(body)).toEqual({
      user: { name: "Ops User", email: "ops@example.com", initials: "OU" },
      meta: {
        connected: true,
        tokenName: "personal",
        businessName: "Acme Holding",
        expiresAt: 4102444800,
        isExpired: false,
      },
    });
  });
});

describe("account authorization", () => {
  it("rejects an account id the connected user cannot reach", async () => {
    const response = await request("/api/dashboard/accounts/act_999999/insights");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "account_forbidden" },
    });
  });

  it("never calls Meta for an unauthorized account", async () => {
    await request("/api/dashboard/accounts/act_999999/campaigns");
    // The only Meta traffic is the accounts lookup that builds the allow list.
    expect(metaGetMock).not.toHaveBeenCalled();
    expect(metaGetPaginatedMock).toHaveBeenCalledTimes(1);
    expect(metaGetPaginatedMock).toHaveBeenCalledWith(
      "/me/adaccounts",
      expect.anything(),
      expect.any(Number),
    );
  });

  it("rejects a malformed account id before any lookup", async () => {
    for (const id of ["act_", "123", "act_abc", "..%2Fetc", "act_1;drop"]) {
      const response = await request(`/api/dashboard/accounts/${encodeURIComponent(id)}/insights`);
      expect(response.status, id).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
    }
  });

  it("allows an account that is in the accessible list", async () => {
    const response = await request("/api/dashboard/accounts/act_111/insights");
    expect(response.status).toBe(200);
  });

  it("re-checks authorization on every request, not once per session", async () => {
    await request("/api/dashboard/accounts/act_111/insights");
    dashboardCache.clear();
    metaGetPaginatedMock.mockResolvedValue([]);
    const response = await request("/api/dashboard/accounts/act_111/insights");
    expect(response.status).toBe(403);
  });
});

describe("insights endpoint", () => {
  beforeEach(() => {
    metaGetMock.mockImplementation(
      async (_path: string, params: Record<string, unknown>) =>
        params.time_increment
          ? {
              data: [
                {
                  date_start: "2026-09-02",
                  spend: "60",
                  impressions: "6000",
                  clicks: "60",
                  actions: [{ action_type: "omni_purchase", value: "2" }],
                },
                {
                  date_start: "2026-09-01",
                  spend: "40",
                  impressions: "4000",
                  clicks: "40",
                  actions: [{ action_type: "omni_purchase", value: "1" }],
                },
              ],
            }
          : {
              data: [
                {
                  spend: "100",
                  impressions: "10000",
                  reach: "7000",
                  clicks: "100",
                  actions: [
                    { action_type: "omni_purchase", value: "3" },
                    { action_type: "omni_add_to_cart", value: "12" },
                  ],
                  action_values: [{ action_type: "omni_purchase", value: "450" }],
                },
              ],
            },
    );
  });

  it("returns a derived summary plus a date-ordered series", async () => {
    const response = await request("/api/dashboard/accounts/act_111/insights?preset=last_7d");
    const body = (await response.json()) as {
      account: { currency: string };
      range: { preset: string };
      summary: Record<string, number | null>;
      series: Array<{ date: string }>;
    };

    expect(body.account.currency).toBe("TRY");
    expect(body.range.preset).toBe("last_7d");
    expect(body.summary.spend).toBe(100);
    // Reach comes from the unsegmented call, never from summing the series.
    expect(body.summary.reach).toBe(7000);
    expect(body.summary.ctr).toBeCloseTo(1, 10);
    expect(body.summary.purchases).toBe(3);
    expect(body.summary.addToCart).toBe(12);
    expect(body.summary.roas).toBeCloseTo(4.5, 10);
    expect(body.series.map((point) => point.date)).toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("asks Meta for unified attribution, matching the MCP tools", async () => {
    await request("/api/dashboard/accounts/act_111/insights");
    for (const call of metaGetMock.mock.calls) {
      expect((call[1] as Record<string, unknown>).use_unified_attribution_setting).toBe(true);
    }
  });

  it("passes a preset through as date_preset rather than resolving dates itself", async () => {
    await request("/api/dashboard/accounts/act_111/insights?preset=last_14d");
    const params = metaGetMock.mock.calls[0][1] as Record<string, unknown>;
    expect(params.date_preset).toBe("last_14d");
    expect(params.time_range).toBeUndefined();
  });

  it("sends a custom range as time_range", async () => {
    await request(
      "/api/dashboard/accounts/act_111/insights?preset=custom&since=2026-08-01&until=2026-08-31",
    );
    const params = metaGetMock.mock.calls[0][1] as Record<string, unknown>;
    expect(params.time_range).toBe(JSON.stringify({ since: "2026-08-01", until: "2026-08-31" }));
    expect(params.date_preset).toBeUndefined();
  });

  it("serves a repeat request from cache instead of calling Meta twice", async () => {
    await request("/api/dashboard/accounts/act_111/insights?preset=last_7d");
    const callsAfterFirst = metaGetMock.mock.calls.length;
    await request("/api/dashboard/accounts/act_111/insights?preset=last_7d");
    expect(metaGetMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does not serve one range's rows for another", async () => {
    await request("/api/dashboard/accounts/act_111/insights?preset=last_7d");
    const callsAfterFirst = metaGetMock.mock.calls.length;
    await request("/api/dashboard/accounts/act_111/insights?preset=last_30d");
    expect(metaGetMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

describe("request validation", () => {
  it("rejects an unknown preset", async () => {
    const response = await request("/api/dashboard/accounts/act_111/insights?preset=all_time");
    expect(response.status).toBe(400);
  });

  it("rejects a custom range with no dates", async () => {
    const response = await request("/api/dashboard/accounts/act_111/insights?preset=custom");
    expect(response.status).toBe(400);
  });

  it("rejects a reversed custom range", async () => {
    const response = await request(
      "/api/dashboard/accounts/act_111/insights?preset=custom&since=2026-09-10&until=2026-09-01",
    );
    expect(response.status).toBe(400);
  });

  it("rejects a malformed date", async () => {
    const response = await request(
      "/api/dashboard/accounts/act_111/insights?preset=custom&since=01-09-2026&until=2026-09-10",
    );
    expect(response.status).toBe(400);
  });

  it("rejects a range beyond Meta's retention window via the shared guardrails", async () => {
    const response = await request(
      "/api/dashboard/accounts/act_111/insights?preset=custom&since=2010-01-01&until=2026-09-01",
    );
    expect(response.status).toBe(400);
  });

  it("rejects an unknown campaign status filter", async () => {
    const response = await request("/api/dashboard/accounts/act_111/campaigns?status=RUNNING");
    expect(response.status).toBe(400);
  });

  it("404s an unknown dashboard endpoint as JSON", async () => {
    const response = await request("/api/dashboard/does-not-exist");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });
});
