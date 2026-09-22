import type { InsightsResult } from "../meta/types/index.js";

export function buildSingleInsightSummary(row: InsightsResult): string {
  const lines: string[] = [];
  lines.push(`Period: ${row.date_start} → ${row.date_stop}`);
  if (row.impressions) lines.push(`Impressions: ${Number(row.impressions).toLocaleString("en-US")}`);
  if (row.reach) lines.push(`Reach: ${Number(row.reach).toLocaleString("en-US")}`);
  if (row.clicks) lines.push(`Clicks: ${Number(row.clicks).toLocaleString("en-US")}`);
  if (row.spend) lines.push(`Spend: $${Number(row.spend).toFixed(2)}`);
  if (row.ctr) lines.push(`CTR: ${Number(row.ctr).toFixed(2)}%`);
  if (row.cpc) lines.push(`CPC: $${Number(row.cpc).toFixed(2)}`);
  if (row.cpm) lines.push(`CPM: $${Number(row.cpm).toFixed(2)}`);
  if (row.frequency) lines.push(`Frequency: ${Number(row.frequency).toFixed(2)}`);

  if (row.actions && row.actions.length > 0) {
    lines.push("\nActions:");
    for (const action of row.actions.slice(0, 10)) {
      lines.push(`  • ${action.action_type}: ${action.value}`);
    }
  }

  return lines.join("\n");
}
