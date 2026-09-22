import { useEffect, useRef } from "react";
import type { EntityInsightsResponse, EntityLevel, Metrics } from "../api/types";
import { formatCount, formatMoney, formatPercent, formatRatio } from "../lib/format";
import { campaignStatusLabel } from "../lib/labels";
import { DeltaBadge } from "./DeltaBadge";
import { PerformanceChart } from "./PerformanceChart";
import { ErrorState, Skeleton } from "./states";

const LEVEL_LABEL: Record<EntityLevel, string> = {
  account: "Reklam Hesabı",
  campaign: "Kampanya",
  adset: "Reklam Seti",
  ad: "Reklam",
};

type MetricKey = keyof Metrics;

const ROWS: Array<{ key: MetricKey; label: string; kind: "money" | "count" | "percent" | "ratio" }> = [
  { key: "spend", label: "Harcama", kind: "money" },
  { key: "impressions", label: "Gösterim", kind: "count" },
  { key: "reach", label: "Erişim", kind: "count" },
  { key: "clicks", label: "Tıklama", kind: "count" },
  { key: "ctr", label: "CTR", kind: "percent" },
  { key: "cpc", label: "CPC", kind: "money" },
  { key: "cpm", label: "CPM", kind: "money" },
  { key: "purchases", label: "Satın Alma", kind: "count" },
  { key: "addToCart", label: "Sepete Ekleme", kind: "count" },
  { key: "costPerPurchase", label: "Satın Alma Başına Maliyet", kind: "money" },
  { key: "purchaseValue", label: "Gelir", kind: "money" },
  { key: "roas", label: "ROAS", kind: "ratio" },
];

function formatValue(
  metrics: Metrics,
  key: MetricKey,
  kind: "money" | "count" | "percent" | "ratio",
  currency: string,
): string {
  if (kind === "money") return formatMoney(metrics[key], currency);
  if (kind === "percent") return formatPercent(metrics[key]);
  if (kind === "ratio") return formatRatio(metrics[key]);
  return formatCount(metrics[key]);
}

interface DetailDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  data: EntityInsightsResponse | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  /** Hands this entity to the Claude view with a question already written. */
  onAskClaude?: () => void;
}

export function DetailDrawer({
  open,
  onClose,
  title,
  data,
  isPending,
  isError,
  error,
  onRetry,
  onAskClaude,
}: DetailDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and focus moves into the panel so keyboard users are not
  // left behind on the table underneath.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const currency = data?.account.currency ?? "TRY";
  const comparison = data?.comparison ?? null;
  const lowerIsBetter = new Set(comparison?.lowerIsBetter ?? []);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Detayı kapat"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />

      <aside className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-ink-700 bg-ink-900 shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-ink-700 bg-ink-900/95 p-4 backdrop-blur">
          <div className="min-w-0 flex-1">
            <p className="text-xs tracking-wide text-ink-500 uppercase">
              {data ? LEVEL_LABEL[data.entity.level] : "Detay"}
            </p>
            <h2 className="truncate text-base font-semibold text-ink-100" title={title}>
              {title}
            </h2>
          </div>
          {onAskClaude ? (
            <button
              type="button"
              onClick={onAskClaude}
              className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-500"
            >
              Claude'a sor
            </button>
          ) : null}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-sm text-ink-300 transition hover:border-ink-500 hover:text-ink-100"
          >
            Kapat
          </button>
        </header>

        <div className="flex-1 space-y-4 p-4">
          {isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-56 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : isError || !data ? (
            <ErrorState error={error} onRetry={onRetry} />
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-3 rounded-xl border border-ink-700 bg-ink-850 p-4 text-sm">
                <Meta label="Durum" value={data.entity.status ? campaignStatusLabel(data.entity.status) : null} />
                <Meta
                  label="Etkin durum"
                  value={data.entity.effectiveStatus ? campaignStatusLabel(data.entity.effectiveStatus) : null}
                />
                {data.entity.objective ? <Meta label="Hedef" value={data.entity.objective} /> : null}
                {data.entity.campaignName ? (
                  <Meta label="Kampanya" value={data.entity.campaignName} />
                ) : null}
                {data.entity.adSetName ? <Meta label="Reklam Seti" value={data.entity.adSetName} /> : null}
                {data.entity.creativeId ? (
                  <Meta label="Creative ID" value={data.entity.creativeId} />
                ) : null}
                {data.entity.dailyBudget !== null ? (
                  <Meta label="Günlük bütçe" value={formatMoney(data.entity.dailyBudget, currency)} />
                ) : null}
                {data.entity.lifetimeBudget !== null ? (
                  <Meta label="Toplam bütçe" value={formatMoney(data.entity.lifetimeBudget, currency)} />
                ) : null}
                <Meta label="Kimlik" value={data.entity.id} />
              </dl>

              <div className="rounded-xl border border-ink-700 bg-ink-850">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-700 px-4 py-3">
                  <h3 className="text-sm font-semibold text-ink-100">Dönem karşılaştırması</h3>
                  <p className="text-xs text-ink-500">
                    {data.resolvedRange
                      ? `${data.resolvedRange.since} – ${data.resolvedRange.until}`
                      : ""}
                    {comparison ? ` · önceki: ${comparison.range.since} – ${comparison.range.until}` : ""}
                  </p>
                </div>

                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-800 text-xs text-ink-500">
                      <th scope="col" className="px-4 py-2 text-left font-medium">
                        Metrik
                      </th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">
                        Bu dönem
                      </th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">
                        Önceki dönem
                      </th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">
                        Değişim
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map((row) => {
                      const change = comparison?.changes[row.key];
                      return (
                        <tr key={row.key} className="border-b border-ink-800 last:border-0">
                          <td className="px-4 py-2 text-ink-300">{row.label}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-ink-100">
                            {formatValue(data.summary, row.key, row.kind, currency)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-ink-400">
                            {comparison
                              ? formatValue(comparison.previous, row.key, row.kind, currency)
                              : "—"}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {change && change.absolute !== null ? (
                              <span className="inline-flex items-center gap-2">
                                <span className="tabular-nums text-ink-400">
                                  {row.kind === "money"
                                    ? formatMoney(change.absolute, currency)
                                    : row.kind === "percent"
                                      ? formatPercent(change.absolute)
                                      : row.kind === "ratio"
                                        ? formatRatio(change.absolute)
                                        : formatCount(change.absolute)}
                                </span>
                                <DeltaBadge
                                  delta={change}
                                  lowerIsBetter={lowerIsBetter.has(row.key)}
                                />
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <PerformanceChart series={data.series} currency={currency} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="truncate text-ink-100" title={value ?? undefined}>
        {value ?? "—"}
      </dd>
    </div>
  );
}
