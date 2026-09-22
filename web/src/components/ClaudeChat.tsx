import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAiChat, useAiConfirm, useAiStatus } from "../api/queries";
import { ApiError } from "../api/client";
import type { AiChatResponse, AiConfirmation, AiToolTrace, ChatHistoryTurn } from "../api/types";
import { AI_SUGGESTED_QUESTIONS, ERROR_MESSAGES } from "../lib/labels";
import { Card, EmptyState, ErrorState, Skeleton } from "./states";

const MAX_MESSAGE_CHARS = 500;
/** Matches the server's history ceiling; sending more would only be trimmed there. */
const MAX_HISTORY_TURNS = 10;

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Plain text. Rendered as text — nothing in this file parses markup. */
  content: string;
  toolTrace?: AiToolTrace[];
  isError?: boolean;
  /** Why the turn ended, so an incomplete answer can say so instead of looking final. */
  stopReason?: AiChatResponse["stopReason"];
  /** The question that produced this bubble, so it can be asked again. */
  retryOf?: string;
  /**
   * A proposed change, rendered as a card in the stream rather than a modal.
   *
   * It lives in the transcript because that is where the reasoning that
   * produced it lives: scrolling back should show what was proposed, what the
   * user decided and why, not an empty gap where a dialog used to be. The
   * status is what makes a second approval impossible — the buttons exist only
   * while it is "pending", and every decision replaces it.
   */
  suggestion?: { confirmation: AiConfirmation; status: SuggestionStatus };
}

/** Where a proposal stands. Only "pending" renders buttons. */
type SuggestionStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "writes_disabled"
  | "stale"
  | "invalid"
  | "failed";

/** Turns that stopped early rather than finishing, and what the user can do about it. */
const INCOMPLETE_HINTS: Partial<Record<NonNullable<ChatMessage["stopReason"]>, string>> = {
  timeout: "Bu soru ayrılan sürede tamamlanamadı. Daha kısa bir tarih aralığı ya da tek bir kampanya sorarsanız yetişir.",
  max_steps: "Bu soru için gereken veri adımları tamamlanamadı. Soruyu biraz daraltmayı deneyin.",
};

let messageCounter = 0;
function nextId(): string {
  messageCounter += 1;
  return `m${messageCounter}`;
}

interface ClaudeChatProps {
  accountId: string | null;
  accountName: string;
  /** A question handed over from the drill-down, to be edited or sent as is. */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
}

/**
 * The Claude assistant view.
 *
 * Two things about it are load-bearing rather than cosmetic:
 *
 *  - **Everything the model writes is text.** React escapes it, there is no
 *    `dangerouslySetInnerHTML` anywhere in this file, and no answer is parsed
 *    as HTML or markdown. `whitespace-pre-line` is CSS, not a parser.
 *  - **A proposed change is not a change.** When the server returns a
 *    confirmation, nothing has been sent to Meta. The dialog below is the only
 *    path to the write endpoint, and it sends back the opaque id — never the
 *    parameters, which never leave the server.
 */
export function ClaudeChat({
  accountId,
  accountName,
  prefill,
  onPrefillConsumed,
}: ClaudeChatProps) {
  const inputId = useId();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  /**
   * The account a request was sent for. A turn started on one account must not
   * land in another's conversation: the numbers belong to a different business
   * and the ids in it would only 403.
   */
  const accountRef = useRef(accountId);
  accountRef.current = accountId;

  const status = useAiStatus(accountId !== null);
  const chat = useAiChat();
  const confirm = useAiConfirm();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, chat.isPending]);

  // A handed-over question is written into the box, never sent automatically:
  // the user sees what will be asked, can edit it, and nothing is spent until
  // they press Gönder.
  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill);
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  // Switching ad accounts makes the conversation meaningless: the ids in it
  // belong to the previous account and the numbers to a different business.
  useEffect(() => {
    setMessages([]);
  }, [accountId]);

  const busy = chat.isPending || confirm.isPending;

  const append = (message: Omit<ChatMessage, "id">): void => {
    setMessages((current) => [...current, { ...message, id: nextId() }]);
  };

  const send = (text: string, priorTurns = messages): void => {
    const message = text.trim();
    if (accountId === null || message.length < 3 || busy) return;

    const history: ChatHistoryTurn[] = priorTurns
      .filter((entry) => !entry.isError)
      .slice(-MAX_HISTORY_TURNS)
      .map((entry) => ({ role: entry.role, content: entry.content }));

    setMessages([...priorTurns, { id: nextId(), role: "user", content: message }]);
    setDraft("");

    const sentFor = accountId;
    chat.mutate(
      { accountId, message, history },
      {
        onSuccess: (response) => {
          if (accountRef.current !== sentFor) return;
          append({
            role: "assistant",
            content: response.answer,
            toolTrace: response.toolTrace,
            stopReason: response.stopReason,
            retryOf: message,
          });
          if (response.confirmation) {
            append({
              role: "assistant",
              content: "",
              suggestion: { confirmation: response.confirmation, status: "pending" },
            });
          }
        },
        onError: (error) => {
          if (accountRef.current !== sentFor) return;
          // A throttled or unreachable provider is sticky for a minute on the
          // server; refreshing the status now is what turns the header pill
          // from "Hazır" into "Hız sınırı" instead of leaving it stale for the
          // five minutes this query is otherwise cached for.
          const code = error instanceof ApiError ? error.code : null;
          if (code === "ai_rate_limited" || code === "ai_unavailable") {
            void queryClient.invalidateQueries({ queryKey: ["ai-status"] });
          }
          append({
            role: "assistant",
            content: messageForError(error),
            isError: true,
            retryOf: message,
          });
        },
      },
    );
  };

  /**
   * Ask the same question again, after dropping the exchange that failed.
   *
   * Dropping it matters: leaving a question that was never answered in the
   * history would send Claude a conversation where it appears to have ignored
   * the user, and would count the failed turn against the history ceiling.
   */
  const retry = (question: string): void => {
    // The LAST matching exchange: the same question asked twice would otherwise
    // rewind the conversation to the first attempt and drop everything since.
    let failedAt = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant" && messages[index].retryOf === question) {
        failedAt = index;
        break;
      }
    }
    const priorTurns = failedAt === -1 ? messages : messages.slice(0, Math.max(0, failedAt - 1));
    send(question, priorTurns);
  };

  const setSuggestionStatus = (messageId: string, status: SuggestionStatus): void => {
    setMessages((current) =>
      current.map((entry) =>
        entry.id === messageId && entry.suggestion
          ? { ...entry, suggestion: { ...entry.suggestion, status } }
          : entry,
      ),
    );
  };

  const decide = (messageId: string, decision: "approve" | "cancel"): void => {
    const entry = messages.find((message) => message.id === messageId);
    // Guarding on "pending" is what makes a second approval impossible: the
    // buttons are already gone, but a queued click or a replayed event cannot
    // get past this either.
    if (accountId === null || !entry?.suggestion || entry.suggestion.status !== "pending") return;

    const pending = entry.suggestion.confirmation;
    const sentFor = accountId;

    confirm.mutate(
      { accountId, confirmationId: pending.id, decision },
      {
        onSuccess: (response) => {
          if (accountRef.current !== sentFor) return;
          setSuggestionStatus(messageId, decision === "cancel" ? "rejected" : "applied");
          append({
            role: "assistant",
            content:
              decision === "cancel"
                ? "İşlem iptal edildi. Meta'ya hiçbir değişiklik gönderilmedi."
                : (response.answer ?? "İşlem tamamlandı."),
          });
        },
        onError: (error) => {
          if (accountRef.current !== sentFor) return;
          const code = error instanceof ApiError ? error.code : null;
          setSuggestionStatus(
            messageId,
            code === "ai_writes_disabled"
              ? "writes_disabled"
              : code === "ai_write_stale"
                ? "stale"
                : code === "ai_confirmation_expired"
                  ? "invalid"
                  : "failed",
          );
          append({ role: "assistant", content: messageForError(error), isError: true });
        },
      },
    );
  };

  if (accountId === null) {
    return (
      <Card>
        <EmptyState
          title="Reklam hesabı seçilmedi"
          description="Claude ile konuşmak için önce bir reklam hesabı seçin."
        />
      </Card>
    );
  }

  if (status.isPending) {
    return (
      <Card className="space-y-3 p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }

  if (status.isError) {
    return (
      <Card>
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      </Card>
    );
  }

  if (!status.data.configured) {
    return (
      <Card>
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
          <p className="text-sm font-medium text-ink-100">Claude AI yapılandırılmamış</p>
          <p className="max-w-md text-sm text-ink-400">
            Asistan, sunucu tarafında tanımlı bir Anthropic API anahtarıyla çalışır. Sunucu
            yöneticisinin <code className="text-ink-300">ANTHROPIC_API_KEY</code> değişkenini
            tanımlaması gerekiyor. Anahtar hiçbir zaman tarayıcıya gönderilmez.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex min-h-[32rem] flex-col gap-4">
      <Card className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-100">Claude AI</h2>
          <p className="mt-1 text-xs text-ink-400">
            Sorular <span className="text-ink-300">{accountName}</span> hesabının Meta verisi
            üzerinden yanıtlanır. Değişiklikler yalnızca siz onayladıktan sonra gönderilir.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill status={status.data} />
          {messages.length > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setMessages([])}
              className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-ink-300 transition hover:border-ink-500 hover:text-ink-100 disabled:opacity-50"
            >
              Sohbeti temizle
            </button>
          ) : null}
        </div>
      </Card>

      <Card className="flex min-h-96 flex-1 flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite" aria-busy={busy}>
          {messages.length === 0 ? (
            <div className="space-y-4 py-6">
              <EmptyState
                title="Ne öğrenmek istersiniz?"
                description="Performans sorun, düşük performanslı reklamları bulun ya da bir değişiklik isteyin. Claude gerekli Meta verilerini kendisi okur."
              />
              <div className="flex flex-wrap justify-center gap-2">
                {AI_SUGGESTED_QUESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={busy}
                    onClick={() => send(suggestion)}
                    className="rounded-full border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-ink-300 transition hover:border-ink-500 hover:text-ink-100 disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) =>
              message.suggestion ? (
                <SuggestionCard
                  key={message.id}
                  confirmation={message.suggestion.confirmation}
                  status={message.suggestion.status}
                  busy={busy}
                  onApprove={() => decide(message.id, "approve")}
                  onReject={() => decide(message.id, "cancel")}
                />
              ) : (
                <Bubble
                  key={message.id}
                  message={message}
                  onRetry={message.retryOf && !busy ? () => retry(message.retryOf!) : undefined}
                />
              ),
            )
          )}

          {chat.isPending ? <WorkingBubble /> : null}
          {confirm.isPending ? (
            <p className="text-xs text-ink-400">Onaylanan işlem Meta'ya gönderiliyor…</p>
          ) : null}
          <div ref={endRef} />
        </div>

        <div className="border-t border-ink-700 p-4">
          <label htmlFor={inputId} className="sr-only">
            Claude'a sorun
          </label>
          <div className="flex items-end gap-2">
            <textarea
              id={inputId}
              value={draft}
              maxLength={MAX_MESSAGE_CHARS}
              rows={2}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send(draft);
                }
              }}
              placeholder="Örn: Son 30 günde hangi reklam setleri kötü gidiyor?"
              className="min-w-0 flex-1 resize-none rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              disabled={busy || draft.trim().length < 3}
              onClick={() => send(draft)}
              className="shrink-0 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Gönder
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {draft.length}/{MAX_MESSAGE_CHARS} · Enter gönderir, Shift+Enter satır atlar ·{" "}
            {status.data.model}
          </p>
        </div>
      </Card>

    </div>
  );
}

/**
 * How long an approval is still good for. The server discards a staged write
 * after ten minutes, so a dialog left open over lunch would fail on approval —
 * saying so beforehand is kinder than explaining it afterwards.
 */
function formatExpiry(expiresAt: number): string {
  const minutes = Math.round((expiresAt - Date.now()) / 60_000);
  if (minutes <= 0) return "artık geçerli değil —";
  return `yaklaşık ${minutes} dakika daha`;
}

function messageForError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "server_error";
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.server_error;
}

function StatusPill({ status }: { status: { rateLimited: boolean; unavailable: boolean } }) {
  if (status.rateLimited) {
    return (
      <span className="rounded-md border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-warn-400">
        Hız sınırı
      </span>
    );
  }
  if (status.unavailable) {
    return (
      <span className="rounded-md border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-danger-400">
        Servis yanıt vermiyor
      </span>
    );
  }
  return (
    <span className="rounded-md border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-positive-400">
      Hazır
    </span>
  );
}

function WorkingBubble() {
  return (
    <div className="max-w-[85%] rounded-xl border border-ink-700 bg-ink-800 px-3 py-2">
      <p className="text-sm text-ink-400">Meta verileri okunuyor…</p>
      <div className="mt-2 space-y-1.5">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-3 w-36" />
      </div>
    </div>
  );
}

function Bubble({ message, onRetry }: { message: ChatMessage; onRetry?: () => void }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] break-words whitespace-pre-line rounded-xl bg-brand-600 px-3 py-2 text-sm text-white">
          {message.content}
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-[85%] space-y-2">
      <p
        className={`break-words whitespace-pre-line rounded-xl border px-3 py-2 text-sm leading-relaxed ${
          message.isError
            ? "border-danger-400/40 bg-ink-800 text-danger-400"
            : "border-ink-700 bg-ink-800 text-ink-100"
        }`}
      >
        {message.content}
      </p>
      {message.stopReason && INCOMPLETE_HINTS[message.stopReason] ? (
        <p className="rounded-lg border border-warn-400/40 bg-ink-800 px-3 py-2 text-xs text-warn-400">
          {INCOMPLETE_HINTS[message.stopReason]}
        </p>
      ) : null}

      {message.toolTrace && message.toolTrace.length > 0 ? (
        <ToolTraceList trace={message.toolTrace} />
      ) : null}

      {onRetry && (message.isError || (message.stopReason && INCOMPLETE_HINTS[message.stopReason])) ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-ink-300 transition hover:border-ink-500 hover:text-ink-100"
        >
          Tekrar dene
        </button>
      ) : null}
    </div>
  );
}

/**
 * What the assistant actually read, so an answer is never an unexplained claim.
 * `detail` carries the evidence — how many rows and which dates — which is what
 * turns this from a spinner log into something a user can check an answer against.
 */
function ToolTraceList({ trace }: { trace: AiToolTrace[] }) {
  return (
    <div className="pl-1">
      <p className="mb-1 text-xs text-ink-500">Kullanılan Meta verileri</p>
      <ul className="space-y-1">
        {trace.map((entry, index) => (
          <li key={`${entry.name}-${index}`} className="flex items-start gap-2 text-xs text-ink-400">
            <span
              aria-hidden="true"
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                entry.status === "ok"
                  ? "bg-positive-400"
                  : entry.status === "awaiting_confirmation"
                    ? "bg-warn-400"
                    : "bg-danger-400"
              }`}
            />
            <span className="min-w-0 break-words">
              {entry.label}
              {entry.detail ? <span className="text-ink-500"> · {entry.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How a decided proposal is labelled once the buttons are gone. */
const SUGGESTION_STATUS: Record<
  Exclude<SuggestionStatus, "pending">,
  { label: string; tone: string; note: string }
> = {
  applied: {
    label: "UYGULANDI",
    tone: "border-positive-400/30 bg-positive-400/10 text-positive-400",
    note: "Değişiklik Meta'ya gönderildi ve sonuç Meta'dan okunarak doğrulandı.",
  },
  rejected: {
    label: "REDDEDİLDİ",
    tone: "border-ink-700 bg-ink-800 text-ink-400",
    note: "Öneri reddedildi. Meta'ya hiçbir istek gönderilmedi.",
  },
  writes_disabled: {
    label: "YETKİ KAPALI",
    tone: "border-warn-400/30 bg-warn-400/10 text-warn-400",
    note: "Reklam değiştirme yetkisi bu sunucuda kapalı. Meta'ya hiçbir istek gönderilmedi.",
  },
  stale: {
    label: "ÖNERİ GEÇERSİZ",
    tone: "border-warn-400/30 bg-warn-400/10 text-warn-400",
    note: "Bu nesne, öneri hazırlandıktan sonra Meta tarafında değişti. Hiçbir şey gönderilmedi — güncel değerlerle yeniden sorun.",
  },
  invalid: {
    label: "ÖNERİ GEÇERSİZ",
    tone: "border-warn-400/30 bg-warn-400/10 text-warn-400",
    note: "Bu onay artık geçerli değil (süresi doldu ya da zaten kullanıldı). Değişikliği yeniden isteyin.",
  },
  failed: {
    label: "BAŞARISIZ",
    tone: "border-danger-400/30 bg-danger-400/10 text-danger-400",
    note: "Meta isteği reddetti. Ayrıntı yukarıdaki mesajda.",
  },
};

const CONFIDENCE_LABEL: Record<"low" | "medium" | "high", string> = {
  low: "DÜŞÜK",
  medium: "ORTA",
  high: "YÜKSEK",
};

/**
 * A proposed change, in the transcript rather than over it.
 *
 * It replaced a modal on purpose. A modal makes the decision feel like an
 * interruption to be dismissed, hides the reasoning that produced it the
 * moment it opens, and leaves nothing behind afterwards — so scrolling back
 * through a conversation showed answers with no record of what was proposed or
 * what was decided. As a card it sits next to the analysis it came from, and
 * its own status is the record.
 *
 * The buttons render only while the status is "pending", which is what makes a
 * second approval impossible from the UI; the server independently refuses a
 * replayed id, and `decide` refuses a non-pending entry.
 */
function SuggestionCard({
  confirmation,
  status,
  busy,
  onApprove,
  onReject,
}: {
  confirmation: AiConfirmation;
  status: SuggestionStatus;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const decided = status === "pending" ? null : SUGGESTION_STATUS[status];

  return (
    <article className="rounded-xl border border-ink-700 bg-ink-850">
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-4 py-2.5">
        <span className="rounded-md border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-brand-400">
          ÖNERİ
        </span>
        {decided ? (
          <span className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide ${decided.tone}`}>
            {decided.label}
          </span>
        ) : (
          <span className="rounded-md border border-ink-700 bg-ink-800 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-ink-400">
            BEKLİYOR
          </span>
        )}
        {confirmation.confidence ? (
          <span className="ml-auto text-[11px] text-ink-500">
            Güven: <span className="text-ink-300">{CONFIDENCE_LABEL[confirmation.confidence]}</span>
          </span>
        ) : null}
      </header>

      <div className="space-y-3 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-ink-100">{confirmation.title}</h3>
          <p className="mt-0.5 text-xs text-ink-500">{confirmation.accountName}</p>
        </div>

        <dl className="space-y-1.5 rounded-lg border border-ink-700 bg-ink-800 p-3">
          {confirmation.fields.map((field, index) => (
            <div
              key={`${field.label}-${index}`}
              className="flex flex-col gap-0.5 text-xs sm:flex-row sm:justify-between sm:gap-3"
            >
              <dt className="shrink-0 text-ink-500">{field.label}</dt>
              <dd className="min-w-0 break-words text-ink-100 sm:text-right">{field.value}</dd>
            </div>
          ))}
        </dl>

        {confirmation.reason ? (
          <div>
            <p className="text-[11px] font-semibold tracking-wide text-ink-500">GEREKÇE</p>
            <p className="mt-1 break-words text-xs text-ink-300">{confirmation.reason}</p>
          </div>
        ) : null}

        {confirmation.risk ? (
          <div>
            <p className="text-[11px] font-semibold tracking-wide text-ink-500">RİSK</p>
            <p className="mt-1 break-words text-xs text-ink-300">{confirmation.risk}</p>
          </div>
        ) : null}

        {decided ? (
          <p className="text-xs text-ink-400">{decided.note}</p>
        ) : (
          <p className="text-xs text-ink-500">
            Onaylayana kadar Meta'ya hiçbir istek gönderilmedi. Bu onay{" "}
            {formatExpiry(confirmation.expiresAt)} geçerli.
          </p>
        )}
      </div>

      {status === "pending" ? (
        <footer className="flex flex-col gap-2 border-t border-ink-700 px-4 py-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm font-medium text-ink-100 transition hover:border-ink-500 disabled:opacity-50"
          >
            Reddet
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:opacity-50"
          >
            Onayla ve Uygula
          </button>
        </footer>
      ) : null}
    </article>
  );
}
