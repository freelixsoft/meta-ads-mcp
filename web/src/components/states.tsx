import type { ReactNode } from "react";
import { ApiError, RECONNECT_URL, isConnectionError } from "../api/client";
import { ERROR_MESSAGES } from "../lib/labels";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-ink-700 bg-ink-850 ${className}`}>{children}</div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} aria-hidden="true" />;
}

export function KpiSkeletonGrid() {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
      role="status"
      aria-label="Veriler yükleniyor"
    >
      {Array.from({ length: 8 }).map((_, index) => (
        <Card key={index} className="p-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-3 h-6 w-28" />
        </Card>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-label="Veriler yükleniyor">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-ink-100">{title}</p>
      {description ? <p className="max-w-md text-sm text-ink-400">{description}</p> : null}
    </div>
  );
}

/**
 * One component for every failure, because the recovery differs: an expired
 * Meta connection needs a sign-in link, everything else needs a retry.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const connection = isConnectionError(error);
  const code = error instanceof ApiError ? error.code : "server_error";
  const message = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.server_error;

  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <p className="text-sm font-medium text-danger-400">
        {connection ? "Meta bağlantısı sona erdi" : "Veri alınamadı"}
      </p>
      <p className="max-w-md text-sm text-ink-400">{message}</p>
      {connection ? (
        <a
          href={RECONNECT_URL}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500"
        >
          Meta ile yeniden bağlan
        </a>
      ) : (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm font-medium text-ink-100 transition hover:border-ink-500"
        >
          Tekrar dene
        </button>
      )}
    </div>
  );
}
