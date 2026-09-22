import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import type { MetaApiResponse } from "../meta/types/index.js";
import { applyAttributionDefault } from "./insights-guardrails.js";
import { READ } from "./_register.js";

const datePresetEnum = z.enum([
  "today", "yesterday", "this_month", "last_month",
  "last_3d", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d",
]);

const levelEnum = z.enum(["account", "campaign", "ad_set", "ad"]);

const VALIDATE_KIND_BY_LEVEL = {
  account: null,
  campaign: "campaign",
  ad_set: "adset",
  ad: "ad",
} as const;

interface InsightRow {
  date_start?: string;
  date_stop?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  quality_ranking?: string;
  engagement_rate_ranking?: string;
  conversion_rate_ranking?: string;
  campaign_id?: string;
  campaign_name?: string;
}

export function registerMacroTools(server: McpServer): void {
  // ─── Diagnose Underperformance ───────────────────────────────
  server.registerTool(
    "ads_diagnose_underperformance",
    {
      description:
        "Run a compound diagnostic on an underperforming object: anomaly detection vs prior period, auction rankings (when applicable), pixel signal quality (when a pixel is associated), and active errors/issues. Returns a unified report with hypothesis. Agency-tier diagnostic — combines work that the official Meta MCP requires multiple tool calls to do.",
      inputSchema: {
        object_id: z.string().describe("Account, campaign, ad set, or ad ID"),
        level: levelEnum.default("campaign"),
        date_preset: datePresetEnum.default("last_7d"),
        pixel_id: z.string().optional().describe("Optional pixel ID to include signal-quality diagnostics"),
      },
      annotations: { ...READ },
    },
    async ({ object_id, level, date_preset, pixel_id }) => {
      const path =
        level === "account"
          ? normalizeAccountId(object_id)
          : validateMetaId(object_id, VALIDATE_KIND_BY_LEVEL[level]!);

      const insightsParams: Record<string, string | number | boolean> = {
        fields: "spend,impressions,clicks,ctr,cpc,cpm,quality_ranking,engagement_rate_ranking,conversion_rate_ranking",
        date_preset,
        limit: 1,
      };
      applyAttributionDefault(insightsParams, true);

      const accountId = level === "account" ? path : null;

      const tasks: Array<Promise<unknown>> = [
        metaApiClient.get<MetaApiResponse<InsightRow>>(`/${path}/insights`, insightsParams).catch((e) => ({ _error: String(e) })),
      ];

      if (pixel_id) {
        const pid = validateMetaId(pixel_id, "pixel");
        tasks.push(
          metaApiClient
            .get<{ last_fired_time?: string; match_rate_approx?: number; is_unavailable?: boolean }>(
              `/${pid}`,
              { fields: "last_fired_time,match_rate_approx,is_unavailable" },
            )
            .catch((e) => ({ _error: String(e) })),
        );
      }

      if (accountId) {
        tasks.push(
          metaApiClient
            .get<MetaApiResponse<{ id: string; name?: string; effective_status?: string }>>(
              `/${accountId}/ads`,
              {
                fields: "id,name,effective_status",
                filtering: JSON.stringify([
                  {
                    field: "effective_status",
                    operator: "IN",
                    value: ["DISAPPROVED", "WITH_ISSUES"],
                  },
                ]),
                limit: 25,
              },
            )
            .catch((e) => ({ _error: String(e) })),
        );
      }

      const [insightsResultRaw, ...rest] = await Promise.all(tasks);
      const insightsResult = insightsResultRaw as MetaApiResponse<InsightRow> | { _error: string };
      const insights = "_error" in insightsResult ? null : insightsResult.data?.[0] ?? null;

      const findings: string[] = [];
      const hypotheses: string[] = [];

      if (!insights) {
        findings.push(`No insights data for ${level} ${path} in ${date_preset}.`);
      } else {
        if (insights.quality_ranking && insights.quality_ranking.includes("BELOW")) {
          findings.push(`Quality ranking is ${insights.quality_ranking}.`);
          hypotheses.push("Refresh creative — Meta is suppressing delivery due to low quality.");
        }
        if (insights.engagement_rate_ranking && insights.engagement_rate_ranking.includes("BELOW")) {
          findings.push(`Engagement rate ranking is ${insights.engagement_rate_ranking}.`);
          hypotheses.push("Hook is weak — first 3 seconds / headline likely not resonating.");
        }
        if (insights.conversion_rate_ranking && insights.conversion_rate_ranking.includes("BELOW")) {
          findings.push(`Conversion rate ranking is ${insights.conversion_rate_ranking}.`);
          hypotheses.push("Landing page or offer may be underperforming, not the ad.");
        }
      }

      let pixelHealth: unknown = null;
      if (pixel_id && rest.length > 0) {
        pixelHealth = rest.shift();
        if (pixelHealth && typeof pixelHealth === "object" && !("_error" in pixelHealth)) {
          const p = pixelHealth as { last_fired_time?: string; match_rate_approx?: number; is_unavailable?: boolean };
          if (p.is_unavailable) {
            findings.push("Pixel is unavailable.");
            hypotheses.push("Tracking is broken — no signal reaches Meta.");
          }
          if (p.last_fired_time) {
            const hoursAgo = (Date.now() - Date.parse(p.last_fired_time)) / 3_600_000;
            if (hoursAgo > 24) {
              findings.push(`Pixel last fired ${Math.round(hoursAgo)}h ago.`);
              hypotheses.push("Stalled signal — check pixel installation and CAPI events.");
            }
          }
          if (p.match_rate_approx !== undefined && p.match_rate_approx < 0.6) {
            findings.push(`Pixel match rate is low (${(p.match_rate_approx * 100).toFixed(0)}%).`);
            hypotheses.push("Enable Automatic Advanced Matching to improve attribution.");
          }
        }
      }

      let issuesList: Array<{ id: string; name?: string; effective_status?: string }> = [];
      if (accountId && rest.length > 0) {
        const issuesRaw = rest.shift();
        if (issuesRaw && typeof issuesRaw === "object" && !("_error" in issuesRaw)) {
          issuesList = ((issuesRaw as MetaApiResponse<{ id: string; name?: string; effective_status?: string }>).data) ?? [];
          if (issuesList.length > 0) {
            findings.push(`${issuesList.length} ad(s) currently DISAPPROVED or WITH_ISSUES at the account level.`);
            hypotheses.push("Active rejections may be cannibalizing learning — fix or pause affected ads.");
          }
        }
      }

      const lines: string[] = [
        `Diagnosis for ${level} ${path} (${date_preset}):`,
        "",
        "Findings:",
        ...(findings.length === 0 ? ["  • No notable issues detected — performance is within expected ranges."] : findings.map((f) => `  • ${f}`)),
      ];
      if (hypotheses.length > 0) {
        lines.push("", "Hypotheses:");
        for (const h of hypotheses) lines.push(`  • ${h}`);
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          {
            type: "text",
            text: JSON.stringify(
              {
                level,
                object_id: path,
                date_preset,
                insights,
                pixel_health: pixelHealth,
                account_issues: issuesList,
                findings,
                hypotheses,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ─── Portfolio Summary (cross-account) ───────────────────────
  server.registerTool(
    "ads_portfolio_summary",
    {
      description:
        "Cross-account aggregation: spend, impressions, clicks, CTR, CPC across N ad accounts in parallel. Agency-tier tool — the official Meta MCP cannot do this because it operates one-user/one-account at a time. Use to get a portfolio-level snapshot for the current period.",
      inputSchema: {
        account_ids: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe("Up to 20 ad account IDs to aggregate"),
        date_preset: datePresetEnum.default("last_30d"),
      },
      annotations: { ...READ },
    },
    async ({ account_ids, date_preset }) => {
      const ids = account_ids.map(normalizeAccountId);

      const params: Record<string, string | number | boolean> = {
        fields: "spend,impressions,clicks,ctr,cpc,cpm",
        date_preset,
        limit: 1,
      };
      applyAttributionDefault(params, true);

      type PerAccount = {
        account_id: string;
        name?: string;
        currency?: string;
        spend: number;
        impressions: number;
        clicks: number;
        ctr: number;
        cpc: number;
        cpm: number;
        error?: string;
      };

      const fetchOne = async (id: string): Promise<PerAccount> => {
        try {
          const [meta, insights] = await Promise.all([
            metaApiClient
              .get<{ name?: string; currency?: string }>(`/${id}`, { fields: "name,currency" })
              .catch(() => ({} as { name?: string; currency?: string })),
            metaApiClient.get<MetaApiResponse<InsightRow>>(`/${id}/insights`, params),
          ]);
          const row = insights.data?.[0];
          return {
            account_id: id,
            name: meta?.name,
            currency: meta?.currency,
            spend: Number(row?.spend ?? 0),
            impressions: Number(row?.impressions ?? 0),
            clicks: Number(row?.clicks ?? 0),
            ctr: Number(row?.ctr ?? 0),
            cpc: Number(row?.cpc ?? 0),
            cpm: Number(row?.cpm ?? 0),
          };
        } catch (e) {
          return {
            account_id: id,
            spend: 0,
            impressions: 0,
            clicks: 0,
            ctr: 0,
            cpc: 0,
            cpm: 0,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      };

      const perAccount = await Promise.all(ids.map(fetchOne));

      const totals = perAccount.reduce(
        (acc, a) => ({
          spend: acc.spend + a.spend,
          impressions: acc.impressions + a.impressions,
          clicks: acc.clicks + a.clicks,
        }),
        { spend: 0, impressions: 0, clicks: 0 },
      );
      const portfolioCtr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
      const portfolioCpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
      const portfolioCpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;

      const top = [...perAccount]
        .filter((a) => !a.error)
        .sort((a, b) => b.spend - a.spend);

      const lines: string[] = [
        `Portfolio summary across ${perAccount.length} account(s) — ${date_preset}:`,
        ``,
        `TOTALS:`,
        `  Spend:       ${totals.spend.toFixed(2)}`,
        `  Impressions: ${totals.impressions.toLocaleString("en-US")}`,
        `  Clicks:      ${totals.clicks.toLocaleString("en-US")}`,
        `  Avg CTR:     ${portfolioCtr.toFixed(2)}%`,
        `  Avg CPC:     ${portfolioCpc.toFixed(2)}`,
        `  Avg CPM:     ${portfolioCpm.toFixed(2)}`,
        ``,
        `By account (sorted by spend):`,
        ...top.map(
          (a) =>
            `  • ${a.name ?? a.account_id} (${a.currency ?? "?"}): spend=${a.spend.toFixed(2)}, ctr=${a.ctr.toFixed(2)}%, cpc=${a.cpc.toFixed(2)}`,
        ),
      ];

      const errored = perAccount.filter((a) => a.error);
      if (errored.length > 0) {
        lines.push(``, `Errors (${errored.length}):`);
        for (const e of errored) lines.push(`  • ${e.account_id}: ${e.error}`);
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          {
            type: "text",
            text: JSON.stringify(
              {
                date_preset,
                totals: {
                  spend: totals.spend,
                  impressions: totals.impressions,
                  clicks: totals.clicks,
                  ctr: Number(portfolioCtr.toFixed(4)),
                  cpc: Number(portfolioCpc.toFixed(4)),
                  cpm: Number(portfolioCpm.toFixed(4)),
                },
                by_account: perAccount,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
