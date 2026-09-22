export interface Crumb {
  label: string;
  /** Omitted on the last crumb, which is the current location. */
  onClick?: () => void;
}

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Konum" className="flex min-w-0 items-center gap-1 text-xs">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <span aria-hidden="true" className="text-ink-700">
                /
              </span>
            ) : null}
            {isLast || !crumb.onClick ? (
              <span
                aria-current={isLast ? "page" : undefined}
                className="max-w-[16rem] truncate text-ink-100"
                title={crumb.label}
              >
                {crumb.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={crumb.onClick}
                title={crumb.label}
                className="max-w-[12rem] truncate text-ink-400 transition hover:text-ink-100 hover:underline"
              >
                {crumb.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
