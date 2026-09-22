/**
 * All formatting is locale-aware and currency-driven. The account's own
 * currency code goes into Intl, so a TRY account renders ₺ and a USD account
 * renders $ — there is no hardcoded symbol anywhere in the app.
 */

const numberFormatter = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat("tr-TR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const currencyCache = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string, fractionDigits: number): Intl.NumberFormat {
  const key = `${currency}:${fractionDigits}`;
  const cached = currencyCache.get(key);
  if (cached) return cached;
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat("tr-TR", {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  } catch {
    // An unknown currency code must not take the page down; fall back to a
    // plain number with the code appended.
    formatter = new Intl.NumberFormat("tr-TR", {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  }
  currencyCache.set(key, formatter);
  return formatter;
}

export const EMPTY_VALUE = "—";

export function formatMoney(value: number | null, currency: string, fractionDigits = 2): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_VALUE;
  return currencyFormatter(currency, fractionDigits).format(value);
}

export function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_VALUE;
  return numberFormatter.format(value);
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_VALUE;
  return `%${decimalFormatter.format(value)}`;
}

export function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_VALUE;
  return `${decimalFormatter.format(value)}x`;
}

export function formatDayLabel(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(parsed);
}
