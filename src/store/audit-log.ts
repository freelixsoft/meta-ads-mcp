import { getFirestore, isFirestoreEnabled } from "./firestore.js";
import { logger } from "../utils/logger.js";
import { hashPii } from "../auth/token-store.js";

/**
 * The record of every change the assistant proposed and what became of it.
 *
 * Written on the approval path only, which is the only place a change to a
 * real ad account can originate. It answers the question an operator actually
 * asks after the fact — "who changed this budget, when, on whose reasoning,
 * and did Meta accept it" — without needing to reconstruct it from request
 * logs that were never designed to carry that.
 *
 * Rejections are recorded too. A proposal the user turned down is evidence
 * about the assistant's judgement, and a log that only keeps the approvals
 * makes it look better than it is.
 *
 * Stored under the tenant, like the tokens: `users/{fbUserId}/ai_audit/{id}`.
 * Nothing here is a credential — ids, numbers and the model's own prose — so
 * unlike the token documents it is stored in the clear, and the reader is the
 * account owner. The fbUserId in the payload is hashed anyway, because the
 * path already identifies the tenant and a duplicate raw copy inside the
 * document buys nothing.
 */

export type AuditOutcome =
  /** Sent to Meta and read back. */
  | "applied"
  /** Meta refused the write; nothing changed. */
  | "failed"
  /** The user pressed Cancel. */
  | "rejected"
  /** DASHBOARD_AI_WRITES is off, so the approval was declined server-side. */
  | "refused_writes_disabled"
  /** The object moved between the proposal and the approval. */
  | "refused_stale"
  /** The confirmation was unknown, replayed, expired or from another session. */
  | "refused_invalid";

export interface AuditEntry {
  /** When the decision was taken, ISO-8601. */
  at: string;
  /** Hashed tenant id; the document path already carries the real one. */
  userHash: string | null;
  accountId: string;
  accountName: string;
  /** Which write tool produced the plan, e.g. meta_update_ad_set. */
  tool: string;
  level: "campaign" | "adset" | "ad" | null;
  objectId: string | null;
  objectName: string | null;
  /** The fields the plan would change, as they stood when it was proposed. */
  before: Record<string, string | number | null>;
  /** The values the plan asked Meta for. */
  after: Record<string, string | null>;
  /** The assistant's own justification, as the user saw it. */
  reason: string;
  outcome: AuditOutcome;
  /** What Meta held after the write, when one happened. */
  verified: Record<string, string | number | boolean | null> | null;
  /** Stable error code when the outcome is not "applied". */
  errorCode: string | null;
}

export interface AuditLog {
  record(fbUserId: string, entry: AuditEntry): Promise<void>;
  list(fbUserId: string, limit?: number): Promise<AuditEntry[]>;
}

const DEFAULT_LIMIT = 50;

/**
 * Used when Firestore is not configured — local development and tests. Bounded
 * so a long-running dev server cannot grow it without limit, and per instance,
 * like every other in-memory store here.
 */
export class InMemoryAuditLog implements AuditLog {
  private readonly byUser = new Map<string, AuditEntry[]>();
  private static readonly MAX_PER_USER = 200;

  async record(fbUserId: string, entry: AuditEntry): Promise<void> {
    const list = this.byUser.get(fbUserId) ?? [];
    list.unshift(entry);
    if (list.length > InMemoryAuditLog.MAX_PER_USER) list.length = InMemoryAuditLog.MAX_PER_USER;
    this.byUser.set(fbUserId, list);
  }

  async list(fbUserId: string, limit = DEFAULT_LIMIT): Promise<AuditEntry[]> {
    return (this.byUser.get(fbUserId) ?? []).slice(0, limit);
  }

  clear(): void {
    this.byUser.clear();
  }
}

export class FirestoreAuditLog implements AuditLog {
  private collection(fbUserId: string) {
    return getFirestore().collection("users").doc(fbUserId).collection("ai_audit");
  }

  async record(fbUserId: string, entry: AuditEntry): Promise<void> {
    await this.collection(fbUserId).add(entry);
  }

  async list(fbUserId: string, limit = DEFAULT_LIMIT): Promise<AuditEntry[]> {
    const snap = await this.collection(fbUserId).orderBy("at", "desc").limit(limit).get();
    return snap.docs.map((doc) => doc.data() as AuditEntry);
  }
}

let auditLog: AuditLog = new InMemoryAuditLog();

export function configureAuditLog(log: AuditLog): void {
  auditLog = log;
}

export function getAuditLog(): AuditLog {
  return auditLog;
}

/** Picks the backing store the same way the token repo does. */
export function defaultAuditLog(): AuditLog {
  return isFirestoreEnabled() ? new FirestoreAuditLog() : new InMemoryAuditLog();
}

/**
 * Record a decision without letting the recording break the thing being
 * recorded.
 *
 * A Firestore hiccup must not turn a write that Meta already accepted into an
 * error the user sees, and it must not stop a rejection from being honoured.
 * The failure is logged and swallowed; the audit trail is important, but it is
 * not more important than the operation it describes.
 */
export async function recordAudit(fbUserId: string, entry: AuditEntry): Promise<void> {
  try {
    await auditLog.record(fbUserId, entry);
  } catch (error) {
    logger.error(
      {
        event: "ai_audit_write_failed",
        fbUserId: hashPii(fbUserId),
        outcome: entry.outcome,
        tool: entry.tool,
        error: error instanceof Error ? error.message : String(error),
      },
      "Could not persist an AI audit entry",
    );
  }
}
