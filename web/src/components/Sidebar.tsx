export type ViewKey = "overview" | "campaigns" | "ai";

const NAV_ITEMS: Array<{ key: ViewKey; label: string; hint: string }> = [
  { key: "overview", label: "Genel Bakış", hint: "Özet metrikler ve grafik" },
  { key: "campaigns", label: "Kampanyalar", hint: "Kampanya performans tablosu" },
  { key: "ai", label: "Claude AI", hint: "Veriler üzerinde soru-cevap ve yönetim" },
];

interface SidebarProps {
  active: ViewKey;
  onSelect: (view: ViewKey) => void;
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ active, onSelect, open, onClose }: SidebarProps) {
  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Menüyü kapat"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-ink-700 bg-ink-900 transition-transform lg:static lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-ink-700 px-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            AI
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-100">Ads AI Manager</p>
            <p className="truncate text-xs text-ink-500">Meta Reklam Paneli</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3" aria-label="Ana menü">
          {NAV_ITEMS.map((item) => {
            const isActive = item.key === active;
            return (
              <button
                key={item.key}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => {
                  onSelect(item.key);
                  onClose();
                }}
                className={`w-full rounded-lg px-3 py-2.5 text-left transition ${
                  isActive
                    ? "bg-ink-750 text-ink-100"
                    : "text-ink-400 hover:bg-ink-850 hover:text-ink-100"
                }`}
              >
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="block text-xs text-ink-500">{item.hint}</span>
              </button>
            );
          })}
        </nav>

        <div className="border-t border-ink-700 p-3">
          <a
            href="/auth/connections"
            className="block rounded-lg px-3 py-2 text-sm text-ink-400 transition hover:bg-ink-850 hover:text-ink-100"
          >
            Bağlantıları yönet
          </a>
        </div>
      </aside>
    </>
  );
}
