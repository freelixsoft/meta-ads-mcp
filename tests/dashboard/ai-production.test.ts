import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * The properties that decide whether this integration survives production
 * rather than a demo: what the wire request actually looks like, whether a turn
 * can run away with wall-clock time, whether a truncated answer is passed off
 * as a complete one, whether a failing provider is visible on /ai/status, and
 * whether the model is told plainly which metrics the data does not contain.
 *
 * No network call is made anywhere in this file.
 */

const metaGetMock = vi.fn();
const metaGetPaginatedMock = vi.fn();

vi.mock("../../src/meta/client.js", () => ({
  metaApiClient: {
    get: (...args: unknown[]) => metaGetMock(...args),
    getPaginated: (...args: unknown[]) => metaGetPaginatedMock(...args),
    postForm: vi.fn(),
  },
}));

const { buildCreateParams, configureClaudeClientForTests, ClaudeError } = await import(
  "../../src/claude/client.js"
);
const { runAgent, MAX_TURN_MS, TRUNCATED_NOTE } = await import("../../src/claude/agent.js");
const { READ_TOOLS_BY_NAME, buildToolDefinitions } = await import("../../src/claude/tools.js");
const { runDashboardChat, getAiStatus } = await import("../../src/dashboard/ai/service.js");
const { clearProviderHealth } = await import("../../src/dashboard/ai/provider.js");
const { buildSystemPrompt } = await import("../../src/claude/prompt.js");
const { dashboardCache } = await import("../../src/dashboard/cache.js");
const { clearPendingWrites } = await import("../../src/claude/confirmations.js");

import type { ClaudeClient, ClaudeRequest } from "../../src/claude/client.js";
import type { AdAccountDto } from "../../src/dashboard/dto.js";
import type { ToolExecutionContext } from "../../src/claude/types.js";

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
  ctx: { fbUserId: "1000000000001", tokenHash: "abc123def456" },
  account: ACCOUNT,
};

type PartialMessage = Pick<Anthropic.Message, "content" | "stop_reason">;

let sentRequests: ClaudeRequest[];

function scriptedClient(
  script: PartialMessage[],
  onCall?: () => void,
): ClaudeClient {
  let index = 0;
  return {
    model: "claude-test",
    async createMessage(request: ClaudeRequest) {
      sentRequests.push(request);
      onCall?.();
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
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 },
      } as unknown as Anthropic.Message;
    },
  };
}

function text(value: string, stopReason: Anthropic.Message["stop_reason"] = "end_turn"): PartialMessage {
  return {
    content: [{ type: "text", text: value, citations: null }] as unknown as Anthropic.ContentBlock[],
    stop_reason: stopReason,
  };
}

function toolUse(name: string, input: unknown): PartialMessage {
  return {
    content: [{ type: "tool_use", id: "tu_1", name, input }] as unknown as Anthropic.ContentBlock[],
    stop_reason: "tool_use",
  };
}

beforeEach(() => {
  dashboardCache.clear();
  clearPendingWrites();
  clearProviderHealth();
  sentRequests = [];
  process.env.ANTHROPIC_API_KEY = "placeholder-for-tests-never-sent";

  metaGetMock.mockImplementation((path: string, params: Record<string, unknown>) =>
    path.endsWith("/insights")
      ? Promise.resolve(
          params.time_increment
            ? { data: [] }
            : { data: [{ date_start: "2026-09-13", date_stop: "2026-09-19", spend: "1000", impressions: "50000", clicks: "1500" }] },
        )
      : Promise.resolve({ id: "100", name: "Kış", account_id: "111", status: "ACTIVE" }),
  );
  metaGetPaginatedMock.mockResolvedValue([]);
});

afterEach(() => {
  configureClaudeClientForTests(undefined);
  clearProviderHealth();
  delete process.env.ANTHROPIC_API_KEY;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("the request that goes on the wire", () => {
  const request: ClaudeRequest = {
    system: "SYSTEM",
    messages: [{ role: "user", content: "merhaba" }],
    tools: buildToolDefinitions({ allowWrites: false }),
  };

  it("puts a cache breakpoint at the end of the system prompt, which covers the tools", () => {
    const params = buildCreateParams(request, "claude-opus-5");

    expect(params.system).toEqual([
      { type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } },
    ]);
    // Render order is tools -> system -> messages, so one breakpoint here
    // caches the ~15 tool schemas too.
    expect(params.tools).toHaveLength(10);
  });

  it("asks for adaptive thinking at a bounded effort and a bounded output", () => {
    const params = buildCreateParams(request, "claude-opus-5");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "medium" });
    expect(params.max_tokens).toBe(16_000);
    expect(params.model).toBe("claude-opus-5");
  });

  it("honours a smaller output ceiling for the one-shot endpoints", () => {
    expect(buildCreateParams({ ...request, maxTokens: 2048 }, "claude-opus-5").max_tokens).toBe(2048);
  });

  it("omits tools entirely when there are none, rather than sending an empty list", () => {
    const params = buildCreateParams({ system: "S", messages: [] }, "claude-opus-5");
    expect(params).not.toHaveProperty("tools");
  });

  it("carries no credential of any kind", () => {
    const serialized = JSON.stringify(buildCreateParams(request, "claude-opus-5"));
    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain("EAA");
    expect(serialized).not.toContain("api_key");
  });
});

describe("the system prompt stays cacheable", () => {
  it("changes only with the account and the calendar day", () => {
    const a = buildSystemPrompt(ACCOUNT, "2026-09-19");
    const b = buildSystemPrompt(ACCOUNT, "2026-09-19");
    // Byte-identical across calls: anything per-request in here would silently
    // destroy the cache hit rate on every turn.
    expect(a).toBe(b);
    expect(buildSystemPrompt(ACCOUNT, "2026-09-20")).not.toBe(a);
  });
});

describe("a turn cannot run away with wall-clock time", () => {
  it("gives each step only what is left of the turn budget", async () => {
    configureClaudeClientForTests(
      scriptedClient([toolUse("meta_get_insights", { preset: "last_7d" }), text("Özet.")]),
    );

    await runAgent(TOOLS, { question: "Nasıl gidiyor?", history: [], allowWrites: false });

    expect(sentRequests).toHaveLength(2);
    for (const request of sentRequests) {
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.timeoutMs).toBeLessThanOrEqual(MAX_TURN_MS);
    }
    // The second step cannot be given more time than the first had left.
    expect(sentRequests[1].timeoutMs!).toBeLessThanOrEqual(sentRequests[0].timeoutMs!);
  });

  it("stops with a timeout instead of starting a step it cannot finish", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    // Each model call burns most of the budget.
    configureClaudeClientForTests(
      scriptedClient([toolUse("meta_get_insights", { preset: "last_7d" })], () => {
        now += 60_000;
      }),
    );

    const result = await runAgent(TOOLS, { question: "Nasıl gidiyor?", history: [], allowWrites: false });

    expect(result.stopReason).toBe("timeout");
    // Two calls fit inside two minutes; a third would not have been started.
    expect(sentRequests.length).toBeLessThanOrEqual(2);
    expect(result.answer).toContain("daraltıp");
  });
});

describe("a truncated answer is never passed off as a complete one", () => {
  it("appends a note when the model hit the output ceiling", async () => {
    configureClaudeClientForTests(
      scriptedClient([text("Harcama 1.000 TRY ve ROAS", "max_tokens")]),
    );

    const result = await runAgent(TOOLS, { question: "Özet ver", history: [], allowWrites: false });

    expect(result.answer).toContain("Harcama 1.000 TRY ve ROAS");
    expect(result.answer).toContain(TRUNCATED_NOTE);
    expect(result.answer).toContain("uzunluk sınırına takıldığı");
  });

  it("leaves a complete answer untouched", async () => {
    configureClaudeClientForTests(scriptedClient([text("Harcama 1.000 TRY.")]));
    const result = await runAgent(TOOLS, { question: "Özet ver", history: [], allowWrites: false });
    expect(result.answer).toBe("Harcama 1.000 TRY.");
  });
});

describe("a failing provider becomes visible on /ai/status", () => {
  it("reports rate limiting after a throttled chat turn, not 'available'", async () => {
    configureClaudeClientForTests({
      model: "claude-test",
      createMessage: async () => {
        throw new ClaudeError("rate_limited", "Anthropic is rate limiting this key.");
      },
    });

    await expect(
      runDashboardChat(TOOLS.ctx, ACCOUNT, { message: "Nasıl gidiyor?" }),
    ).rejects.toMatchObject({ code: "ai_rate_limited" });

    const status = await getAiStatus();
    expect(status).toMatchObject({ configured: true, rateLimited: true, available: false });
  });

  it("reports an outage after an unreachable provider", async () => {
    configureClaudeClientForTests({
      model: "claude-test",
      createMessage: async () => {
        throw new ClaudeError("unavailable", "Anthropic could not be reached.");
      },
    });

    await expect(
      runDashboardChat(TOOLS.ctx, ACCOUNT, { message: "Nasıl gidiyor?" }),
    ).rejects.toMatchObject({ code: "ai_unavailable" });

    expect(await getAiStatus()).toMatchObject({ unavailable: true, available: false });
  });

  it("is healthy again once nothing is failing", async () => {
    clearProviderHealth();
    expect(await getAiStatus()).toMatchObject({ available: true, rateLimited: false, unavailable: false });
  });
});

describe("the model is told what the data does not contain", () => {
  async function campaigns() {
    const tool = READ_TOOLS_BY_NAME.get("meta_get_campaigns")!;
    return (await tool.run(tool.schema.parse({ preset: "last_7d" }), TOOLS)) as {
      rows: Array<Record<string, unknown>>;
      dataQuality: { rowsWithNoDelivery: number; metricsMissingOnEveryRow: string[] };
    };
  }

  it("names the metrics Meta returned for none of the rows", async () => {
    metaGetPaginatedMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/campaigns")
          ? [
              { id: "1", name: "Kış", status: "ACTIVE", effective_status: "ACTIVE" },
              { id: "2", name: "Yaz", status: "ACTIVE", effective_status: "ACTIVE" },
            ]
          : [
              { campaign_id: "1", spend: "700", impressions: "35000", clicks: "1100" },
              { campaign_id: "2", spend: "300", impressions: "15000", clicks: "400" },
            ],
      ),
    );

    const result = await campaigns();

    // No purchase data came back for either row, so ranking on ROAS is not
    // something the model may do.
    expect(result.dataQuality.metricsMissingOnEveryRow).toEqual(
      expect.arrayContaining(["roas", "purchaseValue", "costPerPurchase"]),
    );
    expect(result.dataQuality.metricsMissingOnEveryRow).not.toContain("spend");
    expect(result.dataQuality.rowsWithNoDelivery).toBe(0);
  });

  it("does not flag a metric that is present on at least one row", async () => {
    metaGetPaginatedMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/campaigns")
          ? [
              { id: "1", name: "Kış", status: "ACTIVE", effective_status: "ACTIVE" },
              { id: "2", name: "Yaz", status: "ACTIVE", effective_status: "ACTIVE" },
            ]
          : [
              {
                campaign_id: "1",
                spend: "700",
                impressions: "35000",
                clicks: "1100",
                actions: [{ action_type: "omni_purchase", value: "10" }],
                action_values: [{ action_type: "omni_purchase", value: "2000" }],
              },
              { campaign_id: "2", spend: "300", impressions: "15000", clicks: "400" },
            ],
      ),
    );

    const result = await campaigns();
    expect(result.dataQuality.metricsMissingOnEveryRow).not.toContain("roas");
    expect(result.dataQuality.metricsMissingOnEveryRow).not.toContain("purchaseValue");
  });

  it("counts rows that simply did not run, so they are not called bad performers", async () => {
    metaGetPaginatedMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/campaigns")
          ? [
              { id: "1", name: "Kış", status: "ACTIVE", effective_status: "ACTIVE" },
              { id: "2", name: "Duraklatılmış", status: "PAUSED", effective_status: "PAUSED" },
            ]
          : [{ campaign_id: "1", spend: "700", impressions: "35000", clicks: "1100" }],
      ),
    );

    const result = await campaigns();
    expect(result.rows).toHaveLength(2);
    expect(result.dataQuality.rowsWithNoDelivery).toBe(1);
  });

  it("states both rules in the system prompt", () => {
    const prompt = buildSystemPrompt(ACCOUNT, "2026-09-19");
    expect(prompt).toContain("metricsMissingOnEveryRow");
    expect(prompt).toContain("Never rank, compare or recommend on one of those");
    expect(prompt).toContain("rowsWithNoDelivery");
    expect(prompt).toContain("they simply did not run");
  });
});
