import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Phase 6: what keeps an answer cheap, checkable and actionable.
 *
 * Three things are pinned here — that a read asked for twice in one turn costs
 * nothing the second time, that the trace under an answer carries enough
 * evidence to check it against the tables, and that the prompt routes the
 * dashboard's own example questions to a single first tool instead of a walk
 * down the hierarchy.
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

const { runAgent, describeResult, toolCallKey, MAX_TOOL_CALLS } = await import(
  "../../src/claude/agent.js"
);
const { configureClaudeClientForTests } = await import("../../src/claude/client.js");
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
  ctx: { fbUserId: "1000000000001", tokenHash: "fixturehash1" },
  account: ACCOUNT,
};

type PartialMessage = Pick<Anthropic.Message, "content" | "stop_reason">;

let sentRequests: ClaudeRequest[];

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
  return {
    content: [{ type: "text", text: value, citations: null }] as unknown as Anthropic.ContentBlock[],
    stop_reason: "end_turn",
  };
}

function calls(...uses: Array<{ name: string; input: unknown }>): PartialMessage {
  return {
    content: uses.map((use, index) => ({
      type: "tool_use",
      id: `tu_${index}`,
      name: use.name,
      input: use.input,
    })) as unknown as Anthropic.ContentBlock[],
    stop_reason: "tool_use",
  };
}

function resultBlocks(): Anthropic.ToolResultBlockParam[] {
  const last = sentRequests[sentRequests.length - 1];
  return last.messages
    .filter((message) => message.role === "user" && Array.isArray(message.content))
    .flatMap((message) => message.content as Anthropic.ToolResultBlockParam[])
    .filter((block) => block?.type === "tool_result");
}

const CAMPAIGNS = [
  { id: "100", name: "Kış Kampanyası", status: "ACTIVE", effective_status: "ACTIVE" },
  { id: "101", name: "Yaz Kampanyası", status: "PAUSED", effective_status: "PAUSED" },
];

beforeEach(() => {
  dashboardCache.clear();
  clearPendingWrites();
  sentRequests = [];

  metaGetMock.mockImplementation((path: string, params: Record<string, unknown>) =>
    path.endsWith("/insights")
      ? Promise.resolve(
          params.time_increment
            ? { data: [] }
            : { data: [{ date_start: "2026-09-12", date_stop: "2026-09-18", spend: "1000", impressions: "50000", clicks: "1500" }] },
        )
      : Promise.resolve({ id: "100", name: "Kış", account_id: "111", status: "ACTIVE" }),
  );

  metaGetPaginatedMock.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith("/campaigns")
        ? CAMPAIGNS
        : path.endsWith("/insights")
          ? [{ campaign_id: "100", spend: "700", impressions: "35000", clicks: "1100" }]
          : [],
    ),
  );
});

afterEach(() => {
  configureClaudeClientForTests(undefined);
  vi.clearAllMocks();
});

describe("toolCallKey", () => {
  it("matches the same call regardless of argument order", () => {
    expect(toolCallKey("meta_get_campaigns", { preset: "last_7d", limit: 5 })).toBe(
      toolCallKey("meta_get_campaigns", { limit: 5, preset: "last_7d" }),
    );
  });

  it("separates different arguments and different tools", () => {
    expect(toolCallKey("meta_get_campaigns", { preset: "last_7d" })).not.toBe(
      toolCallKey("meta_get_campaigns", { preset: "last_30d" }),
    );
    expect(toolCallKey("meta_get_ads", { preset: "last_7d" })).not.toBe(
      toolCallKey("meta_get_campaigns", { preset: "last_7d" }),
    );
  });
});

describe("a repeated read costs nothing the second time", () => {
  it("refuses an identical call and does not touch Meta again", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        calls(
          { name: "meta_get_campaigns", input: { preset: "last_7d" } },
          { name: "meta_get_campaigns", input: { preset: "last_7d" } },
        ),
        text("Kış Kampanyası 700 TRY harcadı."),
      ]),
    );

    const result = await runAgent(TOOLS, {
      question: "Hangi kampanya para kaybettiriyor?",
      history: [],
      allowWrites: false,
    });

    // One read happened; the duplicate was answered from the conversation.
    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0].status).toBe("ok");

    const blocks = resultBlocks();
    expect(blocks).toHaveLength(2);
    expect(String(blocks[1].content)).toContain("duplicate_call");
    expect(blocks[1].is_error).toBe(true);

    // The campaign edge was read once, not twice.
    const campaignReads = metaGetPaginatedMock.mock.calls.filter(([path]) =>
      String(path).endsWith("/campaigns"),
    );
    expect(campaignReads).toHaveLength(1);
  });

  it("gives the budget slot back, so a duplicate does not cost a real read", async () => {
    // Five identical calls per step: without the refund these would burn the
    // whole tool budget without reading anything new.
    const repeated = calls(
      ...Array.from({ length: 5 }, () => ({
        name: "meta_get_campaigns",
        input: { preset: "last_7d" },
      })),
    );
    configureClaudeClientForTests(scriptedClient([repeated]));

    const result = await runAgent(TOOLS, { question: "Kampanyalar?", history: [], allowWrites: false });

    // Only the first of each identical batch ever ran.
    expect(result.toolTrace.filter((entry) => entry.status === "ok")).toHaveLength(1);
    expect(result.toolTrace.length).toBeLessThan(MAX_TOOL_CALLS);
  });

  it("still allows the same tool with different arguments", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        calls(
          { name: "meta_get_campaigns", input: { preset: "last_7d" } },
          { name: "meta_get_campaigns", input: { preset: "last_30d" } },
        ),
        text("İki dönem karşılaştırıldı."),
      ]),
    );

    const result = await runAgent(TOOLS, { question: "Karşılaştır", history: [], allowWrites: false });
    expect(result.toolTrace.filter((entry) => entry.status === "ok")).toHaveLength(2);
  });
});

describe("describeResult — the evidence under an answer", () => {
  it("reports how much of the account was seen and over which dates", () => {
    expect(
      describeResult({
        rows: [{}, {}],
        totalRows: 22,
        period: { since: "2026-09-12", until: "2026-09-18" },
      }),
    ).toBe("2/22 satır · 2026-09-12 – 2026-09-18");
  });

  it("does not imply truncation when everything was returned", () => {
    expect(describeResult({ rows: [{}, {}], totalRows: 2 })).toBe("2 satır");
  });

  it("falls back to the preset when Meta resolved no concrete dates", () => {
    expect(describeResult({ rows: [], totalRows: 0, period: { preset: "last_7d" } })).toBe(
      "0 satır · last_7d",
    );
  });

  it("flags metrics the data did not contain at all", () => {
    expect(
      describeResult({
        rows: [{}],
        totalRows: 1,
        dataQuality: { rowsWithNoDelivery: 0, metricsMissingOnEveryRow: ["roas", "purchaseValue"] },
      }),
    ).toBe("1 satır · 2 metrik yok");
  });

  it("describes an account list, and stays silent on a shape it cannot summarise", () => {
    expect(describeResult({ accounts: [{}, {}, {}] })).toBe("3 hesap");
    expect(describeResult({ answer: "merhaba" })).toBeUndefined();
    expect(describeResult(null)).toBeUndefined();
    expect(describeResult("text")).toBeUndefined();
  });

  it("reaches the trace, so the UI can show it under the answer", async () => {
    configureClaudeClientForTests(
      scriptedClient([
        calls({ name: "meta_get_campaigns", input: { preset: "last_7d" } }),
        text("Özet."),
      ]),
    );

    const result = await runAgent(TOOLS, { question: "Kampanyalar?", history: [], allowWrites: false });

    expect(result.toolTrace[0].label).toBe("Kampanyalar okundu (last_7d)");
    expect(result.toolTrace[0].detail).toContain("2 satır");
  });
});

describe("the prompt routes the dashboard's own example questions", () => {
  const prompt = buildSystemPrompt(ACCOUNT, "2026-09-19");

  it("names a single first tool for each question the UI suggests", () => {
    expect(prompt).toContain("ROUTING");
    expect(prompt).toContain("'Hangi kampanya para kaybettiriyor?'         -> meta_get_campaigns");
    expect(prompt).toContain("'Hangi reklamları kapatmalıyım?'             -> meta_get_ads with no adSetId");
    expect(prompt).toContain("'Bütçeyi hangi reklam setlerine artırayım?'  -> meta_get_ad_sets with no campaignId");
    expect(prompt).toContain("'Son 30 güne göre bu hafta ne değişti?'      -> meta_compare_periods");
    expect(prompt).toContain("'En fazla harcayan reklamlar hangileri?'     -> meta_get_ads with no adSetId");
  });

  it("tells the model to drill down only after an account-wide read", () => {
    expect(prompt).toContain("only once an account-wide read has shown which");
  });

  it("forbids asking for the same data twice in a turn", () => {
    expect(prompt).toContain("Never call the same tool twice with the same arguments in one turn");
  });

  it("requires concrete recommendations, and forbids inventing one", () => {
    expect(prompt).toContain("THEN SAY WHAT TO DO");
    expect(prompt).toContain("Öneriler:");
    expect(prompt).toContain("names the object, the action and the number that justifies it");
    expect(prompt).toContain("If it supports nothing, say so");
  });

  it("keeps a recommendation separate from an action", () => {
    expect(prompt).toContain("A recommendation is advice, not an action");
    expect(prompt).toContain("Do not call a write tool unless the user asked you to");
  });
});
