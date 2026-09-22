import type { EntityRowDto } from "../dto.js";
import { foldForSearch } from "../search.js";

export interface EntityFilterInput {
  status?: string;
  q?: string;
}

/**
 * Status and name filtering for any drill-down table.
 *
 * Matching is on `status`, the configured state, not `effectiveStatus`: an ad
 * set whose effective status is CAMPAIGN_PAUSED is still PAUSED to the person
 * who paused the campaign, and filtering on the effective value would make
 * rows vanish from the filter they were set with.
 */
export function filterEntityRows<T extends Pick<EntityRowDto, "name" | "status">>(
  rows: T[],
  filter: EntityFilterInput,
): T[] {
  const status = filter.status?.trim().toUpperCase();
  const rawNeedle = filter.q?.trim();
  const needle = rawNeedle ? foldForSearch(rawNeedle) : undefined;

  return rows.filter((row) => {
    if (status && status !== "ALL" && row.status !== status) return false;
    if (needle && !foldForSearch(row.name).includes(needle)) return false;
    return true;
  });
}
