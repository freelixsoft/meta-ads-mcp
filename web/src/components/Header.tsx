import type { ReactNode } from "react";
import type { AdAccount, SessionResponse } from "../api/types";
import { AccountBadge, AccountSelector } from "./AccountSelector";
import { DateRangePicker } from "./DateRangePicker";
import { datePresetLabel } from "../lib/labels";
import type { RangeParams } from "../api/queries";

interface HeaderProps {
  session: SessionResponse | undefined;
  accounts: AdAccount[];
  selectedAccount: AdAccount | null;
  onSelectAccount: (accountId: string) => void;
  range: RangeParams;
  onRangeChange: (range: RangeParams) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onOpenMenu: () => void;
  breadcrumbs?: ReactNode;
}

export function Header({
  session,
  accounts,
  selectedAccount,
  onSelectAccount,
  range,
  onRangeChange,
  onRefresh,
  refreshing,
  onOpenMenu,
  breadcrumbs,
}: HeaderProps) {
  const rangeLabel =
    range.preset === "custom" && range.since && range.until
      ? `${range.since} – ${range.until}`
      : datePresetLabel(range.preset);

  return (
    <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-900/95 backdrop-blur">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Menüyü aç"
          className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-300 lg:hidden"
        >
          Menü
        </button>

        <div className="min-w-0 flex-1">
          {breadcrumbs ?? (
            <h1 className="truncate text-base font-semibold text-ink-100">Genel Bakış</h1>
          )}
          <p className="truncate text-xs text-ink-500">
            {selectedAccount ? `${selectedAccount.name} · ${rangeLabel}` : "Reklam hesabı seçin"}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {session ? (
            <div className="hidden items-center gap-2 sm:flex">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
                {session.user.initials}
              </div>
              <div className="min-w-0 max-w-[12rem]">
                <p className="truncate text-xs font-medium text-ink-100">
                  {session.user.name ?? "Meta kullanıcısı"}
                </p>
                <p className="truncate text-xs text-ink-500">
                  {session.meta.businessName ?? session.user.email ?? ""}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-ink-700/60 px-4 py-3 sm:px-6">
        <AccountSelector
          accounts={accounts}
          selectedId={selectedAccount?.id ?? null}
          onSelect={onSelectAccount}
        />
        {selectedAccount ? <AccountBadge account={selectedAccount} /> : null}
        <DateRangePicker value={range} onChange={onRangeChange} />
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-auto rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm font-medium text-ink-100 transition hover:border-ink-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing ? "Yenileniyor" : "Yenile"}
        </button>
      </div>
    </header>
  );
}
