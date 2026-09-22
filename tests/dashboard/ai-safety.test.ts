import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Two invariants that are cheap to break and expensive to notice.
 *
 * The first is structural and checked against the source itself: there is
 * exactly one place in the dashboard and agent code that writes to Meta, and it
 * is only reachable after a staged confirmation has been claimed. A future tool
 * that calls `metaApiClient.postForm` directly would be a bypass of the whole
 * approval mechanism, and no behavioural test would catch it — the new path
 * simply would not be covered.
 *
 * The second is that two tools asking for the same underlying data inside one
 * turn cost one Meta call, not two.
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

const { runAgent } = await import("../../src/claude/agent.js");
const { configureClaudeClientForTests } = await import("../../src/claude/client.js");
const { dashboardCache } = await import("../../src/dashboard/cache.js");
const { clearPendingWrites } = await import("../../src/claude/confirmations.js");

import type { ClaudeClient, ClaudeRequest } from "../../src/claude/client.js";
import type { AdAccountDto } from "../../src/dashboard/dto.js";
import type { ToolExecutionContext } from "../../src/claude/types.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Repo-relative, always with forward slashes so assertions read the same on Windows. */
function sourceFiles(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  return readdirSync(absolute).flatMap((entry) => {
    const full = path.join(absolute, entry);
    if (statSync(full).isDirectory()) return sourceFiles(`${dir}/${entry}`);
    return entry.endsWith(".ts") ? [`${dir}/${entry}`] : [];
  });
}

/** Any Graph call with a method other than GET. */
const WRITE_CALL = /metaApiClient\s*\.\s*(postForm|postMultipart|post|delete)\s*[(<]/g;

describe("only one path writes to Meta", () => {
  const files = [...sourceFiles("src/dashboard"), ...sourceFiles("src/claude")];

  it("finds exactly one write call site across the dashboard and agent code", () => {
    const sites = files.flatMap((file) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      return [...source.matchAll(WRITE_CALL)].map((match) => `${file}:${match[1]}`);
    });

    expect(sites).toEqual(["src/claude/tools.ts:postForm"]);
  });

  it("keeps that call inside applyWritePlan", () => {
    const source = readFileSync(path.join(ROOT, "src/claude/tools.ts"), "utf8");
    const body = source.slice(source.indexOf("export async function applyWritePlan"));
    expect(body).toContain("metaApiClient.postForm");
    // Nothing before applyWritePlan may write.
    const before = source.slice(0, source.indexOf("export async function applyWritePlan"));
    expect(before).not.toContain("metaApiClient.postForm");
  });

  it("lets exactly one module reach applyWritePlan, and only after claiming a confirmation", () => {
    const importers = files.filter(
      (file) =>
        file !== "src/claude/tools.ts" &&
        readFileSync(path.join(ROOT, file), "utf8").includes("applyWritePlan"),
    );
    expect(importers).toEqual(["src/dashboard/ai/service.ts"]);

    const service = readFileSync(path.join(ROOT, "src/dashboard/ai/service.ts"), "utf8");
    const fn = service.slice(service.indexOf("export async function applyDashboardConfirmation"));
    // The claim happens before the write, and the claim is single-use and
    // owner-bound — see confirmations.ts.
    expect(fn.indexOf("takeWrite(")).toBeGreaterThan(-1);
    expect(fn.indexOf("takeWrite(")).toBeLessThan(fn.indexOf("applyWritePlan("));
  });

  it("gives the write tools no way to execute their own plan", () => {
    const tools = readFileSync(path.join(ROOT, "src/claude/tools.ts"), "utf8");
    // Each write tool exposes `plan`, never an `apply`/`execute` of its own.
    const planCount = (tools.match(/^\s+async plan\(/gm) ?? []).length;
    expect(planCount).toBe(6);
    expect(tools).not.toMatch(/^\s+async (apply|execute)\(/m);
  });

  it("never sends a Meta write while the agent is merely answering", async () => {
    // Belt and braces alongside the structural checks above: a full read turn
    // must leave postForm untouched.
    configureClaudeClientForTests(
      scriptedClient([
        {
          content: [
            { type: "tool_use", id: "tu_1", name: "meta_get_campaigns", input: { preset: "last_7d" } },
          ] as unknown as Anthropic.ContentBlock[],
          stop_reason: "tool_use",
        },
        {
          content: [{ type: "text", text: "Özet.", citations: null }] as unknown as Anthropic.ContentBlock[],
          stop_reason: "end_turn",
        },
      ]),
    );

    await runAgent(TOOLS, { question: "Kampanyalar?", history: [], allowWrites: true });
    expect(metaPostFormMock).not.toHaveBeenCalled();
  });
});

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

function scriptedClient(script: Array<Pick<Anthropic.Message, "content" | "stop_reason">>): ClaudeClient {
  let index = 0;
  return {
    model: "claude-test",
    async createMessage(_request: ClaudeRequest) {
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

beforeEach(() => {
  dashboardCache.clear();
  clearPendingWrites();

  metaGetMock.mockImplementation((path: string, params: Record<string, unknown>) =>
    path.endsWith("/insights")
      ? Promise.resolve(
          params.time_increment
            ? { data: [] }
            : { data: [{ date_start: "2026-09-12", date_stop: "2026-09-18", spend: "1000", impressions: "50000", clicks: "1500" }] },
        )
      : Promise.resolve({ id: "100", name: "Kış", account_id: "111", status: "ACTIVE", effective_status: "ACTIVE" }),
  );
  metaGetPaginatedMock.mockResolvedValue([]);
  metaPostFormMock.mockResolvedValue({ success: true });
});

afterEach(() => {
  configureClaudeClientForTests(undefined);
  vi.clearAllMocks();
});

/**
 * The deploy wiring, checked against the workflow itself.
 *
 * A key that is not mounted is indistinguishable from a key that is wrong: the
 * dashboard shows "Claude AI yapılandırılmamış" either way, and no test that
 * runs in CI would notice. These assertions are what make removing the mapping
 * a failing build rather than a silent regression in production.
 */
describe("the Cloud Run deploy carries the AI configuration", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8");

  /** Pull a block scalar out the way the action's parser reads it. */
  function blockLines(marker: string): string[] {
    const lines = workflow.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === marker);
    expect(start).toBeGreaterThan(-1);
    const indent = lines[start].search(/\S/) + 2;
    const out: string[] = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "" || line.search(/\S/) < indent) break;
      out.push(line.trim());
    }
    return out;
  }

  it("mounts the API key from Secret Manager, never as a plain env var", () => {
    expect(blockLines("secrets: |")).toContain("ANTHROPIC_API_KEY=anthropic-api-key:latest");
    // A key pasted into env_vars would be readable in the service description.
    expect(blockLines("env_vars: |").some((line) => line.startsWith("ANTHROPIC_API_KEY="))).toBe(
      false,
    );
  });

  it("passes the optional model and write switch as env vars", () => {
    const env = blockLines("env_vars: |");
    expect(env.some((line) => line.startsWith("ANTHROPIC_MODEL="))).toBe(true);
    expect(env.some((line) => line.startsWith("DASHBOARD_AI_WRITES="))).toBe(true);
  });

  it("keeps both block scalars parseable as KEY=VALUE, with no comments inside", () => {
    for (const marker of ["env_vars: |", "secrets: |"]) {
      for (const line of blockLines(marker)) {
        expect(line).toMatch(/^[A-Z_]+=/);
      }
    }
  });

  it("provisions the secret so a deploy without a key still starts", () => {
    expect(workflow).toContain("Sync ANTHROPIC_API_KEY to Secret Manager");
    // The placeholder is what keeps the secrets mapping resolvable before a
    // real key exists; without it the whole deploy would fail.
    expect(workflow).toContain("ANTHROPIC_API_KEY:- ");
    expect(workflow).toContain("roles/secretmanager.secretAccessor");
  });

  it("smoke-tests that the dashboard and AI routes actually deployed", () => {
    expect(workflow).toContain("/api/dashboard/ai/status");
    expect(workflow).toContain("Dashboard shell check passed");
  });

  it("leaves a whole Claude turn inside the Cloud Run request timeout", async () => {
    const { MAX_TURN_MS } = await import("../../src/claude/agent.js");
    const timeout = /--timeout=(\d+)/.exec(workflow);
    expect(timeout).not.toBeNull();
    const cloudRunMs = Number(timeout![1]) * 1000;
    expect(MAX_TURN_MS).toBeLessThan(cloudRunMs);
  });
});

describe("two tools wanting the same data cost one Meta read", () => {
  /** Insight reads against the campaign, whatever their parameters. */
  function insightReads(): unknown[] {
    return metaGetMock.mock.calls.filter(([callPath]) =>
      String(callPath).endsWith("/100/insights"),
    );
  }

  function twoToolTurn(
    first: { name: string; input: unknown },
    second: { name: string; input: unknown },
  ): ReturnType<typeof scriptedClient> {
    return scriptedClient([
      {
        content: [first, second].map((use, index) => ({
          type: "tool_use",
          id: `tu_${index}`,
          name: use.name,
          input: use.input,
        })) as unknown as Anthropic.ContentBlock[],
        stop_reason: "tool_use",
      },
      {
        content: [{ type: "text", text: "Özet.", citations: null }] as unknown as Anthropic.ContentBlock[],
        stop_reason: "end_turn",
      },
    ]);
  }

  it("serves a comparison and a detail of the same campaign from one read", async () => {
    // Different tools with different arguments, so the turn-level dedup does
    // not apply — but both resolve to the same cached insights read, because
    // both want the same entity, period, comparison and no daily series.
    configureClaudeClientForTests(
      twoToolTurn(
        { name: "meta_compare_periods", input: { preset: "last_7d", level: "campaign", entityId: "100" } },
        { name: "meta_get_campaign_detail", input: { preset: "last_7d", campaignId: "100" } },
      ),
    );

    const result = await runAgent(TOOLS, {
      question: "Kış kampanyası nasıl, ne değişti?",
      history: [],
      allowWrites: false,
    });

    expect(result.toolTrace.filter((entry) => entry.status === "ok")).toHaveLength(2);
    // The summary and the previous period: two calls for the pair, not four.
    expect(insightReads()).toHaveLength(2);
  });

  it("does not reuse a cached read across a different period", async () => {
    configureClaudeClientForTests(
      twoToolTurn(
        { name: "meta_get_campaign_detail", input: { preset: "last_7d", campaignId: "100" } },
        { name: "meta_get_campaign_detail", input: { preset: "last_30d", campaignId: "100" } },
      ),
    );

    await runAgent(TOOLS, { question: "Karşılaştır", history: [], allowWrites: false });

    // Two periods, two cache entries, two calls each.
    expect(insightReads()).toHaveLength(4);
  });

  /**
   * The accepted cost of skipping the daily series on the tools that discard
   * it: a chart-bearing read and a chart-less one are separate cache entries,
   * so asking for both on the same campaign costs five calls rather than three.
   *
   * It is worth it because the chart-less tools are normally used alone — the
   * routing in the system prompt sends one question to one tool — and there
   * they drop from three calls to two. This test exists so the trade-off is a
   * deliberate, visible number rather than a surprise.
   */
  it("pays for a series-bearing and a series-less read of the same campaign separately", async () => {
    configureClaudeClientForTests(
      twoToolTurn(
        { name: "meta_get_campaign_detail", input: { preset: "last_7d", campaignId: "100" } },
        {
          name: "meta_get_insights",
          input: { preset: "last_7d", level: "campaign", entityId: "100", compare: true },
        },
      ),
    );

    await runAgent(TOOLS, { question: "Detay ve grafik", history: [], allowWrites: false });

    // Detail: summary + previous. Insights: summary + series + previous.
    expect(insightReads()).toHaveLength(5);
  });
});
