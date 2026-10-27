import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

/** Grey shapes in the layout of what is loading, so the page does not jump when data arrives. */
export function Skeleton({ rows = 3, height = 20, label = "Loading" }: { rows?: number; height?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <span key={i} className="skeleton-row" style={{ height, width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p className="state-title">This could not be loaded</p>
      <p className="state-text">{message} Check that the orchestrator is running, then try again.</p>
      <button type="button" className="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {children ? <div className="state-text">{children}</div> : null}
    </div>
  );
}

/** Loading, error with retry, empty and content: every screen goes through this. */
export function Loadable<T>({
  query,
  skeleton,
  isEmpty,
  empty,
  children,
}: { query: UseQueryResult<T>; skeleton?: ReactNode; isEmpty?: (d: T) => boolean; empty?: ReactNode; children: (d: T) => ReactNode }) {
  if (query.isPending) return <>{skeleton ?? <Skeleton />}</>;
  if (query.isError) return <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />;
  if (isEmpty?.(query.data)) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return <>{children(query.data)}</>;
}
