import type { ApiErrorCode } from "./types";

const API_BASE = "/api/dashboard";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** True for the states where the fix is reconnecting Meta, not retrying. */
export function isConnectionError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "unauthenticated" ||
      error.code === "meta_not_connected" ||
      error.code === "meta_connection_expired")
  );
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/**
 * `fetch` rejects — rather than resolving with a bad status — when the request
 * never reached the server at all: the connection dropped, the user went
 * offline, the request was aborted. That is a different situation from a 500
 * and deserves different advice, so it gets its own code instead of falling
 * through to the generic "unexpected error".
 */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError("network_error", 0, "The request did not reach the server.");
  }
}

/** Shared failure mapping for both verbs. */
async function toApiError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope = {};
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    /* non-JSON error body: fall through to the status-based default */
  }
  return new ApiError(
    (envelope.error?.code as ApiErrorCode | undefined) ?? "server_error",
    response.status,
    envelope.error?.message ?? `HTTP ${response.status}`,
  );
}

/**
 * Cookie-authenticated fetch. `same-origin` is the point: the session cookie
 * is the only credential, it is httpOnly, and no token ever reaches this file.
 */
export async function apiGet<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  const response = await send(url.toString(), {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) throw await toApiError(response);

  return (await response.json()) as T;
}

/**
 * The AI routes are POSTs: the question is user text that has no business in a
 * URL, an access log or the browser history. `same-origin` again — the session
 * cookie is the only credential and the server additionally verifies the origin
 * on every mutation.
 */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);

  const response = await send(url.toString(), {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw await toApiError(response);

  return (await response.json()) as T;
}

export const RECONNECT_URL = `/auth/meta?return=${encodeURIComponent("/dashboard")}`;
