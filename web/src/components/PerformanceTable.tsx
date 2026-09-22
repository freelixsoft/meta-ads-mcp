import { useMemo, useState } from "react";
import type { EntityLevel, EntityRow, Metrics } from "../api/types";
import {
  CAMPAIGN_STATUS_FILTERS,
  campaignStatusLabel,
  type CampaignStatusFilter,
} from "../lib/labels";
import { formatCount, formatMoney, formatPercent, formatRatio } from "../lib/format";
import { foldForSearch } from "../lib/search";
import { Card, EmptyState } from "./states";

type MetricKey = keyof Metrics;
type SortKey = "name" | MetricKey;

interface Column {
  key: SortKey;
  label: string;
  numeric: boolean;
}

const METRIC_COLUMNS: Column[] = [
  { key: "spend", label: "Harcama", numeric: true },
  { key: "impressions", label: "Gösterim", numeric: true },
  { key: "reach", label: "Erişim", numeric: true },
  { key: "clicks", label: "Tıklama", numeric: true },
  { key: "ctr", label: "CTR", numeric: true },
  { key: "cpc", label: "CPC", numeric: true },
  { key: "cpm", label: "CPM", numeric: true },
  { key: "purchases", label: "Satın Alma", numeric: true },
  { key: "addToCart", label: "Sepete Ekleme", numeric: true },
  { key: "costPerPurchase", label: "CPA", numeric: true },
  { key: "roas", label: "ROAS", numeric: true },
];

const NAME_LABEL: Record<Exclude<EntityLevel, "account">, string> = {
  campaign: "Kampanya",
  adset: "Reklam Seti",
  ad: "Reklam",
};

/** Parent columns shown before the metrics, by level. */
const CONTEXT_COLUMNS: Record<Exclude<EntityLevel, "account">, Array<{ key: string; label: string }>> =
  {
    campaign: [],
    adset: [{ key: "campaignName", label: "Kampanya" }],
    ad: [
      { key: "adSetName", label: "Reklam Seti" },
      { key: "campaignName", label: "Kampanya" },
      { key: "creativeId", label: "Creative ID" },
    ],
  };

function statusTone(status: string): string {
  if (status === "ACTIVE") return "border-positive-400/30 bg-positive-400/10 text-positive-400";
  if (status === "PAUSED") return "border-warn-400/30 bg-warn-400/10 text-warn-400";
  if (status === "DELETED") return "border-danger-400/30 bg-danger-400/10 text-danger-400";
  return "border-ink-700 bg-ink-800 text-ink-400";
}

/** Nulls always sort last, in both directions, so "no data" never tops the table. */
function compare(a: EntityRow, b: EntityRow, key: SortKey, direction: 1 | -1): number {
  if (key === "name") return a.name.localeCompare(b.name, "tr") * direction;
  const left = a.metrics[key];
  const right = b.metrics[key];
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return (left - right) * direction;
}

function metricCell(metrics: Metrics, key: MetricKey, currency: string): string {
  switch (key) {
    case "spend":
    case "cpc":
    case "cpm":
    case "costPerPurchase":
    case "purchaseValue":
      return formatMoney(metrics[key], currency);
    case "ctr":
      return formatPercent(metrics.ctr);
    case "roas":
      return formatRatio(metrics.roas);
    default:
      return formatCount(metrics[key]);
  }
}

export interface PerformanceTableProps {
  title: string;
  level: Exclude<EntityLevel, "account">;
  rows: EntityRow[];
  currency: string;
  /** Provided when this level drills into a child level. */
  onDrillDown?: (row: EntityRow) => void;
  onOpenDetail: (row: EntityRow) => void;
  emptyTitle: string;
  emptyDescription: string;
}

export function PerformanceTable({
  title,
  level,
  rows,
  currency,
  onDrillDown,
  onOpenDetail,
  emptyTitle,
  emptyDescription,
}: PerformanceTableProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<CampaignStatusFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [direction, setDirection] = useState<1 | -1>(-1);

  const contextColumns = CONTEXT_COLUMNS[level];
  const columns: Column[] = useMemo(
    () => [{ key: "name" as const, label: NAME_LABEL[level], numeric: false }, ...METRIC_COLUMNS],
    [level],
  );

  const visible = useMemo(() => {
    const raw = search.trim();
    const needle = raw ? foldForSearch(raw) : "";
    return rows
      .filter((row) => {
        if (status !== "ALL" && row.status !== status) return false;
        if (needle && !foldForSearch(row.name).includes(needle)) return false;
        return true;
      })
      .sort((a, b) => compare(a, b, sortKey, direction));
  }, [rows, search, status, sortKey, direction]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setDirection((current) => (current === 1 ? -1 : 1));
      return;
    }
    setSortKey(key);
    setDirection(key === "name" ? 1 : -1);
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-700 p-4">
        <h2 className="mr-auto text-sm font-semibold text-ink-100">{title}</h2>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Ara"
          aria-label={`${title} içinde ara`}
          className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 outline-none placeholder:text-ink-500 focus:border-brand-500 sm:w-56"
        />
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as CampaignStatusFilter)}
          aria-label="Durum filtresi"
          className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 outline-none focus:border-brand-500"
        >
          {CAMPAIGN_STATUS_FILTERS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : visible.length === 0 ? (
        <EmptyState
          title="Sonuç yok"
          description="Arama ve durum filtresiyle eşleşen kayıt bulunamadı."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[68rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-ink-700 text-left">
                {columns.map((column) => {
                  const isSorted = column.key === sortKey;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={isSorted ? (direction === 1 ? "ascending" : "descending") : "none"}
                      className={`px-3 py-2.5 font-medium whitespace-nowrap text-ink-400 ${
                        column.numeric ? "text-right" : "text-left"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={`inline-flex items-center gap-1 transition hover:text-ink-100 ${
                          isSorted ? "text-ink-100" : ""
                        }`}
                      >
                        {column.label}
                        <span aria-hidden="true" className="text-[0.65rem]">
                          {isSorted ? (direction === 1 ? "▲" : "▼") : ""}
                        </span>
                      </button>
                    </th>
                  );
                })}
                {contextColumns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className="px-3 py-2.5 text-left font-medium whitespace-nowrap text-ink-400"
                  >
                    {column.label}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2.5 text-right font-medium text-ink-400">
                  <span className="sr-only">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id} className="border-b border-ink-800 last:border-0 hover:bg-ink-800/40">
                  <td className="px-3 py-2.5 whitespace-nowrap text-ink-100">
                    <div className="flex max-w-[24rem] flex-col gap-1">
                      {onDrillDown ? (
                        <button
                          type="button"
                          onClick={() => onDrillDown(row)}
                          title={`${row.name} — alt kırılımı aç`}
                          className="truncate text-left font-medium text-ink-100 transition hover:text-brand-400 hover:underline"
                        >
                          {row.name}
                        </button>
                      ) : (
                        <span className="truncate font-medium" title={row.name}>
                          {row.name}
                        </span>
                      )}
                      <span className="flex items-center gap-2">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[0.7rem] ${statusTone(row.status)}`}
                        >
                          {campaignStatusLabel(row.status)}
                        </span>
                        {row.effectiveStatus && row.effectiveStatus !== row.status ? (
                          <span className="text-[0.7rem] text-ink-500">
                            {campaignStatusLabel(row.effectiveStatus)}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </td>

                  {METRIC_COLUMNS.map((column) => (
                    <td
                      key={column.key}
                      className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums text-ink-100"
                    >
                      {metricCell(row.metrics, column.key as MetricKey, currency)}
                    </td>
                  ))}

                  {contextColumns.map((column) => {
                    const value = row[column.key as keyof EntityRow];
                    return (
                      <td
                        key={column.key}
                        className="max-w-[14rem] truncate px-3 py-2.5 whitespace-nowrap text-ink-400"
                        title={typeof value === "string" ? value : undefined}
                      >
                        {typeof value === "string" && value.length > 0 ? value : "—"}
                      </td>
                    );
                  })}

                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onOpenDetail(row)}
                      className="rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs text-ink-300 transition hover:border-ink-500 hover:text-ink-100"
                    >
                      Detay
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
