import type { Comparison, Metrics } from "../api/types";
import { formatCount, formatMoney, formatPercent, formatRatio } from "../lib/format";
import { DeltaBadge } from "./DeltaBadge";
import { Card } from "./states";

interface KpiGridProps {
  metrics: Metrics;
  currency: string;
  comparison?: Comparison | null;
}

type MetricKey = keyof Metrics;

/**
 * ROAS is rendered only when it is actually derivable, per the rule that it
 * appears "when purchase value is available" — a hardcoded 0,00x would read as
 * a real result rather than a missing signal.
 */
export function KpiGrid({ metrics, currency, comparison }: KpiGridProps) {
  const lowerIsBetter = new Set(comparison?.lowerIsBetter ?? []);

  const tiles: Array<{ key: MetricKey; label: string; value: string; hint?: string }> = [
    { key: "spend", label: "Harcama", value: formatMoney(metrics.spend, currency) },
    { key: "impressions", label: "Gösterim", value: formatCount(metrics.impressions) },
    { key: "reach", label: "Erişim", value: formatCount(metrics.reach) },
    { key: "clicks", label: "Tıklama", value: formatCount(metrics.clicks) },
    { key: "ctr", label: "CTR", value: formatPercent(metrics.ctr) },
    { key: "cpc", label: "CPC", value: formatMoney(metrics.cpc, currency) },
    { key: "cpm", label: "CPM", value: formatMoney(metrics.cpm, currency) },
    { key: "purchases", label: "Satın Alma", value: formatCount(metrics.purchases) },
    { key: "addToCart", label: "Sepete Ekleme", value: formatCount(metrics.addToCart) },
    {
      key: "costPerPurchase",
      label: "Satın Alma Başına Maliyet",
      value: formatMoney(metrics.costPerPurchase, currency),
    },
  ];

  if (metrics.roas !== null) {
    tiles.push({
      key: "roas",
      label: "ROAS",
      value: formatRatio(metrics.roas),
      hint:
        metrics.purchaseValue !== null
          ? `Gelir: ${formatMoney(metrics.purchaseValue, currency)}`
          : undefined,
    });
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.key} className="p-4">
          <p className="truncate text-xs font-medium tracking-wide text-ink-400 uppercase">
            {tile.label}
          </p>
          <div className="mt-2 flex flex-wrap items-baseline gap-2">
            <p className="text-xl font-semibold text-ink-100 tabular-nums">{tile.value}</p>
            <DeltaBadge
              delta={comparison?.changes[tile.key]}
              lowerIsBetter={lowerIsBetter.has(tile.key)}
            />
          </div>
          {tile.hint ? <p className="mt-1 truncate text-xs text-ink-500">{tile.hint}</p> : null}
        </Card>
      ))}
    </div>
  );
}
