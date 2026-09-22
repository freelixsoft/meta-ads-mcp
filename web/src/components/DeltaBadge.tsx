import type { MetricDelta } from "../api/types";
import { formatPercent } from "../lib/format";

/**
 * Change versus the previous equivalent period.
 *
 * Direction and goodness are separate: spend rising is green for revenue and
 * red for cost, so the API tells us which metrics are costs and the colour is
 * chosen from that, not from the sign alone. A metric with no comparable
 * previous value renders nothing rather than a misleading "0%".
 */
export function DeltaBadge({
  delta,
  lowerIsBetter = false,
  className = "",
}: {
  delta: MetricDelta | undefined;
  lowerIsBetter?: boolean;
  className?: string;
}) {
  if (!delta || delta.percent === null) return null;

  const rising = delta.percent > 0;
  const flat = delta.percent === 0;
  const good = lowerIsBetter ? !rising : rising;

  const tone = flat
    ? "text-ink-400"
    : good
      ? "text-positive-400"
      : "text-danger-400";

  const arrow = flat ? "=" : rising ? "↑" : "↓";

  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium tabular-nums ${tone} ${className}`}>
      <span aria-hidden="true">{arrow}</span>
      {formatPercent(Math.abs(delta.percent))}
    </span>
  );
}
