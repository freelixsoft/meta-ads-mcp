import { useState } from "react";
import { DATE_PRESETS, type DatePresetKey } from "../lib/labels";
import type { RangeParams } from "../api/queries";

interface DateRangePickerProps {
  value: RangeParams;
  onChange: (range: RangeParams) => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [since, setSince] = useState(value.since ?? today());
  const [until, setUntil] = useState(value.until ?? today());

  const handlePreset = (preset: DatePresetKey) => {
    if (preset === "custom") {
      onChange({ preset: "custom", since, until });
      return;
    }
    onChange({ preset });
  };

  const invalidCustom = value.preset === "custom" && since > until;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="date-preset">
        Tarih aralığı
      </label>
      <select
        id="date-preset"
        value={value.preset}
        onChange={(event) => handlePreset(event.target.value as DatePresetKey)}
        className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100 outline-none focus:border-brand-500"
      >
        {DATE_PRESETS.map((preset) => (
          <option key={preset.key} value={preset.key}>
            {preset.label}
          </option>
        ))}
      </select>

      {value.preset === "custom" ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            aria-label="Başlangıç tarihi"
            value={since}
            max={until}
            onChange={(event) => setSince(event.target.value)}
            className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100 outline-none focus:border-brand-500"
          />
          <span className="text-ink-500">–</span>
          <input
            type="date"
            aria-label="Bitiş tarihi"
            value={until}
            min={since}
            onChange={(event) => setUntil(event.target.value)}
            className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100 outline-none focus:border-brand-500"
          />
          <button
            type="button"
            disabled={invalidCustom}
            onClick={() => onChange({ preset: "custom", since, until })}
            className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-ink-100 transition hover:border-ink-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Uygula
          </button>
        </div>
      ) : null}
    </div>
  );
}
