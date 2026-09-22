import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The confirmation gate: the only path in the dashboard by which a request
 * reaches Meta with a method other than GET.
 *
 * The properties under test are the ones that make an approval mean something:
 * the parameters never leave the server, an approval is single-use, it is bound
 * to the session and account that staged it, and it expires.
 */

const metaGetMock = vi.fn();
const metaPostFormMock = vi.fn();

vi.mock("../../src/meta/client.js", () => ({
  metaApiClient: {
    get: (...args: unknown[]) => metaGetMock(...args),
    getPaginated: vi.fn(),
    postForm: (...args: unknown[]) => metaPostFormMock(...args),
  },
}));

const { stageWrite, takeWrite, discardWrite, clearPendingWrites, pendingWriteCount } = await import(
  "../../src/claude/confirmations.js"
);
const { applyDashboardConfirmation } = await import("../../src/dashboard/ai/service.js");
const { DashboardError } = await import("../../src/dashboard/errors.js");
const { cacheKey, dashboardCache } = await import("../../src/dashboard/cache.js");
const { configureAuditLog, getAuditLog, InMemoryAuditLog } = await import("../../src/store/audit-log.js");

import type { WritePlan } from "../../src/claude/tools.js";
import type { AdAccountDto } from "../../src/dashboard/dto.js";

const ACCOUNT: AdAccountDto = {
  id: "act_111",
  accountId: "111",
  name: "Acme TR",
  status: "ACTIVE",
  statusCode: 1,
  currency: "TRY",
  timezone: "Europe/Istanbul",
  businessName: "Acme Holding",
};

const CTX = { fbUserId: "1000000000001", tokenHash: "fixturehash1" };
const OWNER = { fbUserId: CTX.fbUserId, accountId: ACCOUNT.id };

function samplePlan(overrides: Partial<WritePlan> = {}): WritePlan {
  return {
    tool: "meta_update_campaign",
    title: "Kampanya güncellenecek",
    description: "Onaylarsanız bu değişiklik Meta'ya gönderilir.",
    reason: "Bütçe son 7 günde tükendi.",
    risk: null,
    confidence: null,
    fields: [
      { label: "Kampanya", value: "Kış Kampanyası" },
      { label: "Yeni günlük bütçe", value: "2.000,00 TRY" },
    ],
    path: "/100",
    body: { daily_budget: "200000" },
    expected: { daily_budget: 2000 },
    verify: { kind: "existing", id: "100", level: "campaign" },
    ...overrides,
  };
}

function stage(plan = samplePlan(), owner = OWNER, now?: number) {
  return stageWrite(
    { plan, fbUserId: owner.fbUserId, accountId: owner.accountId, accountName: ACCOUNT.name },
    now,
  );
}

beforeEach(() => {
  clearPendingWrites();
  dashboardCache.clear();
  configureAuditLog(new InMemoryAuditLog());
  delete process.env.DASHBOARD_AI_WRITES;
  metaPostFormMock.mockResolvedValue({ success: true });
  metaGetMock.mockResolvedValue({
    id: "100",
    name: "Kış Kampanyası",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    daily_budget: "200000",
  });
});

afterEach(() => {
  delete process.env.DASHBOARD_AI_WRITES;
  vi.clearAllMocks();
});

describe("the staged write store", () => {
  it("returns a description to the browser and keeps the parameters on the server", () => {
    const confirmation = stage();

    expect(confirmation.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(confirmation.fields).toEqual(samplePlan().fields);
    // The four things the user needs before approving: what changes, from what
    // to what, why, and how long the approval stays good for.
    expect(confirmation.reason).toBe("Bütçe son 7 günde tükendi.");
    // risk and confidence are optional: a proposal that did not come from a
    // finding carries null rather than an invented level, and the card simply
    // omits those rows.
    expect(confirmation.risk).toBeNull();
    expect(confirmation.confidence).toBeNull();
    expect(confirmation.fields[1].value).toContain("2.000,00 TRY");
    expect(confirmation.expiresAt).toBeGreaterThan(Date.now());
    // Nothing the browser receives says what would actually be sent to Meta.
    const serialized = JSON.stringify(confirmation);
    expect(serialized).not.toContain("daily_budget");
    expect(serialized).not.toContain("200000");
    expect(serialized).not.toContain("/100");
  });

  it("hands the plan back exactly once", () => {
    const confirmation = stage();

    const first = takeWrite(confirmation.id, OWNER);
    expect(first).toMatchObject({ ok: true, title: "Kampanya güncellenecek" });
    expect(first.ok && first.plan.body).toEqual({ daily_budget: "200000" });

    // A replayed approval finds nothing.
    expect(takeWrite(confirmation.id, OWNER)).toEqual({ ok: false, reason: "not_found" });
    expect(pendingWriteCount()).toBe(0);
  });

  it("is inert in another user's session and against another ad account", () => {
    const confirmation = stage();

    expect(takeWrite(confirmation.id, { fbUserId: "9999", accountId: ACCOUNT.id })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(takeWrite(confirmation.id, { fbUserId: CTX.fbUserId, accountId: "act_222" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    // Rejecting someone else's id must not consume it either.
    expect(takeWrite(confirmation.id, OWNER).ok).toBe(true);
  });

  it("expires rather than executing an approval clicked the next morning", () => {
    const now = 1_000_000;
    const confirmation = stage(samplePlan(), OWNER, now);
    expect(confirmation.expiresAt).toBe(now + 10 * 60_000);

    expect(takeWrite(confirmation.id, OWNER, now + 9 * 60_000).ok).toBe(true);

    const second = stage(samplePlan(), OWNER, now);
    expect(takeWrite(second.id, OWNER, now + 11 * 60_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("discards a plan outright, and refuses to discard someone else's", () => {
    const confirmation = stage();
    expect(discardWrite(confirmation.id, { fbUserId: "9999", accountId: ACCOUNT.id })).toBeNull();
    expect(discardWrite(confirmation.id, OWNER)?.plan.tool).toBe("meta_update_campaign");
    expect(pendingWriteCount()).toBe(0);
  });
});

describe("applyDashboardConfirmation", () => {
  it("sends the stored plan and reports what Meta stored afterwards", async () => {
    const confirmation = stage();

    const result = await applyDashboardConfirmation(CTX, ACCOUNT, confirmation.id);

    expect(metaPostFormMock).toHaveBeenCalledWith("/100", { daily_budget: "200000" });
    expect(result).toMatchObject({
      applied: true,
      title: "Kampanya güncellenecek",
      answer: "Kampanya güncellendi.",
      verificationFailed: false,
    });
    expect(result.verified.dailyBudget).toBe(2000);
  });

  it("still requires an approval for a write the optimization pass recommended", async () => {
    // A finding carries a writeTool, never a staged write: the analysis itself
    // puts nothing in the pending store and sends nothing to Meta.
    expect(pendingWriteCount()).toBe(0);
    expect(metaPostFormMock).not.toHaveBeenCalled();

    // Only staging, then an explicit approval, reaches Meta.
    const confirmation = stage();
    expect(metaPostFormMock).not.toHaveBeenCalled();

    const result = await applyDashboardConfirmation(CTX, ACCOUNT, confirmation.id);
    expect(metaPostFormMock).toHaveBeenCalledTimes(1);

    // And the answer reports what Meta stored, read back after the write.
    expect(metaGetMock).toHaveBeenCalled();
    expect(result.verified.dailyBudget).toBe(2000);
    expect(result.verificationFailed).toBe(false);
  });

  it("drops the tenant's cached reads so the next one cannot serve the pre-write value", async () => {
    const staleKey = cacheKey({
      fbUserId: CTX.fbUserId,
      tokenHash: CTX.tokenHash,
      endpoint: "campaigns",
      params: { account: ACCOUNT.id },
    });
    const otherTenantKey = cacheKey({
      fbUserId: "2000000000002",
      tokenHash: "otherhash1234",
      endpoint: "campaigns",
      params: { account: ACCOUNT.id },
    });
    const load = vi.fn().mockResolvedValue(1200);
    await dashboardCache.getOrLoad(staleKey, 60_000, load);
    await dashboardCache.getOrLoad(otherTenantKey, 60_000, () => Promise.resolve(1200));
    expect(load).toHaveBeenCalledTimes(1);

    await applyDashboardConfirmation(CTX, ACCOUNT, stage().id);

    // The write moved the budget, so the entry that held the old one is gone
    // and the next read goes back to Meta.
    await expect(dashboardCache.getOrLoad(staleKey, 60_000, () => Promise.resolve(1250))).resolves.toBe(1250);
    // Another tenant's rows were not touched by this write.
    await expect(
      dashboardCache.getOrLoad(otherTenantKey, 60_000, () => Promise.resolve(9999)),
    ).resolves.toBe(1200);
  });

  it("leaves the cache alone when Meta refused the write", async () => {
    const key = cacheKey({
      fbUserId: CTX.fbUserId,
      tokenHash: CTX.tokenHash,
      endpoint: "campaigns",
      params: { account: ACCOUNT.id },
    });
    await dashboardCache.getOrLoad(key, 60_000, () => Promise.resolve(1200));
    metaPostFormMock.mockRejectedValueOnce(new Error("Meta rejected the write"));

    await expect(applyDashboardConfirmation(CTX, ACCOUNT, stage().id)).rejects.toThrow();

    // Nothing changed at Meta, so throwing the cached rows away would only
    // cost a re-read.
    await expect(dashboardCache.getOrLoad(key, 60_000, () => Promise.resolve(9999))).resolves.toBe(1200);
  });

  it("says so when the write landed but the read-back did not", async () => {
    // The pre-write drift check reads first and must succeed; it is the
    // read-BACK, after the write, that fails in this case.
    metaGetMock
      .mockResolvedValueOnce({ id: "100", daily_budget: "200000" })
      .mockRejectedValue(new Error("Meta read failed"));
    const confirmation = stage();

    const result = await applyDashboardConfirmation(CTX, ACCOUNT, confirmation.id);

    expect(result.applied).toBe(true);
    expect(result.verificationFailed).toBe(true);
    expect(result.answer).toContain("doğrulayamadım");
  });

  it("refuses an unknown, replayed or foreign confirmation with one code", async () => {
    await expect(
      applyDashboardConfirmation(CTX, ACCOUNT, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ code: "ai_confirmation_expired", status: 409 });
    expect(metaPostFormMock).not.toHaveBeenCalled();

    const confirmation = stage();
    await applyDashboardConfirmation(CTX, ACCOUNT, confirmation.id);
    metaPostFormMock.mockClear();

    await expect(applyDashboardConfirmation(CTX, ACCOUNT, confirmation.id)).rejects.toMatchObject({
      code: "ai_confirmation_expired",
    });
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("cannot be used to apply a plan staged in another session", async () => {
    const confirmation = stage(samplePlan(), { fbUserId: "7777", accountId: ACCOUNT.id });

    await expect(applyDashboardConfirmation(CTX, ACCOUNT, confirmation.id)).rejects.toBeInstanceOf(
      DashboardError,
    );
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  // ─── F: the object moved between the proposal and the approval ──────────
  it("refuses to write over a change someone else made in the meantime", async () => {
    // Meta now holds 3.000 TRY, not the 2.000 the plan was built against.
    metaGetMock.mockResolvedValue({
      id: "100",
      name: "Kış Kampanyası",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      daily_budget: "300000",
    });

    await expect(applyDashboardConfirmation(CTX, ACCOUNT, stage().id)).rejects.toMatchObject({
      code: "ai_write_stale",
      status: 409,
    });
    // The point of checking first: nothing was sent.
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("records the refusal, with the value it expected and the one it found", async () => {
    metaGetMock.mockResolvedValue({ id: "100", daily_budget: "300000" });
    await applyDashboardConfirmation(CTX, ACCOUNT, stage().id).catch(() => undefined);

    const entries = await getAuditLog().list(CTX.fbUserId);
    expect(entries[0]).toMatchObject({
      outcome: "refused_stale",
      tool: "meta_update_campaign",
      objectId: "100",
      before: { daily_budget: 2000 },
      after: { daily_budget: "200000" },
    });
  });

  it("still applies when an unrelated field moved", async () => {
    // The name changed; the plan only writes the budget, so it is not blocked.
    metaGetMock.mockResolvedValue({
      id: "100",
      name: "Kış Kampanyası (yeni ad)",
      status: "ACTIVE",
      daily_budget: "200000",
    });

    const result = await applyDashboardConfirmation(CTX, ACCOUNT, stage().id);
    expect(result.applied).toBe(true);
    expect(metaPostFormMock).toHaveBeenCalledTimes(1);
  });

  // ─── Audit trail ────────────────────────────────────────────────────────
  it("records an applied write with the before, the after and the AI's reason", async () => {
    await applyDashboardConfirmation(CTX, ACCOUNT, stage().id);

    const entries = await getAuditLog().list(CTX.fbUserId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: "applied",
      accountId: ACCOUNT.id,
      accountName: ACCOUNT.name,
      tool: "meta_update_campaign",
      level: "campaign",
      objectId: "100",
      before: { daily_budget: 2000 },
      after: { daily_budget: "200000" },
      reason: "Bütçe son 7 günde tükendi.",
      errorCode: null,
    });
    expect(entries[0].verified).toMatchObject({ dailyBudget: 2000 });
    // The tenant is identified by the path, so the payload keeps only a hash.
    expect(entries[0].userHash).not.toBe(CTX.fbUserId);
    expect(entries[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records a Meta failure as failed, not as applied", async () => {
    metaPostFormMock.mockRejectedValueOnce(new Error("Meta rejected the write"));
    await applyDashboardConfirmation(CTX, ACCOUNT, stage().id).catch(() => undefined);

    const entries = await getAuditLog().list(CTX.fbUserId);
    expect(entries[0]?.outcome).toBe("failed");
    expect(entries[0]?.verified).toBeNull();
  });

  it("refuses every write when the operator switched writes off", async () => {
    process.env.DASHBOARD_AI_WRITES = "off";
    const confirmation = stage();

    await expect(applyDashboardConfirmation(CTX, ACCOUNT, confirmation.id)).rejects.toMatchObject({
      status: 403,
    });
    expect(metaPostFormMock).not.toHaveBeenCalled();
    // Not even the pre-write read: the switch is checked before anything else.
    expect(metaGetMock).not.toHaveBeenCalled();
  });

  it("tells the user why, in Turkish, when writes are switched off", async () => {
    process.env.DASHBOARD_AI_WRITES = "off";

    const error = await applyDashboardConfirmation(CTX, ACCOUNT, stage().id).catch(
      (caught: unknown) => caught as InstanceType<typeof DashboardError>,
    );
    expect(error.message).toContain("Reklam değiştirme yetkisi");
    expect(error.message).toContain("hiçbir istek gönderilmedi");
  });

  it("records the refusal and leaves the confirmation unusable", async () => {
    process.env.DASHBOARD_AI_WRITES = "off";
    const confirmation = stage();

    await applyDashboardConfirmation(CTX, ACCOUNT, confirmation.id).catch(() => undefined);

    const entries = await getAuditLog().list(CTX.fbUserId);
    expect(entries[0]).toMatchObject({
      outcome: "refused_writes_disabled",
      errorCode: "writes_disabled",
      tool: "meta_update_campaign",
    });
    expect(pendingWriteCount()).toBe(0);
  });

  // ─── G: an approval aimed at the wrong ad account ───────────────────────
  it("refuses an approval presented against a different ad account", async () => {
    const confirmation = stage();
    const otherAccount = { ...ACCOUNT, id: "act_222", accountId: "222", name: "Başka Hesap" };

    await expect(
      applyDashboardConfirmation(CTX, otherAccount, confirmation.id),
    ).rejects.toMatchObject({ code: "ai_confirmation_expired" });
    expect(metaPostFormMock).not.toHaveBeenCalled();
    // And the real owner's confirmation was not consumed by the attempt.
    expect(pendingWriteCount()).toBe(1);
  });

  it("records the rejection when the user cancels", async () => {
    const confirmation = stage();
    const staged = discardWrite(confirmation.id, OWNER);
    expect(staged).not.toBeNull();

    await getAuditLog().record(CTX.fbUserId, {
      at: new Date().toISOString(),
      userHash: null,
      accountId: ACCOUNT.id,
      accountName: ACCOUNT.name,
      tool: staged!.plan.tool,
      level: staged!.plan.verify.level,
      objectId: staged!.plan.verify.id,
      objectName: staged!.plan.fields[0]?.value ?? null,
      before: staged!.plan.expected,
      after: staged!.plan.body,
      reason: staged!.plan.reason,
      outcome: "rejected",
      verified: null,
      errorCode: null,
    });

    const entries = await getAuditLog().list(CTX.fbUserId);
    expect(entries[0]?.outcome).toBe("rejected");
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("lets a Meta failure keep its own classification instead of becoming an AI error", async () => {
    metaPostFormMock.mockRejectedValue(new Error("Invalid or expired access token"));
    const confirmation = stage();

    await expect(applyDashboardConfirmation(CTX, ACCOUNT, confirmation.id)).rejects.toThrow(
      /Invalid or expired access token/,
    );
  });
});
