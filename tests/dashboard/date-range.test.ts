import { describe, expect, it } from "vitest";
import {
  addDays,
  dayCount,
  previousPeriod,
  resolvePresetDates,
  todayInTimezone,
} from "../../src/dashboard/date-range.js";

describe("addDays", () => {
  it("moves forward and backward across month boundaries", () => {
    expect(addDays("2026-09-19", 1)).toBe("2026-09-20");
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles leap days", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });

  it("does not drift across a DST transition", () => {
    // Europe/Istanbul no longer shifts, but the anchor must hold for zones
    // that do: noon anchoring means a +/-1h shift never crosses midnight.
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
  });
});

describe("dayCount", () => {
  it("is inclusive on both ends", () => {
    expect(dayCount("2026-09-19", "2026-09-19")).toBe(1);
    expect(dayCount("2026-09-13", "2026-09-19")).toBe(7);
    expect(dayCount("2026-09-01", "2026-09-30")).toBe(30);
  });
});

describe("previousPeriod", () => {
  it("returns the same-length window ending the day before", () => {
    expect(previousPeriod({ since: "2026-09-13", until: "2026-09-19" })).toEqual({
      since: "2026-09-06",
      until: "2026-09-12",
    });
  });

  it("handles a single day", () => {
    expect(previousPeriod({ since: "2026-09-19", until: "2026-09-19" })).toEqual({
      since: "2026-09-18",
      until: "2026-09-18",
    });
  });

  it("crosses a month boundary", () => {
    expect(previousPeriod({ since: "2026-09-01", until: "2026-09-30" })).toEqual({
      since: "2026-08-02",
      until: "2026-08-31",
    });
  });

  it("crosses a year boundary", () => {
    expect(previousPeriod({ since: "2026-01-01", until: "2026-01-07" })).toEqual({
      since: "2025-12-25",
      until: "2025-12-31",
    });
  });

  it("never overlaps the current period", () => {
    const current = { since: "2026-09-13", until: "2026-09-19" };
    const previous = previousPeriod(current);
    expect(previous.until < current.since).toBe(true);
    expect(dayCount(previous.since, previous.until)).toBe(dayCount(current.since, current.until));
  });
});

describe("todayInTimezone", () => {
  const instant = new Date("2026-09-19T22:30:00Z");

  it("uses the account timezone, not the server's", () => {
    // 22:30 UTC is already the 20th in Istanbul (UTC+3).
    expect(todayInTimezone("Europe/Istanbul", instant)).toBe("2026-09-20");
    expect(todayInTimezone("America/Los_Angeles", instant)).toBe("2026-09-19");
  });

  it("falls back to UTC for a null or unknown zone", () => {
    expect(todayInTimezone(null, instant)).toBe("2026-09-19");
    expect(todayInTimezone("Not/AZone", instant)).toBe("2026-09-19");
  });
});

describe("resolvePresetDates", () => {
  // 2026-09-19 in Istanbul.
  const now = new Date("2026-09-19T09:00:00Z");
  const tz = "Europe/Istanbul";

  it("resolves single-day presets", () => {
    expect(resolvePresetDates("today", tz, now)).toEqual({
      since: "2026-09-19",
      until: "2026-09-19",
    });
    expect(resolvePresetDates("yesterday", tz, now)).toEqual({
      since: "2026-09-18",
      until: "2026-09-18",
    });
  });

  it("ends last_N_d at yesterday, matching Meta", () => {
    expect(resolvePresetDates("last_7d", tz, now)).toEqual({
      since: "2026-09-12",
      until: "2026-09-18",
    });
    expect(resolvePresetDates("last_14d", tz, now)).toEqual({
      since: "2026-09-05",
      until: "2026-09-18",
    });
    expect(resolvePresetDates("last_30d", tz, now)).toEqual({
      since: "2026-08-20",
      until: "2026-09-18",
    });
  });

  it("gives last_N_d exactly N days", () => {
    for (const [preset, days] of [
      ["last_7d", 7],
      ["last_14d", 14],
      ["last_30d", 30],
    ] as const) {
      const range = resolvePresetDates(preset, tz, now);
      expect(dayCount(range.since, range.until), preset).toBe(days);
    }
  });

  it("runs this_month from the 1st to today", () => {
    expect(resolvePresetDates("this_month", tz, now)).toEqual({
      since: "2026-09-01",
      until: "2026-09-19",
    });
  });

  it("covers the whole previous calendar month for last_month", () => {
    expect(resolvePresetDates("last_month", tz, now)).toEqual({
      since: "2026-08-01",
      until: "2026-08-31",
    });
  });

  it("handles last_month across a year boundary and a short month", () => {
    const january = new Date("2026-01-15T09:00:00Z");
    expect(resolvePresetDates("last_month", tz, january)).toEqual({
      since: "2025-12-01",
      until: "2025-12-31",
    });
    const march = new Date("2027-03-10T09:00:00Z");
    expect(resolvePresetDates("last_month", tz, march)).toEqual({
      since: "2027-02-01",
      until: "2027-02-28",
    });
  });
});
