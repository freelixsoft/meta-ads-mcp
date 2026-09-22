import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tenant isolation at the point where a request picks up the Meta token it is
 * about to spend.
 *
 * The property under test is narrow and absolute: in multi-tenant mode the
 * token a request gets is the token belonging to the identity that request
 * proved, and there is no path by which it gets any other one. Not another
 * user's, and not the server's own — an unidentified caller is refused rather
 * than quietly funded from a shared credential, which is the same rule
 * `resolveTenantId` applies to the Apify and Gemini keys.
 */

const getDecryptedTokenMock = vi.fn();

vi.mock("../../src/store/meta-token-repo.js", () => ({
  getDecryptedToken: (...args: unknown[]) => getDecryptedTokenMock(...args),
}));

const { buildMetaTokenMiddleware } = await import("../../src/transport/http.js");
const { requestContext } = await import("../../src/auth/token-store.js");
const { tokenManager } = await import("../../src/auth/token-manager.js");

const SERVER_URL = new URL("https://mcp.example.com");

/** The token each user has connected, as Firestore would hold it. */
const TOKENS: Record<string, string> = {
  "1000000000001": "EAA_user_A_token",
  "2000000000002": "EAA_user_B_token",
};

interface FakeResponse {
  statusCode: number | null;
  body: unknown;
  status(code: number): FakeResponse;
  json(payload: unknown): FakeResponse;
}

function response(): FakeResponse {
  const res: FakeResponse = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/**
 * Run one request through the middleware and report what the downstream
 * handler would actually see in the AsyncLocalStorage.
 */
async function runRequest(
  middleware: ReturnType<typeof buildMetaTokenMiddleware>,
  req: Record<string, unknown>,
): Promise<{ seen: { accessToken?: string; fbUserId?: string } | null; res: FakeResponse }> {
  const res = response();
  let seen: { accessToken?: string; fbUserId?: string } | null = null;

  await new Promise<void>((resolve) => {
    const next = () => {
      const store = requestContext.getStore();
      seen = store ? { accessToken: store.accessToken, fbUserId: store.fbUserId } : null;
      resolve();
    };
    const done = middleware({ headers: {}, ...req } as never, res as never, next as never);
    // The handler is async; when it answers instead of calling next, the
    // promise it returns is what settles.
    void Promise.resolve(done).then(() => {
      if (res.statusCode !== null) resolve();
    });
  });

  return { seen, res };
}

function withOAuthIdentity(fbUserId: string): Record<string, unknown> {
  return { auth: { extra: { fbUserId } } };
}

beforeEach(() => {
  getDecryptedTokenMock.mockImplementation((fbUserId: string) => {
    const token = TOKENS[fbUserId];
    return token
      ? Promise.resolve(token)
      : Promise.reject(new Error(`No Meta token registered for user ${fbUserId}`));
  });
  tokenManager.resetForTests();
  delete process.env.META_ACCESS_TOKEN;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.META_ACCESS_TOKEN;
});

describe("multi-tenant token resolution", () => {
  const middleware = () => buildMetaTokenMiddleware(SERVER_URL, true);

  it("gives each signed-in user their own token and never the other's", async () => {
    const a = await runRequest(middleware(), withOAuthIdentity("1000000000001"));
    const b = await runRequest(middleware(), withOAuthIdentity("2000000000002"));

    expect(a.seen?.accessToken).toBe("EAA_user_A_token");
    expect(a.seen?.fbUserId).toBe("1000000000001");
    expect(b.seen?.accessToken).toBe("EAA_user_B_token");
    expect(b.seen?.fbUserId).toBe("2000000000002");

    // The decryption is asked for by user id, so B's row is never a candidate
    // for A's request in the first place.
    expect(getDecryptedTokenMock).toHaveBeenNthCalledWith(1, "1000000000001", undefined, SERVER_URL);
    expect(getDecryptedTokenMock).toHaveBeenNthCalledWith(2, "2000000000002", undefined, SERVER_URL);
  });

  it("refuses a user who has connected nothing instead of lending them another token", async () => {
    const { seen, res } = await runRequest(middleware(), withOAuthIdentity("9999999999999"));

    expect(seen).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.body)).toContain("No Meta token connected");
  });

  it("refuses an unidentified caller rather than falling back to META_ACCESS_TOKEN", async () => {
    // The dangerous configuration: a multi-tenant deployment that also has a
    // server-wide token set. An API-key request carries no OAuth identity, so
    // without the guard it would run as whoever that token belongs to.
    process.env.META_ACCESS_TOKEN = "EAA_server_wide_token";

    const { seen, res } = await runRequest(middleware(), {});

    expect(seen).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.body)).toContain("multi-tenant");
    expect(JSON.stringify(res.body)).not.toContain("EAA_server_wide_token");
  });

  it("refuses an unidentified caller rather than falling back to the token registry", async () => {
    tokenManager.registerToken("shared", "EAA_registry_token");

    const { seen, res } = await runRequest(middleware(), {});

    expect(seen).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it("still honours a caller who brings its own token", async () => {
    const { seen, res } = await runRequest(middleware(), {
      headers: { "x-meta-token": "EAA_caller_supplied" },
    });

    expect(res.statusCode).toBeNull();
    expect(seen?.accessToken).toBe("EAA_caller_supplied");
    // No tenant identity is invented for it: per-tenant credentials and quotas
    // stay unreachable, which is what resolveTenantId enforces downstream.
    expect(seen?.fbUserId).toBeUndefined();
    expect(getDecryptedTokenMock).not.toHaveBeenCalled();
  });
});

describe("single-tenant token resolution", () => {
  const middleware = () => buildMetaTokenMiddleware(SERVER_URL, false);

  it("keeps the server-wide token working where there is only one operator", async () => {
    process.env.META_ACCESS_TOKEN = "EAA_single_operator";

    const { seen, res } = await runRequest(middleware(), {});

    expect(res.statusCode).toBeNull();
    expect(seen?.accessToken).toBe("EAA_single_operator");
    expect(seen?.fbUserId).toBeUndefined();
  });

  it("reports a missing token as a server configuration problem, not an auth one", async () => {
    const { seen, res } = await runRequest(middleware(), {});

    expect(seen).toBeNull();
    expect(res.statusCode).toBe(500);
  });
});

describe("the token never leaves the server", () => {
  it("keeps the plaintext in the async store and off the request object", async () => {
    const req: Record<string, unknown> = { ...withOAuthIdentity("1000000000001"), headers: {} };
    const { seen } = await runRequest(buildMetaTokenMiddleware(SERVER_URL, true), req);

    expect(seen?.accessToken).toBe("EAA_user_A_token");
    // Nothing the response layer can serialize carries it.
    expect(JSON.stringify(req)).not.toContain("EAA_user_A_token");
  });
});
