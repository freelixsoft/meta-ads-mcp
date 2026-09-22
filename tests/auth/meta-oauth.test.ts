import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  fetchPrimaryBusiness,
  loadMetaOAuthConfig,
} from "../../src/auth/meta-oauth.js";
import { mockFetchResponse } from "../setup.js";

describe("Meta OAuth Graph API version", () => {
  const serverUrl = new URL("https://mcp.example.com");

  beforeEach(() => {
    vi.stubEnv("META_APP_ID", "1234567890");
    vi.stubEnv("META_APP_SECRET", "dummy-secret");
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("runs the login dialog and Graph calls on v26.0 by default", async () => {
    vi.stubEnv("META_API_VERSION", undefined);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockFetchResponse({ data: [] }));

    const config = loadMetaOAuthConfig(serverUrl);
    const dialogUrl = new URL(buildAuthorizeUrl(config!, "state-1"));
    await fetchPrimaryBusiness("token-x");

    expect(dialogUrl.pathname).toBe("/v26.0/dialog/oauth");
    const graphUrl = new URL(vi.mocked(globalThis.fetch).mock.calls[0][0] as string);
    expect(graphUrl.pathname).toBe("/v26.0/me/businesses");
  });

  it("follows META_API_VERSION for the login dialog and Graph calls", async () => {
    vi.stubEnv("META_API_VERSION", "v25.0");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockFetchResponse({ data: [] }));

    const config = loadMetaOAuthConfig(serverUrl);
    const dialogUrl = new URL(buildAuthorizeUrl(config!, "state-1"));
    await fetchPrimaryBusiness("token-x");

    expect(dialogUrl.pathname).toBe("/v25.0/dialog/oauth");
    const graphUrl = new URL(vi.mocked(globalThis.fetch).mock.calls[0][0] as string);
    expect(graphUrl.pathname).toBe("/v25.0/me/businesses");
  });
});

describe("the authorize URL sent to Meta", () => {
  const serverUrl = new URL("https://mcp.example.com");

  beforeEach(() => {
    vi.stubEnv("META_APP_ID", "1234567890");
    vi.stubEnv("META_APP_SECRET", "dummy-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("asks for the two ads scopes and nothing else", () => {
    const config = loadMetaOAuthConfig(serverUrl);
    const url = new URL(buildAuthorizeUrl(config as NonNullable<typeof config>, "state123"));
    const scopes = (url.searchParams.get("scope") ?? "").split(",");

    expect(scopes).toContain("ads_management");
    expect(scopes).toContain("ads_read");
    expect(scopes).toHaveLength(2);
  });

  it("never asks for email, which this Meta app rejects as an invalid scope", () => {
    const config = loadMetaOAuthConfig(serverUrl);
    const url = buildAuthorizeUrl(config as NonNullable<typeof config>, "state123");

    // Checked against the whole URL, not just the parsed list: a scope smuggled
    // in by any other route would break the login dialog the same way.
    expect(url).not.toContain("email");
    expect(new URL(url).searchParams.get("scope")).toBe("ads_management,ads_read");
  });

  it("does not name public_profile, which Facebook Login grants implicitly", () => {
    const config = loadMetaOAuthConfig(serverUrl);
    const url = buildAuthorizeUrl(config as NonNullable<typeof config>, "state123");
    expect(url).not.toContain("public_profile");
  });

  it("builds the callback from SERVER_URL and never from a localhost default", () => {
    const config = loadMetaOAuthConfig(serverUrl);
    expect(config?.redirectUri).toBe("https://mcp.example.com/auth/meta/callback");

    const url = new URL(buildAuthorizeUrl(config as NonNullable<typeof config>, "state123"));
    expect(url.searchParams.get("redirect_uri")).toBe("https://mcp.example.com/auth/meta/callback");
    expect(url.searchParams.get("state")).toBe("state123");
    // The app secret has no business in a URL the browser is redirected to.
    expect(url.search).not.toContain("dummy-secret");
    expect(url.searchParams.get("client_secret")).toBeNull();
  });

  it("lets META_OAUTH_REDIRECT_URI override the derived callback", () => {
    vi.stubEnv("META_OAUTH_REDIRECT_URI", "https://ads.example.com/auth/meta/callback");
    expect(loadMetaOAuthConfig(serverUrl)?.redirectUri).toBe(
      "https://ads.example.com/auth/meta/callback",
    );
  });
});

describe("fetchPrimaryBusiness", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns id and name for the first business", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({
        data: [{ id: "1234567890", name: "Acme Corp" }],
      }),
    );

    const result = await fetchPrimaryBusiness("token-x", "v22.0");
    expect(result).toEqual({ id: "1234567890", name: "Acme Corp" });

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain("/v22.0/me/businesses");
    expect(url).toContain("fields=id%2Cname");
    expect(url).toContain("limit=1");
    expect(url).toContain("access_token=token-x");
  });

  it("returns null when the businesses list is empty", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({ data: [] }),
    );

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toBeNull();
  });

  it("returns null when the API responds with an error (missing permission)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse(
        {
          error: {
            message:
              "(#200) Permissions error: business_management is required",
          },
        },
        { status: 400 },
      ),
    );

    const result = await fetchPrimaryBusiness("token-no-perm");
    expect(result).toBeNull();
  });

  it("returns null when the network call throws", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network down"));

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toBeNull();
  });

  it("preserves the id and tolerates a missing name", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({ data: [{ id: "9999" }] }),
    );

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toEqual({ id: "9999", name: null });
  });
});
