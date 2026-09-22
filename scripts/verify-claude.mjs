#!/usr/bin/env node
/**
 * Live check of the dashboard's Anthropic integration.
 *
 * This is the one place in the repository that makes a real API call, and it
 * only ever runs when a human runs it: `npm run claude:verify`. It is not part
 * of `npm test`, and with no `ANTHROPIC_API_KEY` it exits before building a
 * request rather than pretending to have made one.
 *
 * What it proves, in order:
 *
 *   1. The key is accepted and the configured model is reachable.
 *   2. The real system prompt and the real tool schemas are accepted by the
 *      API — a malformed schema fails here rather than in front of a user.
 *   3. The model actually reaches for a tool when asked an account question.
 *   4. Feeding a tool result back produces a Turkish answer that uses the
 *      numbers it was given.
 *   5. Prompt caching is working (second call reads the cached prefix).
 *
 * What it deliberately does NOT do: touch Meta. A CLI has no signed-in user and
 * therefore no Meta token, so step 4 feeds a clearly-labelled STUB tool result.
 * Every Claude response here is real; only the ad numbers are synthetic, and
 * the script says so wherever it prints them.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");

const ok = (message) => console.log(`  [32m✓[0m ${message}`);
const bad = (message) => console.log(`  [31m✗[0m ${message}`);
const info = (message) => console.log(`    ${message}`);

function fail(message, hint) {
  console.error(`\n[31m${message}[0m`);
  if (hint) console.error(hint);
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  fail(
    "ANTHROPIC_API_KEY is not set — nothing was sent.",
    [
      "",
      "Set it and run again:",
      "  ANTHROPIC_API_KEY=sk-ant-... npm run claude:verify",
      "",
      "On Windows PowerShell:",
      '  $env:ANTHROPIC_API_KEY = "sk-ant-..."; npm run claude:verify',
      "",
      "The dashboard reads the same variable. Without it the UI shows",
      '"Claude AI yapılandırılmamış" and no request is ever made.',
    ].join("\n"),
  );
}

if (!existsSync(path.join(DIST, "claude", "client.js"))) {
  fail("dist/ is missing or stale.", "Run `npm run build` first, then re-run this script.");
}

const load = (relative) => import(pathToFileURL(path.join(DIST, relative)).href);

const { getClaudeClient, resolveClaudeModel, isClaudeConfigured } = await load("claude/client.js");
const { buildSystemPrompt } = await load("claude/prompt.js");
const { buildToolDefinitions } = await load("claude/tools.js");

/** A stand-in for the signed-in user's ad account. No Meta call is made. */
const ACCOUNT = {
  id: "act_0",
  accountId: "0",
  name: "Doğrulama Hesabı",
  status: "ACTIVE",
  statusCode: 1,
  currency: "TRY",
  timezone: "Europe/Istanbul",
  businessName: null,
};

const model = resolveClaudeModel();
console.log("\nClaude live verification");
console.log(`  model: ${model}`);
console.log(`  key:   present (never printed)\n`);

if (!isClaudeConfigured()) fail("The client does not consider itself configured.");

const client = getClaudeClient();
const system = buildSystemPrompt(ACCOUNT, new Date().toISOString().slice(0, 10));
const tools = buildToolDefinitions({ allowWrites: false });

info(`system prompt: ${system.length} chars · read tools: ${tools.length}`);

// ── 1 & 2 & 3: a real call, with the real prompt and the real schemas ────────
let first;
try {
  first = await client.createMessage({
    system,
    tools,
    messages: [{ role: "user", content: "Son 7 günde hangi reklam para kaybettiriyor?" }],
    maxTokens: 4000,
  });
} catch (error) {
  bad("the API call failed");
  info(`code: ${error?.code ?? "unknown"} — ${error?.message ?? error}`);
  if (error?.code === "not_configured") info("The key was rejected. Check it in the Anthropic console.");
  if (error?.code === "invalid_request") {
    info(`The request was rejected. Most likely this key has no access to "${model}";`);
    info("set ANTHROPIC_MODEL to a model you do have, e.g. claude-sonnet-5.");
  }
  process.exit(1);
}

ok(`key accepted and ${first.model} answered`);
info(`stop_reason: ${first.stop_reason}`);
info(
  `tokens: in ${first.usage.input_tokens}, out ${first.usage.output_tokens}, ` +
    `cache write ${first.usage.cache_creation_input_tokens ?? 0}`,
);

const toolUses = first.content.filter((block) => block.type === "tool_use");
if (toolUses.length === 0) {
  bad("the model answered without calling a tool");
  info("It should have reached for meta_get_ads. Check the system prompt and tool descriptions.");
  const text = first.content.find((block) => block.type === "text")?.text ?? "";
  info(`it said: ${text.slice(0, 200)}`);
  process.exit(1);
}
ok(`the model reached for a tool: ${toolUses.map((use) => use.name).join(", ")}`);
info(`arguments: ${JSON.stringify(toolUses[0].input)}`);

// ── 4 & 5: feed a STUB tool result back and read the answer ──────────────────
//
// These numbers are invented by this script, not by Meta and not by Claude.
// They exist so the round trip can be exercised without a signed-in user.
const STUB_RESULT = {
  NOTE: "SYNTHETIC DATA — generated by scripts/verify-claude.mjs, not from Meta.",
  parent: { level: "account", id: null, name: ACCOUNT.name },
  currency: "TRY",
  period: { preset: "last_7d", since: "2026-09-12", until: "2026-09-18" },
  rows: [
    {
      id: "1",
      name: "Video 15sn",
      status: "ACTIVE",
      campaignName: "Kış",
      adSetName: "TR 25-45",
      metrics: { spend: 700, impressions: 35000, reach: 20000, clicks: 1100, ctr: 3.14, cpc: 0.636, cpm: 20, purchases: 0, addToCart: 4, purchaseValue: null, costPerPurchase: null, roas: null },
    },
    {
      id: "2",
      name: "Statik Kış",
      status: "ACTIVE",
      campaignName: "Kış",
      adSetName: "TR 25-45",
      metrics: { spend: 300, impressions: 20000, reach: 14000, clicks: 500, ctr: 2.5, cpc: 0.6, cpm: 15, purchases: 12, addToCart: 40, purchaseValue: null, costPerPurchase: 25, roas: null },
    },
  ],
  totalRows: 2,
  truncated: false,
  dataQuality: { rowsWithNoDelivery: 0, metricsMissingOnEveryRow: ["purchaseValue", "roas"] },
};

let second;
try {
  second = await client.createMessage({
    system,
    tools,
    messages: [
      { role: "user", content: "Son 7 günde hangi reklam para kaybettiriyor?" },
      { role: "assistant", content: first.content },
      {
        role: "user",
        content: toolUses.map((use, index) => ({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(index === 0 ? STUB_RESULT : { rows: [], totalRows: 0 }),
        })),
      },
    ],
    maxTokens: 4000,
  });
} catch (error) {
  bad("the follow-up call failed");
  info(`${error?.code ?? "unknown"} — ${error?.message ?? error}`);
  process.exit(1);
}

const answer = second.content
  .filter((block) => block.type === "text")
  .map((block) => block.text)
  .join("\n")
  .trim();

if (!answer) {
  bad("the model returned no text after the tool result");
  process.exit(1);
}
ok("the tool-result round trip produced an answer");

const cacheRead = second.usage.cache_read_input_tokens ?? 0;
if (cacheRead > 0) {
  ok(`prompt caching is working (${cacheRead} tokens read from cache)`);
} else {
  bad("no cache read on the second call");
  info("The prefix (tools + system) did not match. Check that nothing per-request");
  info("leaked into the system prompt, or the prefix may be under the cache minimum.");
}

// Turkish is a hard requirement of the product, so check it rather than assume.
const turkish = /[çğışöüÇĞİŞÖÜ]/.test(answer) || /\b(harcama|reklam|kampanya|satın|bütçe)\b/i.test(answer);
if (turkish) ok("the answer is in Turkish");
else bad("the answer does not look Turkish — check the ANSWERING section of the prompt");

// The stub says ROAS is unavailable; a correct answer must not invent one.
const inventedRoas = /roas\s*[:=]?\s*\d/i.test(answer);
if (inventedRoas) {
  bad("the answer appears to state a ROAS figure, which the data did not contain");
  info("Re-read the NUMBERS section of the system prompt.");
} else {
  ok("no ROAS figure was invented (the stub had none)");
}

console.log("\n  --- answer (real Claude output, synthetic ad numbers) ---");
console.log(
  answer
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n"),
);

console.log(
  `\n  totals: in ${first.usage.input_tokens + second.usage.input_tokens} tokens, ` +
    `out ${first.usage.output_tokens + second.usage.output_tokens} tokens, ` +
    `cache read ${cacheRead}\n`,
);
console.log("Next: open the dashboard and ask the same question against a real ad account.\n");
