import type { AdAccount } from "../api/types";
import { ACCOUNT_STATUS_LABELS } from "../lib/labels";

interface AccountSelectorProps {
  accounts: AdAccount[];
  selectedId: string | null;
  onSelect: (accountId: string) => void;
  disabled?: boolean;
}

export function AccountSelector({
  accounts,
  selectedId,
  onSelect,
  disabled = false,
}: AccountSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="account-select">
        Reklam Hesabı
      </label>
      <select
        id="account-select"
        value={selectedId ?? ""}
        disabled={disabled || accounts.length === 0}
        onChange={(event) => onSelect(event.target.value)}
        className="max-w-[18rem] min-w-0 truncate rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100 outline-none focus:border-brand-500 disabled:opacity-50"
      >
        {accounts.length === 0 ? <option value="">Hesap bulunamadı</option> : null}
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name} · {account.accountId} · {ACCOUNT_STATUS_LABELS[account.status]} ·{" "}
            {account.currency}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AccountBadge({ account }: { account: AdAccount }) {
  const tone =
    account.status === "ACTIVE" || account.status === "ANY_ACTIVE"
      ? "border-positive-400/30 bg-positive-400/10 text-positive-400"
      : account.status === "DISABLED" || account.status === "CLOSED" || account.status === "ANY_CLOSED"
        ? "border-danger-400/30 bg-danger-400/10 text-danger-400"
        : "border-warn-400/30 bg-warn-400/10 text-warn-400";

  return (
    <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {ACCOUNT_STATUS_LABELS[account.status]}
    </span>
  );
}
