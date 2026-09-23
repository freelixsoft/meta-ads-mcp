import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * The agent loop with a scripted model in front of it and a mocked Meta client
 * behind it. No network call of any kind happens here.
 *
 * What these tests are really pinning is the set of things that bound the loop:
 * step and tool-call ceilings, result sizes, one staged write per turn, and the
 * fact that a write tool leaves Meta untouched.
 */

const metaGetMock = vi.fn();
const metaGetPaginatedMock = vi.fn();
const metaPostFormMock = vi.fn();

vi.mock("../../src/meta/client.js", () => ({
  metaApiClient: {
    get: (...args: unknown[]) => metaGetMock(...args),
    getPaginated: (...args: unknown[]) => metaGetPaginatedMock(...args),
    postForm: (...args: unknown[]) => metaPostFormMock(...args),
  },
}));

const { runAgent, MAX_STEPS, MAX_TOOL_CALLS } = await import("../../src/claude/agent.js");
const { configureClaudeClientForTests } = await import("../../src/claude/client.js");
const { clearPendingWrites, pendingWriteCount } = await import("../../src/claude/confirmations.js");
const { dashboardCache } = await import("../../src/dashboard/cache.js");

import type { ClaudeClient, ClaudeRequest } from "../../src/claude/client.js";
import type { AdAccountDto } from "../../src/dashboard/dto.js";
import type { ToolExecutionContext } from "../../src/claude/types.js";

const META_TOKEN = "EAAtest_never_leaves_the_server_0123456789";

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

const TOOLS: ToolExecutionContext = {
  ctx: { fbUserId: "1000000000001", tokenHash: "fixturehash1" },
  account: ACCOUNT,
};

const CAMPAIGN = {
  id: "100",
  name: "Kış Kampanyası",
  account_id: "111",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  objective: "OUTCOME_SALES",
  daily_budget: "25000",
};

type PartialMessage = Pick<Anthropic.Message, "content" | "stop_reason">;

let sentRequests: ClaudeRequest[];

/** A model that replies with a fixed script, one entry per loop step. */
function scriptedClient(script: PartialMessage[]): ClaudeClient {
  let index = 0;
  return {
    model: "claude-test",
    async createMessage(request: ClaudeRequest) {
      sentRequests.push(request);
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      return {
        id: `msg_${index}`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: next.content,
        stop_reason: next.stop_reason,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      } as unknown as Anthropic.Message;
    },
  };
}

function text(value: string): PartialMessage {
  return { content: [{ type: "text", text: value, citations: null }] as unknown as Anthropic.ContentBlock[], stop_reason: "end_turn" };
}

function toolUse(name: string, input: unknown, id = "tu_1"): PartialMessage {
  return {
    content: [{ type: "tool_use", id, name, input }] as unknown as Anthropic.ContentBlock[],
    stop_reason: "tool_use",
  };
}

function ask(question = "Son 30 günde nasıl gidiyor?", allowWrites = true) {
  return runAgent(TOOLS, { question, history: [], allowWrites });
}

/** Every tool_result block the loop fed back to the model. */
function resultBlocks(): Anthropic.ToolResultBlockParam[] {
  const last = sentRequests[sentRequests.length - 1];
  return last.messages
    .filter((message) => message.role === "user" && Array.isArray(message.content))
    .flatMap((message) => message.content as Anthropic.ToolResultBlockParam[])
    .filter((block) => block?.type === "tool_result");
}

beforeEach(() => {
  dashboardCache.clear();
  clearPendingWrites();
  sentRequests = [];

  metaGetMock.mockImplementation((path: string, params: Record<string, unknown>) => {
    if (path.endsWith("/insights")) {
      return Promise.resolve(
        params.time_increment
          ? { data: [] }
          : {
              data: [
                {
                  date_start: "2026-08-21",
                  date_stop: "2026-09-19",
                  spend: "1000",
                  impressions: "50000",
                  clicks: "1500",
                  actions: [{ action_type: "omni_purchase", value: "40" }],
                  action_values: [{ action_type: "omni_purchase", value: "6000" }],
                },
              ],
            },
      );
    }
    return Promise.resolve(CAMPAIGN);
  });

  metaGetPaginatedMock.mockImplementation((path: string) => {
    if (path.endsWith("/adaccounts")) {
      return Promise.resolve([
        { id: "act_111", account_id: "111", name: "Acme TR", account_status: 1, currency: "TRY", access_token: META_TOKEN },
      ]);
    }
    if (path.endsWith("/campaigns")) return Promise.resolve([CAMPAIGN]);
    if (path === "/act_111/ads") {
      return Promise.resolve([
        {
          id: "300",
          name: "Video 15sn",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          adset_id: "200",
          campaign_id: "100",
          adset: { id: "200", name: "TR - 25-45" },
          campaign: { id: "100", name: "Kış Kampanyası" },
        },
      ]);
    }
    if (path.endsWith("/insights")) {
      return Promise.resolve([{ ad_id: "300", spend: "700", impressions: "35000", clicks: "1100" }]);
    }
    return Promise.resolve([]);
  });

  metaPostFormMock.mockResolvedValue({ id: "555" });
});

afterEach(() => {
  configureClaudeClientForTests(undefined);
  vi.clearAllMocks();
});

describe("the read path", () => {
  it("calls a tool, feeds the result back and returns the model's Turkish answer", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        toolUse("meta_get_insights", { preset: "last_30d", compare: true }),
        text("Son 30 günde 1.000 TRY harcandı ve ROAS 6x."),
      ]),
    );

    const result = await ask();

    expect(result.answer).toBe("Son 30 günde 1.000 TRY harcandı ve ROAS 6x.");
    expect(result.stopReason).toBe("answered");
    expect(result.steps).toBe(2);
    expect(result.toolTrace).toEqual([
      {
        name: "meta_get_insights",
        label: "Performans verileri okundu (last_30d)",
        status: "ok",
        // The evidence line the UI shows under the answer.
        detail: expect.stringContaining("2026-08-21"),
      },
    ]);
    expect(result.pendingConfirmation).toBeNull();
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("sends the Meta token to nobody", async () => {
    configureClaudeClientForTests(
      scriptedClient([toolUse("meta_list_ad_accounts", {}), text("Bir hesabınız var: Acme TR.")]),
    );

    await ask();

    const everythingSent = JSON.stringify(sentRequests);
    expect(everythingSent).not.toContain(META_TOKEN);
    expect(everythingSent).not.toContain("EAA");
    expect(everythingSent).not.toContain(TOOLS.ctx.tokenHash);
    expect(everythingSent).not.toContain("sk-ant");
  });

  it("declares the tools on every request so the model can drill down", async () => {
    configureClaudeClientForTests(scriptedClient([text("Merhaba.")]));
    await ask();
    expect(sentRequests[0].tools?.length).toBe(18);
    expect(sentRequests[0].system).toContain("Acme TR");
  });
});

describe("answering the questions the dashboard promises", () => {
  it("finds the worst ad across the account in one read, not a walk down the tree", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        toolUse("meta_get_ads", { preset: "last_7d" }),
        text("Video 15sn reklamı 7 günde 700 TRY harcadı ve satın alma getirmedi; onu kapatmanızı öneririm."),
      ]),
    );

    const result = await ask("Son 7 günde hangi reklam para kaybettiriyor?");

    expect(result.answer).toContain("kapatmanızı öneririm");
    expect(result.toolTrace).toEqual([
      {
        name: "meta_get_ads",
        label: "Hesaptaki tüm reklamlar okundu (last_7d)",
        status: "ok",
        detail: expect.stringContaining("1 satır"),
      },
    ]);
    // One account-wide edge read plus its insights — no per-parent walk.
    expect(metaGetPaginatedMock).toHaveBeenCalledWith("/act_111/ads", expect.anything(), expect.any(Number));
    expect(metaGetPaginatedMock).not.toHaveBeenCalledWith("/100/adsets", expect.anything(), expect.any(Number));
  });

  it("compares periods for a 'what changed' question", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        toolUse("meta_compare_periods", { preset: "last_7d" }),
        text("Son 7 günde harcama sabit kalırken satın alma sayısı düştü."),
      ]),
    );

    const result = await ask("Son 7 günde ne değişti?");
    expect(result.toolTrace[0].label).toBe("Dönem karşılaştırması yapıldı (last_7d)");
    expect(result.stopReason).toBe("answered");
  });
});

describe("bad tool calls", () => {
  it("returns an error result for an unknown tool and keeps going", async () => {
    configureClaudeClientForTests(
      scriptedClient([toolUse("meta_delete_everything", {}), text("Böyle bir araç yok.")]),
    );

    const result = await ask();

    expect(result.answer).toBe("Böyle bir araç yok.");
    expect(result.toolTrace[0]).toMatchObject({ status: "error", errorCode: "unknown_tool" });
    const blocks = resultBlocks();
    expect(blocks[0].is_error).toBe(true);
    expect(String(blocks[0].content)).toContain("unknown_tool");
  });

  it("returns a validation error the model can act on, rather than throwing", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        toolUse("meta_get_ad_sets", { preset: "last_30d", campaignId: "not-a-number" }),
        text("Kampanya kimliği geçersizdi."),
      ]),
    );

    const result = await ask();

    expect(result.toolTrace[0]).toMatchObject({ status: "error", errorCode: "invalid_arguments" });
    expect(String(resultBlocks()[0].content)).toContain("invalid_arguments");
  });

  it("maps a Meta authorization failure to a stable code without upstream detail", async () => {
    metaGetMock.mockImplementation((path: string) =>
      path.endsWith("/insights")
        ? Promise.resolve({ data: [] })
        : Promise.resolve({ ...CAMPAIGN, account_id: "222" }),
    );
    configureClaudeClientForTests(
      scriptedClient([
        toolUse("meta_get_ad_sets", { preset: "last_30d", campaignId: "100" }),
        text("Bu kampanyaya erişemiyorum."),
      ]),
    );

    const result = await ask();
    expect(result.toolTrace[0]).toMatchObject({ status: "error", errorCode: "account_forbidden" });
  });
});

describe("loop ceilings", () => {
  it("stops after the step ceiling instead of looping forever", async () => {
    // A model that only ever asks for another tool call.
    configureClaudeClientForTests(scriptedClient([toolUse("meta_get_campaigns", { preset: "last_7d" })]));

    const result = await ask();

    expect(result.stopReason).toBe("max_steps");
    expect(result.steps).toBe(MAX_STEPS);
    expect(result.answer).toContain("daraltıp tekrar dener misiniz");
  });

  it("refuses further tool calls once the tool budget is spent", async () => {
    // Three parallel calls per step over six steps is eighteen calls, which
    // passes the twelve-call ceiling. Every call has distinct arguments on
    // purpose: identical ones are de-duplicated and refunded, so a repetitive
    // model can never exhaust the budget — that is the point of the dedup.
    const step = (base: number): PartialMessage => ({
      content: [0, 1, 2].map((offset) => ({
        type: "tool_use",
        id: `tu_${base + offset}`,
        name: "meta_get_campaigns",
        input: { preset: "last_7d", limit: base + offset + 1 },
      })) as unknown as Anthropic.ContentBlock[],
      stop_reason: "tool_use",
    });
    configureClaudeClientForTests(
      scriptedClient([step(0), step(3), step(6), step(9), step(12), step(15)]),
    );

    const result = await ask();

    const executed = result.toolTrace.filter((entry) => entry.status === "ok").length;
    expect(executed).toBe(MAX_TOOL_CALLS);
    expect(String(resultBlocks().at(-1)?.content)).toContain("tool_budget_exhausted");
  });

  it("bounds a large tool result instead of forwarding it whole", async () => {
    metaGetPaginatedMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/campaigns")
          ? Array.from({ length: 40 }, (_, index) => ({
              id: String(1000 + index),
              name: `Kampanya ${"uzun ad ".repeat(10)}${index}`,
              status: "ACTIVE",
              effective_status: "ACTIVE",
            }))
          : [],
      ),
    );
    configureClaudeClientForTests(
      scriptedClient([toolUse("meta_get_campaigns", { preset: "last_7d", limit: 40 }), text("Özet.")]),
    );

    await ask();
    const payload = String(resultBlocks()[0].content);
    expect(payload.length).toBeLessThanOrEqual(12_000);
  });
});

describe("the write path", () => {
  it("stages a proposed change and sends nothing to Meta", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        toolUse("meta_create_campaign", { reason: "Test gerekçesi.", name: "Kış 2026", objective: "OUTCOME_SALES", dailyBudget: 1500 }),
        text("Onaylarsanız kampanyayı oluşturacağım."),
      ]),
    );

    const result = await ask("hacpuzzle2'de yeni kampanya oluştur, günlük bütçe 1500 TL olsun.");

    expect(metaPostFormMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("awaiting_confirmation");
    expect(result.pendingConfirmation).toMatchObject({
      tool: "meta_create_campaign",
      title: "Meta'da yeni kampanya oluşturulacak",
      accountName: "Acme TR",
    });
    expect(result.pendingConfirmation?.fields).toContainEqual({
      label: "Günlük bütçe",
      value: "1.500,00 TRY",
    });
    expect(pendingWriteCount()).toBe(1);
    expect(result.toolTrace[0].status).toBe("awaiting_confirmation");
  });

  it("tells the model in its own tool result that nothing was sent", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        toolUse("meta_update_campaign", { reason: "Test gerekçesi.", campaignId: "100", status: "PAUSED" }),
        text("Onayınızı bekliyorum."),
      ]),
    );

    await ask("100 numaralı kampanyayı durdur");
    expect(String(resultBlocks()[0].content)).toContain("NOT SENT TO META");
  });

  it("refuses a second change in the same turn", async () => {
    const twoWrites: PartialMessage = {
      content: [
        { type: "tool_use", id: "tu_1", name: "meta_update_campaign", input: { reason: "Test gerekçesi.", campaignId: "100", status: "PAUSED" } },
        { type: "tool_use", id: "tu_2", name: "meta_update_campaign", input: { reason: "Test gerekçesi.", campaignId: "100", status: "ACTIVE" } },
      ] as unknown as Anthropic.ContentBlock[],
      stop_reason: "tool_use",
    };
    configureClaudeClientForTests(scriptedClient([twoWrites, text("Bir işlem onay bekliyor.")]));

    const result = await ask("durdur ve sonra başlat");

    expect(pendingWriteCount()).toBe(1);
    expect(result.pendingConfirmation?.tool).toBe("meta_update_campaign");
    expect(String(resultBlocks()[1].content)).toContain("confirmation_already_pending");
  });

  it("does not offer or accept a write when writes are disabled for the turn", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        toolUse("meta_update_campaign", { reason: "Test gerekçesi.", campaignId: "100", status: "PAUSED" }),
        text("Değişiklik yapamıyorum."),
      ]),
    );

    const result = await ask("kampanyayı durdur", false);

    expect(sentRequests[0].tools?.length).toBe(12);
    expect(result.pendingConfirmation).toBeNull();
    expect(pendingWriteCount()).toBe(0);
    expect(result.toolTrace[0]).toMatchObject({ status: "error", errorCode: "writes_disabled" });
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });

  it("stops after a staged write even if the model reaches for another tool", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        toolUse("meta_create_campaign", { reason: "Test gerekçesi.", name: "A", objective: "OUTCOME_SALES" }),
        toolUse("meta_get_campaigns", { preset: "last_7d" }, "tu_2"),
      ]),
    );

    const result = await ask("yeni kampanya aç");

    expect(result.stopReason).toBe("awaiting_confirmation");
    expect(result.answer).toContain("Onayınızı bekleyen bir işlem var");
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });
});

describe("model-side failures", () => {
  it("returns a Turkish message when the model declines", async () => {
    configureClaudeClientForTests(
      scriptedClient([{ content: [] as unknown as Anthropic.ContentBlock[], stop_reason: "refusal" }]),
    );

    const result = await ask();
    expect(result.stopReason).toBe("refusal");
    expect(result.answer).toContain("yanıtlayamıyorum");
  });

  it("falls back to a usable sentence when the model returns no text at all", async () => {
    configureClaudeClientForTests(
      scriptedClient([{ content: [] as unknown as Anthropic.ContentBlock[], stop_reason: "end_turn" }]),
    );

    const result = await ask();
    expect(result.stopReason).toBe("answered");
    expect(result.answer).toContain("Soruyu biraz daha açık yazar mısınız?");
  });

  it("strips control characters out of whatever the model wrote", async () => {
    configureClaudeClientForTests(scriptedClient([text("Harcama  arttı​.")]));
    const result = await ask();
    expect(result.answer).toBe("Harcama arttı.");
  });
});
