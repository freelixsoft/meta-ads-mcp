import type { DatePresetKey } from "./schemas.js";

/**
 * Calendar-date arithmetic for the period comparison.
 *
 * Everything here works on plain `YYYY-MM-DD` strings anchored to UTC noon.
 * Meta's insights ranges are calendar dates in the ad account's timezone, not
 * instants, so treating them as timestamps is what introduces off-by-one-day
 * bugs around DST. Noon anchoring keeps a ±12h shift from ever crossing a day
 * boundary.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtcNoon(iso: string): number {
  return Date.parse(`${iso}T12:00:00Z`);
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function addDays(iso: string, delta: number): string {
  return toIso(toUtcNoon(iso) + delta * DAY_MS);
}

/** Inclusive day count, so a single-day range is 1. */
export function dayCount(since: string, until: string): number {
  return Math.round((toUtcNoon(until) - toUtcNoon(since)) / DAY_MS) + 1;
}

export interface ConcreteRange {
  since: string;
  until: string;
}

/**
 * The equivalent period immediately before this one: same length, ending the
 * day before it starts.
 *
 * Chosen over "the previous calendar month/week" because it is the one rule
 * that behaves predictably for every preset including custom ranges and
 * part-way-through months, and because it is what the comparison is labelled
 * as in the UI ("önceki dönem").
 */
export function previousPeriod(range: ConcreteRange): ConcreteRange {
  const length = dayCount(range.since, range.until);
  const until = addDays(range.since, -1);
  return { since: addDays(until, -(length - 1)), until };
}

/** Today's calendar date in the ad account's own timezone. */
export function todayInTimezone(timezone: string | null, now: Date = new Date()): string {
  for (const zone of [timezone ?? "UTC", "UTC"]) {
    try {
      // en-CA formats as YYYY-MM-DD, which is exactly Meta's date shape.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    } catch {
      // An unknown or renamed tz identifier falls through to UTC.
    }
  }
  return toIso(now.getTime());
}

function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function endOfPreviousMonth(iso: string): string {
  return addDays(startOfMonth(iso), -1);
}

/**
 * Concrete dates for a preset, used only as a fallback.
 *
 * The primary source of truth is Meta itself: every insights row carries the
 * `date_start`/`date_stop` it resolved the preset to, in the account's
 * timezone, and that is what the comparison is anchored to. This function only
 * runs when the current period returned no rows at all, so there is no
 * resolved range to read — without it the comparison would vanish in exactly
 * the case where "we spent nothing this period, unlike last" matters most.
 *
 * Meta's `last_N_d` presets end yesterday; they do not include the partial
 * current day.
 */
export function resolvePresetDates(
  preset: DatePresetKey,
  timezone: string | null,
  now: Date = new Date(),
): ConcreteRange {
  const today = todayInTimezone(timezone, now);
  const yesterday = addDays(today, -1);

  switch (preset) {
    case "today":
      return { since: today, until: today };
    case "yesterday":
      return { since: yesterday, until: yesterday };
    case "last_7d":
      return { since: addDays(yesterday, -6), until: yesterday };
    case "last_14d":
      return { since: addDays(yesterday, -13), until: yesterday };
    case "last_30d":
      return { since: addDays(yesterday, -29), until: yesterday };
    case "this_month":
      return { since: startOfMonth(today), until: today };
    case "last_month": {
      const lastDay = endOfPreviousMonth(today);
      return { since: startOfMonth(lastDay), until: lastDay };
    }
  }
}
