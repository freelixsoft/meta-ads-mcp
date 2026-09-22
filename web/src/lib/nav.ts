import type { EntityLevel, EntityRow } from "../api/types";

/**
 * Where the user is in the drill-down. Parent names travel with the state so
 * breadcrumbs can render immediately, without waiting for a fetch to tell us
 * what the campaign we just clicked is called.
 */
export type NavState =
  | { view: "overview" }
  | { view: "ai" }
  | { view: "campaigns" }
  | { view: "adsets"; campaignId: string; campaignName: string }
  | {
      view: "ads";
      campaignId: string;
      campaignName: string;
      adSetId: string;
      adSetName: string;
    };

export type DetailTarget = {
  level: Exclude<EntityLevel, "account">;
  id: string;
  name: string;
};

export const OVERVIEW: NavState = { view: "overview" };
export const CAMPAIGNS: NavState = { view: "campaigns" };
export const AI: NavState = { view: "ai" };

export function adSetsOf(row: EntityRow): NavState {
  return { view: "adsets", campaignId: row.id, campaignName: row.name };
}

export function adsOf(nav: NavState, row: EntityRow): NavState {
  const campaignId = row.campaignId ?? (nav.view === "adsets" ? nav.campaignId : "");
  const campaignName =
    row.campaignName ?? (nav.view === "adsets" ? nav.campaignName : "Kampanya");
  return {
    view: "ads",
    campaignId,
    campaignName,
    adSetId: row.id,
    adSetName: row.name,
  };
}

const ASK_CLAUDE_TEMPLATE: Record<Exclude<EntityLevel, "account">, (name: string) => string> = {
  campaign: (name) =>
    `"${name}" kampanyasını analiz et. Performansı nasıl, önceki döneme göre ne değişti, sorun varsa nedeni ne?`,
  adset: (name) =>
    `"${name}" reklam setini analiz et. Verimli mi, kapatmalı mıyım, yoksa bütçesini mi artırmalıyım?`,
  ad: (name) => `"${name}" reklamını analiz et. Para kaybettiriyor mu, kapatmalı mıyım?`,
};

/**
 * The question the "Claude'a sor" button drops into the chat box.
 *
 * Pre-filled rather than sent: the user sees exactly what will be asked and can
 * edit it, which is also why nothing is spent until they press Gönder.
 */
export function askClaudeQuestion(target: DetailTarget): string {
  return ASK_CLAUDE_TEMPLATE[target.level](target.name);
}

export function detailOf(row: EntityRow): DetailTarget {
  return { level: row.level as Exclude<EntityLevel, "account">, id: row.id, name: row.name };
}

/**
 * Drilling down or changing the ad account has to reset anything below it —
 * an ad set id from the previous account would only produce a 403.
 */
export function resetForAccountChange(nav: NavState): NavState {
  // The overview and the AI panel are account-scoped already, so they survive a
  // switch; anything below the account carries ids that would only 403.
  if (nav.view === "overview") return OVERVIEW;
  if (nav.view === "ai") return AI;
  return CAMPAIGNS;
}
