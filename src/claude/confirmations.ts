import { randomUUID } from "node:crypto";
import type { PendingConfirmation } from "./types.js";
import type { WritePlan } from "./tools.js";

/**
 * Short-lived server-side store for writes awaiting a user's approval.
 *
 * This store is what makes the confirmation meaningful. The alternative —
 * sending the parameters to the browser and taking them back on approval —
 * would mean the values that reach Meta are whatever the browser last said,
 * not what the user was shown. Here the browser only ever holds an opaque id;
 * the name, the budget and the target object stay on the server, exactly as
 * they were validated.
 *
 * Three further properties:
 *
 *  - **Single use.** Taking a plan removes it, so an approval cannot be
 *    replayed into a second identical write.
 *  - **Owner-bound.** A plan is only returned to the same signed-in user and
 *    the same ad account that staged it, so one user's confirmation id is inert
 *    in another's session.
 *  - **Expiring.** Ten minutes. An approval clicked on a stale tab the next
 *    morning is refused rather than executed against numbers nobody re-checked.
 *
 * In memory, therefore per instance — like every other limiter and cache in
 * this codebase. A pending confirmation does not survive a deploy; the user is
 * told to ask again, and nothing has been sent to Meta.
 */

const TTL_MS = 10 * 60_000;
const MAX_PENDING = 200;

interface StoredPlan {
  plan: WritePlan;
  fbUserId: string;
  accountId: string;
  accountName: string;
  title: string;
  expiresAt: number;
}

const pending = new Map<string, StoredPlan>();

function purge(now: number): void {
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done) return;
    pending.delete(oldest.value);
  }
}

export interface StageInput {
  plan: WritePlan;
  fbUserId: string;
  accountId: string;
  accountName: string;
}

export function stageWrite(input: StageInput, now = Date.now()): PendingConfirmation {
  purge(now);
  const id = randomUUID();
  const expiresAt = now + TTL_MS;
  pending.set(id, {
    plan: input.plan,
    fbUserId: input.fbUserId,
    accountId: input.accountId,
    accountName: input.accountName,
    title: input.plan.title,
    expiresAt,
  });
  return {
    id,
    tool: input.plan.tool,
    title: input.plan.title,
    description: input.plan.description,
    reason: input.plan.reason,
    fields: input.plan.fields,
    accountName: input.accountName,
    expiresAt,
  };
}

export type TakeResult =
  | { ok: true; plan: WritePlan; title: string }
  | { ok: false; reason: "not_found" | "expired" };

/**
 * Claim a staged write. Removes it whether or not it is still valid, so a
 * single id can never be used twice even if the first attempt failed at Meta.
 */
export function takeWrite(
  id: string,
  owner: { fbUserId: string; accountId: string },
  now = Date.now(),
): TakeResult {
  // The lookup happens before the sweep so an approval that arrives just after
  // its deadline can be told apart from one that never existed — the caller
  // refuses both, but "expired" is the honest thing to log and to say.
  const entry = pending.get(id);
  // A plan belonging to someone else is reported as "not found", never as
  // "forbidden": the distinction would confirm that the id exists.
  if (!entry || entry.fbUserId !== owner.fbUserId || entry.accountId !== owner.accountId) {
    purge(now);
    return { ok: false, reason: "not_found" };
  }
  pending.delete(id);
  purge(now);
  if (entry.expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, plan: entry.plan, title: entry.title };
}

/**
 * Discards a staged write outright — what the Cancel button does.
 *
 * Returns the plan it discarded so the caller can record the rejection. A
 * proposal the user turned down is evidence about the assistant's judgement,
 * and an audit trail that keeps only the approvals flatters it.
 */
export function discardWrite(
  id: string,
  owner: { fbUserId: string; accountId: string },
): { plan: WritePlan; accountName: string } | null {
  const entry = pending.get(id);
  if (!entry || entry.fbUserId !== owner.fbUserId || entry.accountId !== owner.accountId) return null;
  pending.delete(id);
  return { plan: entry.plan, accountName: entry.accountName };
}

/** Test helper; never called by the server. */
export function clearPendingWrites(): void {
  pending.clear();
}

export function pendingWriteCount(): number {
  return pending.size;
}
