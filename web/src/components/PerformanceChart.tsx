import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SeriesPoint } from "../api/types";
import { formatCount, formatDayLabel, formatMoney } from "../lib/format";
import { Card, EmptyState } from "./states";

type MetricKey = "spend" | "purchases" | "purchaseValue";

const ALL_METRICS: Array<{ key: MetricKey; label: string; money: boolean }> = [
  { key: "spend", label: "Harcama", money: true },
  { key: "purchases", label: "Satın Alma", money: false },
  { key: "purchaseValue", label: "Gelir", money: true },
];

interface PerformanceChartProps {
  series: SeriesPoint[];
  currency: string;
}

export function PerformanceChart({ series, currency }: PerformanceChartProps) {
  const [metric, setMetric] = useState<MetricKey>("spend");

  // Revenue is only offered when Meta actually returned purchase values for
  // this range; a flat zero line would read as "no revenue" rather than
  // "not tracked".
  const hasRevenue = series.some((point) => point.purchaseValue !== null && point.purchaseValue > 0);
  const metrics = hasRevenue ? ALL_METRICS : ALL_METRICS.filter((item) => item.key !== "purchaseValue");
  const active = metrics.find((item) => item.key === metric) ?? metrics[0];

  const formatValue = (value: number): string =>
    active.money ? formatMoney(value, currency) : formatCount(value);

  return (
    <Card className="p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Zaman İçinde Performans</h2>
          <p className="text-xs text-ink-500">Günlük kırılım</p>
        </div>
        <div
          className="flex rounded-lg border border-ink-700 bg-ink-900 p-0.5"
          role="group"
          aria-label="Grafik metriği"
        >
          {metrics.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={active.key === item.key}
              onClick={() => setMetric(item.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                active.key === item.key
                  ? "bg-ink-750 text-ink-100"
                  : "text-ink-400 hover:text-ink-100"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {series.length === 0 ? (
        <EmptyState
          title="Grafik için veri yok"
          description="Seçili tarih aralığında bu hesapta gösterim kaydedilmemiş."
        />
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="metricFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#2c2d35" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDayLabel}
                stroke="#6d6f7a"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis
                stroke="#6d6f7a"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={(value: number) =>
                  active.money ? formatMoney(value, currency, 0) : formatCount(value)
                }
              />
              <Tooltip
                contentStyle={{
                  background: "#16171b",
                  border: "1px solid #2c2d35",
                  borderRadius: "0.5rem",
                  fontSize: "0.8rem",
                }}
                labelStyle={{ color: "#a8aab4" }}
                labelFormatter={(label: unknown) =>
                  typeof label === "string" ? formatDayLabel(label) : ""
                }
                formatter={(value: unknown) => [
                  formatValue(typeof value === "number" ? value : Number(value ?? 0)),
                  active.label,
                ]}
              />
              <Area
                type="monotone"
                dataKey={active.key}
                stroke="#60a5fa"
                strokeWidth={2}
                fill="url(#metricFill)"
                dot={series.length === 1}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
