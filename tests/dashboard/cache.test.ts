import { describe, expect, it, vi } from "vitest";
import { cacheKey, createTtlCache } from "../../src/dashboard/cache.js";

describe("createTtlCache", () => {
  it("serves a second read from cache inside the TTL", async () => {
    const cache = createTtlCache();
    const loader = vi.fn().mockResolvedValue("value");

    await cache.getOrLoad("k", 1000, loader);
    await cache.getOrLoad("k", 1000, loader);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("reloads after the TTL expires", async () => {
    let now = 0;
    const cache = createTtlCache({ now: () => now });
    const loader = vi.fn().mockResolvedValue("value");

    await cache.getOrLoad("k", 1000, loader);
    now = 1001;
    await cache.getOrLoad("k", 1000, loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent loads of the same key", async () => {
    const cache = createTtlCache();
    const loader = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("value"), 10)),
    );

    const results = await Promise.all([
      cache.getOrLoad("k", 1000, loader),
      cache.getOrLoad("k", 1000, loader),
      cache.getOrLoad("k", 1000, loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(results).toEqual(["value", "value", "value"]);
  });

  it("never caches a failure", async () => {
    const cache = createTtlCache();
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce("value");

    await expect(cache.getOrLoad("k", 1000, loader)).rejects.toThrow("upstream down");
    await expect(cache.getOrLoad("k", 1000, loader)).resolves.toBe("value");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct keys independent", async () => {
    const cache = createTtlCache();
    const loader = vi.fn().mockImplementation(async () => "value");

    await cache.getOrLoad("a", 1000, loader);
    await cache.getOrLoad("b", 1000, loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entries past the ceiling", async () => {
    const cache = createTtlCache({ maxEntries: 2 });
    const loader = vi.fn().mockResolvedValue("value");

    await cache.getOrLoad("a", 1000, loader);
    await cache.getOrLoad("b", 1000, loader);
    await cache.getOrLoad("c", 1000, loader);

    expect(cache.stats().entries).toBe(2);
    await cache.getOrLoad("a", 1000, loader);
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it("invalidates by prefix", async () => {
    const cache = createTtlCache();
    const loader = vi.fn().mockResolvedValue("value");

    await cache.getOrLoad("user1|insights", 1000, loader);
    await cache.getOrLoad("user2|insights", 1000, loader);
    cache.invalidatePrefix("user1|");

    await cache.getOrLoad("user1|insights", 1000, loader);
    await cache.getOrLoad("user2|insights", 1000, loader);

    expect(loader).toHaveBeenCalledTimes(3);
  });
});

describe("cacheKey", () => {
  it("partitions by tenant so one user's rows can never reach another", () => {
    const a = cacheKey({ fbUserId: "1", tokenHash: "h", endpoint: "accounts" });
    const b = cacheKey({ fbUserId: "2", tokenHash: "h", endpoint: "accounts" });
    expect(a).not.toBe(b);
  });

  it("partitions by token identity, so switching the active token misses", () => {
    const a = cacheKey({ fbUserId: "1", tokenHash: "aaa", endpoint: "accounts" });
    const b = cacheKey({ fbUserId: "1", tokenHash: "bbb", endpoint: "accounts" });
    expect(a).not.toBe(b);
  });

  it("is stable regardless of parameter insertion order", () => {
    const a = cacheKey({
      fbUserId: "1",
      tokenHash: "h",
      endpoint: "insights",
      params: { account: "act_1", preset: "last_7d" },
    });
    const b = cacheKey({
      fbUserId: "1",
      tokenHash: "h",
      endpoint: "insights",
      params: { preset: "last_7d", account: "act_1" },
    });
    expect(a).toBe(b);
  });

  it("separates different parameter values", () => {
    const a = cacheKey({
      fbUserId: "1",
      tokenHash: "h",
      endpoint: "insights",
      params: { preset: "last_7d" },
    });
    const b = cacheKey({
      fbUserId: "1",
      tokenHash: "h",
      endpoint: "insights",
      params: { preset: "last_30d" },
    });
    expect(a).not.toBe(b);
  });
});
