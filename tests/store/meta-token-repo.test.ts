import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "@google-cloud/firestore";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import {
  FirestoreMetaTokenRepo,
  InMemoryMetaTokenRepo,
  type MetaTokenDoc,
  type MetaTokenRepo,
} from "../../src/store/meta-token-repo.js";
import * as metaOAuth from "../../src/auth/meta-oauth.js";

// FirestoreMetaTokenRepo reaches the database only through getFirestore(),
// so swapping that single function is enough to drive the real production
// class against an in-memory double. Nothing here contacts Google.
const { firestoreHolder } = vi.hoisted(() => ({
  firestoreHolder: { db: null as unknown as Firestore },
}));

vi.mock("../../src/store/firestore.js", () => ({
  getFirestore: () => firestoreHolder.db,
  isFirestoreEnabled: () => true,
  resetFirestoreForTests: () => {},
}));

const ENCRYPTION_KEY = "a".repeat(64);
const APP_ID = "test-app";
const APP_SECRET = "test-secret";
const SERVER_URL = new URL("http://localhost:3000");

const profile = {
  id: "fb-1",
  name: "Alice",
  email: "alice@example.com",
  pictureUrl: null,
};

function makeInput(overrides: Partial<Parameters<MetaTokenRepo["saveToken"]>[0]> = {}) {
  return {
    fbUserId: "fb-1",
    name: "personal",
    accessToken: "EAA-secret-token",
    kind: "user" as const,
    expiresAt: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
    metaUserId: "fb-1",
    metaUserName: "Alice",
    ...overrides,
  };
}

describe("InMemoryMetaTokenRepo", () => {
  let repo: InMemoryMetaTokenRepo;
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  const originalAppId = process.env.META_APP_ID;
  const originalAppSecret = process.env.META_APP_SECRET;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
    process.env.META_APP_ID = APP_ID;
    process.env.META_APP_SECRET = APP_SECRET;
    resetKeyCacheForTests();
    repo = new InMemoryMetaTokenRepo();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = originalKey;
    if (originalAppId === undefined) delete process.env.META_APP_ID;
    else process.env.META_APP_ID = originalAppId;
    if (originalAppSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = originalAppSecret;
    resetKeyCacheForTests();
    vi.restoreAllMocks();
  });

  it("upserts users and reads them back", async () => {
    await repo.upsertUser("fb-1", profile);
    const user = await repo.getUser("fb-1");
    expect(user).toMatchObject({
      email: "alice@example.com",
      name: "Alice",
    });
  });

  it("first saved token becomes default automatically", async () => {
    await repo.saveToken(makeInput({ name: "first" }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("first");

    await repo.saveToken(makeInput({ name: "second" }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("first");
  });

  it("setAsDefault swaps the active default", async () => {
    await repo.saveToken(makeInput({ name: "a" }));
    await repo.saveToken(makeInput({ name: "b", setAsDefault: true }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("b");

    const tokens = await repo.listTokens("fb-1");
    expect(tokens.find((t) => t.name === "a")?.isDefault).toBe(false);
    expect(tokens.find((t) => t.name === "b")?.isDefault).toBe(true);
  });

  it("re-saving the token that holds the default keeps it default", async () => {
    await repo.saveToken(makeInput({ name: "personal" }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("personal");

    // A second Meta login: the callback sees a default already exists and so
    // passes setAsDefault=false, but the doc it overwrites IS that default.
    // Before the fix this wrote isDefault: false over the only default and
    // POST /authorize answered "No hay token de Meta conectado".
    await repo.saveToken(makeInput({ name: "personal", setAsDefault: false }));

    expect(await repo.getDefaultTokenName("fb-1")).toBe("personal");
    const tokens = await repo.listTokens("fb-1");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ name: "personal", isDefault: true });
  });

  it("re-saving a non-default token leaves another token's default alone", async () => {
    await repo.saveToken(
      makeInput({ name: "byads", kind: "system_user", expiresAt: null }),
    );
    await repo.saveToken(makeInput({ name: "personal" }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("byads");

    await repo.saveToken(makeInput({ name: "personal", setAsDefault: false }));

    expect(await repo.getDefaultTokenName("fb-1")).toBe("byads");
    const tokens = await repo.listTokens("fb-1");
    expect(tokens.find((t) => t.name === "byads")?.isDefault).toBe(true);
    expect(tokens.find((t) => t.name === "personal")?.isDefault).toBe(false);
  });

  it("selects a default on save when none exists and allows switching after", async () => {
    expect(await repo.getDefaultTokenName("fb-1")).toBeNull();

    await repo.saveToken(makeInput({ name: "personal" }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("personal");

    await repo.saveToken(
      makeInput({ name: "byads", kind: "system_user", expiresAt: null }),
    );
    expect(await repo.setDefaultToken("fb-1", "byads")).toBe(true);
    expect(await repo.getDefaultTokenName("fb-1")).toBe("byads");
  });

  it("setDefaultToken returns false when missing and switches when present", async () => {
    expect(await repo.setDefaultToken("fb-1", "missing")).toBe(false);
    await repo.saveToken(makeInput({ name: "a" }));
    await repo.saveToken(makeInput({ name: "b" }));
    expect(await repo.setDefaultToken("fb-1", "b")).toBe(true);
    expect(await repo.getDefaultTokenName("fb-1")).toBe("b");
  });

  it("deleteToken promotes another token when default is removed", async () => {
    await repo.saveToken(makeInput({ name: "a" }));
    await repo.saveToken(makeInput({ name: "b" }));
    expect(await repo.deleteToken("fb-1", "a")).toBe(true);
    expect(await repo.getDefaultTokenName("fb-1")).toBe("b");
  });

  it("getDecryptedToken returns the plaintext for system_user tokens without refresh", async () => {
    await repo.saveToken(
      makeInput({
        kind: "system_user",
        expiresAt: null,
        accessToken: "system-user-token",
        setAsDefault: true,
      }),
    );

    const plaintext = await repo.getDecryptedToken("fb-1");
    expect(plaintext).toBe("system-user-token");
  });

  it("returns plaintext when not within refresh window", async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    await repo.saveToken(
      makeInput({ accessToken: "still-valid", expiresAt: farFuture }),
    );

    const spy = vi.spyOn(metaOAuth, "exchangeForLongLivedToken");
    const plaintext = await repo.getDecryptedToken("fb-1", "personal", SERVER_URL);
    expect(plaintext).toBe("still-valid");
    expect(spy).not.toHaveBeenCalled();
  });

  it("refreshes long-lived tokens within the refresh window", async () => {
    const soon = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    await repo.saveToken(makeInput({ accessToken: "old-token", expiresAt: soon }));

    vi.spyOn(metaOAuth, "exchangeForLongLivedToken").mockResolvedValueOnce({
      accessToken: "new-token",
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
    });

    const plaintext = await repo.getDecryptedToken("fb-1", "personal", SERVER_URL);
    expect(plaintext).toBe("new-token");

    const second = await repo.getDecryptedToken("fb-1", "personal", SERVER_URL);
    expect(second).toBe("new-token");
  });

  it("returns existing plaintext when refresh fails but token is not yet expired", async () => {
    const soon = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    await repo.saveToken(makeInput({ accessToken: "still-good", expiresAt: soon }));

    vi.spyOn(metaOAuth, "exchangeForLongLivedToken").mockRejectedValueOnce(
      new Error("network error"),
    );

    const plaintext = await repo.getDecryptedToken("fb-1", "personal", SERVER_URL);
    expect(plaintext).toBe("still-good");
  });

  it("throws when refresh fails and the token is already expired", async () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    await repo.saveToken(makeInput({ accessToken: "rotten", expiresAt: expiredAt }));

    vi.spyOn(metaOAuth, "exchangeForLongLivedToken").mockRejectedValueOnce(
      new Error("OAuthException: token expired"),
    );

    await expect(
      repo.getDecryptedToken("fb-1", "personal", SERVER_URL),
    ).rejects.toThrow(/expired and refresh failed/);
  });

  it("throws when no token is registered", async () => {
    await expect(repo.getDecryptedToken("fb-2")).rejects.toThrow(/No Meta token registered/);
  });

  it("throws when the named token does not exist", async () => {
    await repo.saveToken(makeInput({ name: "a" }));
    await expect(repo.getDecryptedToken("fb-1", "missing")).rejects.toThrow(
      /not found for user/,
    );
  });

  it("persists businessId and businessName and exposes them in summaries", async () => {
    await repo.saveToken(
      makeInput({
        name: "client_acme",
        kind: "system_user",
        expiresAt: null,
        businessId: "1234567890",
        businessName: "Acme Corp",
      }),
    );

    const tokens = await repo.listTokens("fb-1");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      name: "client_acme",
      businessId: "1234567890",
      businessName: "Acme Corp",
    });
  });

  it("defaults businessId and businessName to null when not provided", async () => {
    await repo.saveToken(makeInput({ name: "no-bm" }));

    const tokens = await repo.listTokens("fb-1");
    expect(tokens[0].businessId).toBeNull();
    expect(tokens[0].businessName).toBeNull();
  });

  it("getDecryptedToken without a name resolves the current default after setDefaultToken (enables agent token pivoting)", async () => {
    await repo.saveToken(
      makeInput({
        name: "byads",
        kind: "system_user",
        expiresAt: null,
        accessToken: "byads-token",
        setAsDefault: true,
      }),
    );
    await repo.saveToken(
      makeInput({
        name: "personal",
        kind: "system_user",
        expiresAt: null,
        accessToken: "personal-token",
      }),
    );

    expect(await repo.getDecryptedToken("fb-1")).toBe("byads-token");

    expect(await repo.setDefaultToken("fb-1", "personal")).toBe(true);
    expect(await repo.getDecryptedToken("fb-1")).toBe("personal-token");

    expect(await repo.setDefaultToken("fb-1", "byads")).toBe(true);
    expect(await repo.getDecryptedToken("fb-1")).toBe("byads-token");
  });
});

type DocData = Record<string, unknown>;

/**
 * Minimal stand-in for the slice of the Firestore API FirestoreMetaTokenRepo
 * actually calls. Documents live in one flat map keyed by full path, which
 * covers the nesting the repo does, and the two write semantics the
 * default-flag logic depends on are modelled the way Firestore behaves:
 * set() without merge replaces the whole document, update() merges into it.
 * Getting that pair wrong would make these tests pass vacuously, so
 * "reproduces the production bug once the fix is reverted" is part of the
 * contract this double has to satisfy.
 */
class FakeFirestore {
  readonly docs = new Map<string, DocData>();

  collection(path: string): FakeCollection {
    return new FakeCollection(this, path);
  }

  batch() {
    const ops: Array<() => void> = [];
    return {
      update: (ref: FakeDoc, data: DocData) => {
        ops.push(() => ref.applyMerge(data));
      },
      commit: async () => {
        for (const op of ops) op();
      },
    };
  }
}

class FakeCollection {
  constructor(
    private readonly db: FakeFirestore,
    private readonly path: string,
    private readonly filters: Array<[string, unknown]> = [],
    private readonly max: number | null = null,
  ) {}

  doc(id: string): FakeDoc {
    return new FakeDoc(this.db, `${this.path}/${id}`);
  }

  where(field: string, op: string, value: unknown): FakeCollection {
    if (op !== "==") throw new Error(`fake supports only "==", got ${op}`);
    return new FakeCollection(
      this.db,
      this.path,
      [...this.filters, [field, value]],
      this.max,
    );
  }

  limit(n: number): FakeCollection {
    return new FakeCollection(this.db, this.path, this.filters, n);
  }

  async get() {
    const prefix = `${this.path}/`;
    let entries = [...this.db.docs.entries()].filter(
      ([key]) =>
        key.startsWith(prefix) && !key.slice(prefix.length).includes("/"),
    );
    for (const [field, value] of this.filters) {
      entries = entries.filter(([, data]) => data[field] === value);
    }
    if (this.max !== null) entries = entries.slice(0, this.max);
    const docs = entries.map(([key, data]) => ({
      id: key.slice(prefix.length),
      ref: new FakeDoc(this.db, key),
      data: () => structuredClone(data),
    }));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class FakeDoc {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}

  get id(): string {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }

  collection(sub: string): FakeCollection {
    return new FakeCollection(this.db, `${this.path}/${sub}`);
  }

  async get() {
    const data = this.db.docs.get(this.path);
    return {
      exists: data !== undefined,
      id: this.id,
      data: () => (data === undefined ? undefined : structuredClone(data)),
    };
  }

  async set(data: DocData, options?: { merge?: boolean }) {
    if (options?.merge) this.applyMerge(data);
    else this.db.docs.set(this.path, structuredClone(data));
  }

  async update(data: DocData) {
    if (!this.db.docs.has(this.path)) {
      throw new Error(`NOT_FOUND: no document to update at ${this.path}`);
    }
    this.applyMerge(data);
  }

  async delete() {
    this.db.docs.delete(this.path);
  }

  applyMerge(data: DocData) {
    const current = this.db.docs.get(this.path) ?? {};
    this.db.docs.set(this.path, { ...current, ...structuredClone(data) });
  }
}

describe("FirestoreMetaTokenRepo against a Firestore double", () => {
  let db: FakeFirestore;
  let repo: FirestoreMetaTokenRepo;
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;

  const stored = (name: string): MetaTokenDoc =>
    db.docs.get(`users/fb-1/meta_tokens/${name}`) as unknown as MetaTokenDoc;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
    resetKeyCacheForTests();
    db = new FakeFirestore();
    firestoreHolder.db = db as unknown as Firestore;
    repo = new FirestoreMetaTokenRepo();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = originalKey;
    resetKeyCacheForTests();
  });

  it("the double replaces documents on set(), the way Firestore does", async () => {
    const ref = db.collection("users").doc("fb-1");
    await ref.set({ a: 1, b: 2 });
    await ref.set({ a: 9 });
    expect((await ref.get()).data()).toEqual({ a: 9 });

    await ref.update({ b: 3 });
    expect((await ref.get()).data()).toEqual({ a: 9, b: 3 });
  });

  it("selects the first saved token as the default", async () => {
    expect(await repo.getDefaultTokenName("fb-1")).toBeNull();

    await repo.saveToken(makeInput({ name: "personal" }));

    expect(await repo.getDefaultTokenName("fb-1")).toBe("personal");
    expect(stored("personal").isDefault).toBe(true);
  });

  it("re-saving the token that holds the default keeps it default", async () => {
    await repo.saveToken(makeInput({ name: "personal" }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("personal");

    // The second Meta login, driven the way auth-routes.ts drives it.
    await repo.saveToken(
      makeInput({
        name: "personal",
        setAsDefault: !(await repo.getDefaultTokenName("fb-1")),
      }),
    );

    expect(await repo.getDefaultTokenName("fb-1")).toBe("personal");
    expect(stored("personal").isDefault).toBe(true);
    const tokens = await repo.listTokens("fb-1");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ name: "personal", isDefault: true });
  });

  it("leaves another token's default alone when a second token is saved", async () => {
    await repo.saveToken(
      makeInput({ name: "byads", kind: "system_user", expiresAt: null }),
    );
    expect(await repo.getDefaultTokenName("fb-1")).toBe("byads");

    await repo.saveToken(
      makeInput({
        name: "personal",
        setAsDefault: !(await repo.getDefaultTokenName("fb-1")),
      }),
    );

    expect(await repo.getDefaultTokenName("fb-1")).toBe("byads");
    expect(stored("byads").isDefault).toBe(true);
    expect(stored("personal").isDefault).toBe(false);
  });

  it("still swaps the default when setAsDefault is explicit", async () => {
    await repo.saveToken(makeInput({ name: "personal" }));
    await repo.saveToken(
      makeInput({
        name: "byads",
        kind: "system_user",
        expiresAt: null,
        setAsDefault: true,
      }),
    );

    expect(await repo.getDefaultTokenName("fb-1")).toBe("byads");
    expect(stored("personal").isDefault).toBe(false);
    expect(stored("byads").isDefault).toBe(true);
  });

  it("stores the token encrypted and round-trips it", async () => {
    await repo.saveToken(
      makeInput({ name: "personal", accessToken: "plaintext-fixture" }),
    );

    expect(JSON.stringify(stored("personal"))).not.toContain(
      "plaintext-fixture",
    );
    expect(await repo.getDecryptedToken("fb-1")).toBe("plaintext-fixture");
  });
});
