# Ads AI Manager dashboard

A browser dashboard served by the same Express process as the MCP server, at
`/dashboard`. It is additive: it adds no login of its own, changes no MCP tool,
and leaves `POST /mcp` and both OAuth surfaces untouched.

## Architecture

```
Browser (SPA)  ──cookie: __Host-mcp_session──▶  Express / Cloud Run
                                                  │
  GET /dashboard/*      → SPA shell + assets      │  requireDashboardSession
  GET /api/dashboard/*  → dashboard API router ───┤  withMetaContext
                                                  │  services → metaApiClient
  POST /mcp             → unchanged               ▼
                                            graph.facebook.com
```

Server code lives under [src/dashboard/](../src/dashboard/); the frontend is a
separate Vite workspace in [web/](../web/) that builds to static assets.

### Authentication

The dashboard reuses the browser session from
[src/auth/session.ts](../src/auth/session.ts) — the same `__Host-mcp_session`
cookie the consent and connections pages use. Signing out there signs out here,
and revoking the session `jti` kills both.

- A signed-out **page** request 302s to `/auth/meta?return=/dashboard`.
- A signed-out **API** request gets a JSON `401 {"error":{"code":"unauthenticated"}}`.
  It is never a redirect: a 302 inside `fetch()` is followed opaquely and
  surfaces to the SPA as a CORS failure rather than a sign-in prompt.

`/dashboard` is an exact-string member of `STANDALONE_RETURN_PATHS` in
[src/transport/auth-routes.ts](../src/transport/auth-routes.ts). Nothing else
about return-URL validation was loosened — sub-paths, queries and prefix
impostors (`/dashboardx`) are still rejected.

### Meta tokens

`withMetaContext` resolves the caller's token through the existing
`getDecryptedToken()` and puts it in the same `AsyncLocalStorage` the MCP path
uses, so `metaApiClient` — and the rate limiter, circuit breaker and per-tenant
credential resolution hanging off it — behave identically for a dashboard
request and a tool call. There is no second decryption path.

The token never leaves that store: it is not attached to the request, not
logged, and not serialized into any response. Only its 12-hex hash is kept, for
cache partitioning.

### Drill-down hierarchy

Campaigns → ad sets → ads. Every level shows the same metric set, is
searchable, status-filterable and sortable, and each row opens either the level
below it or a detail drawer.

The hierarchy is navigated with breadcrumbs (Genel Bakış / Kampanyalar /
Ad Setler / Reklamlar). Selecting a different ad account resets the position to
the top, because ids below it belong to the previous account.

### Account authorization

A session identifies a *user*, not an *account*. Before every account-scoped
operation, `authorizeAccount()` checks the requested `act_*` against the list
returned by `/me/adaccounts` for the current token. An id that is not in that
list is a `403 account_forbidden` and never reaches Graph, so a crafted id can
neither read data nor probe for existence.

### Entity authorization

An id in the path is never trusted. `src/dashboard/services/entities.ts`
resolves it through two gates:

1. `validateMetaId` rejects anything that is not a bare numeric id, so nothing
   malformed is ever interpolated into a Graph path.
2. Ownership is decided on **Meta's own answer**: the `account_id` Meta returns
   for the object must equal the account already authorized for the request. A
   token that can reach two ad accounts therefore still cannot read account B's
   ad sets through an account A URL.

An unknown id and a foreign one produce the identical 403, so the endpoints
cannot be used to probe for which ids exist. A dead token or a throttle keeps
its own status instead of being collapsed into 403 — the fix for those is
reconnecting or waiting, not picking a different ad set.

### Period comparison

Every insights endpoint accepts `compare=1`, which adds the previous
equivalent period: same length, ending the day before the current one starts.

The current period is anchored to the `date_start`/`date_stop` Meta stamps on
its own rows, so the comparison lines up with the account's timezone rather
than the server's. `src/dashboard/date-range.ts` only resolves presets itself
when the period returned no rows at all — which is exactly when the comparison
is most worth showing.

Deltas report absolute and percentage change. A percentage is `null` rather
than infinite when the previous value was zero, and `null` rather than zero
when only one side has a value. The response also carries `lowerIsBetter` so
the UI colours a falling CPA as an improvement without re-deriving which
metrics are costs.

Comparison is opt-in because it costs an extra Meta call against a quota shared
with the MCP tools: the drill-down tables omit it, the overview and the detail
drawer ask for it.

### Metrics

[src/dashboard/services/metrics.ts](../src/dashboard/services/metrics.ts)
derives everything server-side, under two rules:

1. **Never sum across action-type aliases.** Meta reports one conversion under
   several `action_type` strings (`omni_purchase`, `purchase`,
   `offsite_conversion.fb_pixel_purchase`, …). The first alias present in
   priority order wins; adding them double-counts. Purchase value and cost are
   read for the *same* alias the count came from.
2. **Rates are derived from the counters.** CTR, CPC and CPM come from
   spend/impressions/clicks rather than Meta's per-row fields, which are absent
   with no delivery and cannot be averaged across campaigns.

ROAS uses Meta's `purchase_roas` when present, falls back to
`purchase value / spend`, and stays `null` when neither exists — the UI then
omits the tile rather than showing a misleading `0,00x`.

Attribution matches the MCP tools: `use_unified_attribution_setting=true`.

Currency is carried per account and formatted with `Intl.NumberFormat("tr-TR")`
against the account's own code. There is no hardcoded currency symbol anywhere,
so a TRY account renders `₺` and a USD account renders `$`.

### AI assistant (Anthropic Claude)

The dashboard's assistant runs on the Anthropic Messages API. Claude is given a
bounded tool surface over the *existing* dashboard services — never raw Meta
access — and may propose changes, which are staged for an explicit user
confirmation before anything reaches Meta.

```
Browser ── POST /api/dashboard/accounts/:id/ai/chat ──▶ router
                                                        │ session + account authz
                                                        │ same-origin + 32 KB body cap
                                                        │ per-user AI limiter (15 / 10 min)
                                                        ▼
                                             src/claude/agent.ts   (bounded loop)
                                                        ▼
                                             src/claude/tools.ts   (Zod-validated verbs)
                                                        ▼
                              dashboard/services/  (the SAME ones the tables use)
                              accounts · campaigns · entities · entity-insights · metrics
                                                        ▼
                                             src/meta/client.ts → graph.facebook.com
```

Gemini remains in the repository for the `ads_analyze_video` MCP tool, which is
a separate feature with its own per-tenant key. Nothing in the dashboard uses
it any more.

#### Configuration

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Required. Server-side only; never sent to the browser, never logged, never in a tool result. |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-opus-5`; only `claude-*` ids are accepted, anything else falls back to the default. |
| `DASHBOARD_AI_WRITES` | Optional operator kill switch. `off` runs the assistant read-only — the write tools are not even declared to the model. |

Unlike the Gemini video key, this is a property of the *server*, not of the
signed-in user, so `GET /ai/status` reports `configured`, `available`,
`rateLimited`, `unavailable` and `model` — and never any part of the key.

The agent uses adaptive thinking at `medium` effort: it runs inside a browser
request where someone is watching a spinner, and the reasoning is over numbers
the server already aggregated.

#### Tools

Nine read tools and six write tools, all defined in
[src/claude/tools.ts](../src/claude/tools.ts) with a Zod schema that is both the
JSON Schema Claude sees and the validator its arguments are parsed with, so the
two can never drift.

| Read | Write (proposes only) |
|---|---|
| `meta_list_ad_accounts` | `meta_create_campaign` |
| `meta_get_campaigns` | `meta_update_campaign` |
| `meta_get_ad_sets` | `meta_create_ad_set` |
| `meta_get_ads` | `meta_update_ad_set` |
| `meta_get_insights` | `meta_create_ad` |
| `meta_compare_periods` | `meta_update_ad` |
| `meta_get_campaign_detail` | |
| `meta_get_ad_set_detail` | |
| `meta_get_ad_detail` | |

Pausing and activating go through the `*_update_*` tools' `status` field rather
than separate status tools — one fewer tool for the model to choose between,
and the same confirmation either way.

The system prompt carries a routing table mapping each question the UI suggests
to the single tool that answers it — "hangi kampanya para kaybettiriyor" to
`meta_get_campaigns`, "hangi reklamları kapatmalıyım" to `meta_get_ads` with no
parent, "ne değişti" to `meta_compare_periods` — and tells the model to drill
into one campaign or ad set only after an account-wide read has shown which one
is worth opening. Most of the dashboard's own example questions are one call.

An identical read asked for twice in the same turn is refused without running:
the first result is still in the conversation, so the repeat costs no Meta call,
no context and no tool-budget slot (the slot is refunded). Models do re-ask when
a turn runs long, and this is the cheapest possible correction.

`meta_get_ad_sets` and `meta_get_ads` read the **whole account** when the parent
id is omitted, and one parent when it is given. That is what makes "hangi
reklamı kapatmalıyım?" answerable: finding the worst ad by walking campaign →
ad set → ad is one call per parent, which exhausts the agent's tool budget on
any real account before it has seen anything. Rows carry their parent names, so
a mixed account-wide list still reads as "X kampanyasındaki Y reklam seti".

Claude never names a Graph path, a field list, a date parameter or a targeting
object. Ad set targeting is assembled from enumerated arguments (ISO country
codes, an age range, a gender) so no part of a user's prompt is ever
interpolated into a Meta parameter.

#### Bounds

An unbounded agent loop against a paid API that shares a Meta quota is the
failure mode that costs real money, so the loop is capped five independent ways:

- 6 model round-trips per question, 12 tool executions across all of them.
- 12 KB per tool result and 60 KB across a turn; a row-bearing result loses rows
  rather than being cut mid-JSON.
- 15 rows per read tool by default, 40 at most.
- **120 s of wall clock per turn.** Six round-trips at the client's own 90 s
  timeout is nine minutes — long past the point where the browser and Cloud
  Run's request timeout have given up while the server keeps spending. Each step
  is given only what is left of the budget, and a turn that runs out returns
  `stopReason: "timeout"` with a Turkish "narrow the question" message.
- One proposed write per turn; a second is refused with a code the model reads.

A reply that hits the output ceiling (`stop_reason: "max_tokens"`) is not
handed over as if it were complete: the answer carries an explicit Turkish note
saying it was cut short.

Conversation history comes from the browser as plain text only — never tool
blocks — capped at 10 turns of 2 000 characters. A forged assistant turn buys
nothing: it carries no authority, and every tool call is re-validated and
re-authorized server-side regardless of what the history claims.

#### The optimization pass

[src/claude/decision-engine.ts](../src/claude/decision-engine.ts) is a pure
module — no Meta client, no cache, no I/O — that takes the rows a level already
returned, plus the same rows for the previous equivalent period, and returns
what is worth acting on. `meta_find_opportunities` is the tool around it.

It exists so the decisions are not the model's to make. A model asked to eyeball
forty rows will eventually compare a null against a number or invent a ranking;
the engine emits a `Finding` carrying `evidence`, `action`, `goal`, `risk`,
`metrics`, `writeTool` and `priorityBasis`, and the model's remaining job is to
say it in Turkish. Three rules hold throughout:

- **`null` is never zero.** A signal needing a metric Meta did not return is not
  emitted at all, and `metricsMissingOnEveryRow` names the empty columns.
- **Thresholds come from the account.** "Low ROAS" is low against what the rest
  of this account did in the same window; "spent with nothing to show" means it
  spent more than one conversion costs here. The only hand-set number is the 20%
  that makes a trend a trend, and it is one named constant.
- **Ranking is spend at stake**, never a composite score — a score is an opinion
  dressed as arithmetic and cannot be explained to the person whose budget moves.

Budget recommendations respect where the budget lives: `budgetOwner` is
`campaign` for a CBO ad set, and the finding then carries no `writeTool` and an
action that says to ask the user first. A paused object is reported as an
observation and sorted below everything actionable, so "spend more here" can
never land on something that is not running.

#### Writes require a confirmation

A write tool does not write. It validates its arguments, authorizes the target
through the same gates the drill-down uses, builds the exact form body, and
stages it in [src/claude/confirmations.ts](../src/claude/confirmations.ts). What
the browser receives is a description — "Günlük bütçe / 2.000,00 TRY" — and an
opaque id.

The dialog is built to answer four questions before the user commits: **what
changes** (the title and the object's name), **from what to what** (each field
carries the previous value inline — "2.000,00 TRY (önce 250,00 TRY)"), **why**
(`reason`, a required argument on every write tool, so a change can never be
proposed with no argument behind it), and **for how long the approval is good**
(the ten-minute window, rendered as "Bu onay ~9 dakika geçerli"). `reason` is
model-authored text, so it is sanitized into a single line on the way into the
plan and rendered as plain text.

```
Claude proposes ──▶ staged server-side (10 min, single use, owner-bound)
                          │
              browser gets a description + an id
                          │
      user presses ONAYLA ──▶ POST /ai/confirm { confirmationId }
                          │
              plan is claimed, sent to Meta, then the object is RE-READ
```

That indirection is the point. The parameters never leave the server, so an
approval cannot carry different values than the ones the user was shown. The
claim is single-use (a replayed approval writes nothing), bound to the session
and ad account that staged it (another user's id is reported as "not found", so
it cannot be probed), and expires after ten minutes.

After the write, the object is read back from Meta and the response reports
what Meta *stored* — a budget Meta clamped, a status that landed as
`WITH_ISSUES`. If the read-back fails the response says so rather than claiming
an unobserved result.

`POST /mcp` and the MCP tools are untouched: the dashboard's Claude engine talks
to the Meta service layer directly, server-side.

#### Cost and observability

The system prompt and the tool schemas are ~11 KB of byte-identical prefix
re-sent on every step of every turn, which in production is the dominant cost of
running the assistant. One `cache_control` breakpoint at the end of the system
prompt covers both (render order is tools → system → messages), so repeat turns
read the prefix from cache instead of paying for it.

That only works while the prefix stays stable, which is why
`buildSystemPrompt` takes the account and the calendar date and nothing else —
a timestamp or a request id in there would silently destroy the hit rate. A test
pins that it is byte-identical across calls, and
`usage.cache_read_input_tokens` is logged on every request so a regression is
visible rather than merely expensive.

Two log lines carry the operational picture:

| Event | Fields |
|---|---|
| `claude_request` | model, stop reason, input/output tokens, cache read and write tokens |
| `claude_agent_turn` | stop reason, steps, tool calls, elapsed ms, truncated, aggregated tokens |

Neither logs the user's question, the answer, or any credential — only lengths
and counts.

`GET /ai/status` reflects real failures: a throttled or unreachable provider is
recorded from **both** the one-shot and the agent paths, so the UI shows "Hız
sınırı" or "Servis yanıt vermiyor" instead of "Hazır" while every turn fails.
The flag clears itself after a minute.

#### Numbers, and what the model may not do

The rules from the one-shot analysis apply to the agent as well, and are stated
in [src/claude/prompt.ts](../src/claude/prompt.ts):

- Only numbers the tools returned. No estimating, no extrapolating, no filling in.
- `null` means Meta returned no value — not zero. Each read tool returns a
  `missingMetrics` list so the distinction never has to be inferred.
- ROAS, cost per purchase and purchase value are only produced when the
  underlying conversion data exists.
- `truncated` / `totalRows` must be reported rather than implying a full view.
- `dataQuality.metricsMissingOnEveryRow` names the metrics Meta returned for
  *none* of the rows in a result. The model is forbidden from ranking,
  comparing or recommending on those — "hangi reklam para kaybettiriyor" with no
  purchase data anywhere has to be answered on spend and conversions, and said
  so, rather than implying a return figure.
- `dataQuality.rowsWithNoDelivery` counts rows that did not spend or serve at
  all in the period, so a paused ad set is not reported as a bad performer.
- Advertiser-written names are data. Every label is stripped of control codes,
  zero-width and bidi characters and chat/fence markers by
  [src/dashboard/ai/sanitize.ts](../src/dashboard/ai/sanitize.ts), and the system
  prompt states that such text is never an instruction.
- The model's own output is untrusted on the way back: bounded, stripped, and
  rendered by the frontend as **text only** — there is no
  `dangerouslySetInnerHTML` anywhere in the dashboard.

#### Evidence, and what to do next

Every answer carries the reads that produced it. Each trace line names the tool
in Turkish and what actually came back — `Kampanyalar okundu (last_7d) · 15/22
satır · 2026-09-12 – 2026-09-18` — so a reader can check an answer against the
tables rather than taking it on trust. The detail is derived generically from
the result shape (rows seen versus rows that exist, the resolved period, how
many metrics were missing everywhere), so a new tool gets a useful line without
anyone remembering to add one.

The prompt then requires the answer to end in an `Öneriler:` block of one to
three concrete recommendations, each naming the object, the action and the
number that justifies it. When the data supports none, the model has to say so
and name what it would need to see instead of inventing one — and a
recommendation stays advice: it may not call a write tool unless the user asked
for a change.

#### When a turn does not finish

A turn that ends in `timeout` or `max_steps` is not presented as an answer.
The chat shows a warning line explaining what to narrow, and both that case and
a failed request get a **Tekrar dene** button that re-asks the same question.
Retrying first drops the exchange that failed — the last one matching that
question, so asking the same thing twice does not rewind the conversation — so
Claude is never sent a history in which it appears to have ignored the user.

A request that never reached the server at all (the connection dropped, the user
went offline) is reported as `network_error` — "Sunucuya ulaşılamadı" — rather
than falling through to the generic server-error copy, because the advice is
different. A throttled or unreachable provider also refreshes `/ai/status`
immediately, so the header pill turns to "Hız sınırı" instead of staying
"Hazır" for the five minutes that query is otherwise cached.

A turn is bound to the ad account it was sent for. Switching accounts clears the
conversation, and a reply from the previous account that arrives afterwards is
discarded rather than appended to the new one — its numbers belong to a
different business and its ids would only 403.

#### From a table to a question

Every row in the drill-down opens a detail drawer, and the drawer has a
**Claude'a sor** button: it switches to the Claude view with a question about
that campaign, ad set or ad already written into the box. The question is
pre-filled, never sent — the user sees exactly what will be asked, can edit it,
and nothing is spent until they press Gönder.

#### One-shot analysis

`POST /ai/ask` and `POST /ai/summary` predate the agent and still work. They
send a single bounded snapshot built by
[src/dashboard/ai/context.ts](../src/dashboard/ai/context.ts) — no tools, no
loop, no identifiers — and return prose. They now run on Claude too.

### Caching

[src/dashboard/cache.ts](../src/dashboard/cache.ts) is a small in-memory TTL
cache keyed by `fbUserId | tokenHash | endpoint | params`. Concurrent identical
requests share one Meta call, and failures are never cached. Per instance, like
every other limiter here, so the hit rate scales down with instance count.

A confirmed write invalidates the whole `fbUserId | tokenHash |` prefix before
it answers (`invalidateTenantCache`). Without that, the 60-second campaign TTL
outlives the write, and the chat turn the user takes next — "oldu mu?" — is
answered from rows read before it: the confirmation reports the new budget
while the next read still reports the old one. Invalidation is tenant-wide
rather than per object because one budget change moves the campaign list, the
rows underneath it and every insights window covering it, across endpoints and
date ranges. Only a successful write invalidates; if Meta refused it, nothing
changed and the rows are still good.

## API

All routes are under `/api/dashboard`, all require the session cookie, and all
send `Cache-Control: no-store` + `Vary: Cookie`.

| Route | Purpose |
|---|---|
| `GET /session` | Signed-in user and Meta connection state. Works without a Meta token so the reconnect state can render. |
| `GET /accounts` | Ad accounts the connected token can reach. |
| `GET /accounts/:accountId/insights` | Account KPIs plus a daily series. |
| `GET /accounts/:accountId/campaigns` | Campaign metadata merged with campaign-level insights. |
| `GET /accounts/:accountId/campaigns/:campaignId/adsets` | Ad sets of one campaign, with metrics. |
| `GET /accounts/:accountId/adsets/:adsetId/ads` | Ads of one ad set, with metrics and creative id. |
| `GET /accounts/:accountId/campaigns/:campaignId/insights` | Campaign detail: summary, series, comparison. |
| `GET /accounts/:accountId/adsets/:adsetId/insights` | Ad set detail. |
| `GET /accounts/:accountId/ads/:adId/insights` | Ad detail. |
| `GET /ai/status` | Whether Claude is configured on this server, its health and its model. Never returns the key. |
| `POST /accounts/:accountId/ai/chat` | One agent turn: Claude reads what it needs and answers, or proposes a change. |
| `POST /accounts/:accountId/ai/confirm` | Approves (`decision: "approve"`) or discards (`"cancel"`) a proposed change. The only dashboard route that writes to Meta. |
| `POST /accounts/:accountId/ai/ask` | One-shot analysis: answers a question about the account, a campaign or an ad set. |
| `POST /accounts/:accountId/ai/summary` | The same one-shot analysis with no question asked. |

The AI routes are POSTs because the question is user text that does not belong
in a URL, an access log or the browser history, and because POST puts it behind
the same-origin check.

- `/ai/chat` takes `message` (≤ 500 characters), an optional `history` of at
  most 20 plain-text turns, and an optional `allowWrites`.
- `/ai/confirm` takes `confirmationId` and `decision`. Nothing else — the
  parameters live server-side.
- `/ai/ask` and `/ai/summary` take `question`, the usual range parameters,
  `level` (`account` | `campaign` | `adset`) and `entityId`.

Ceilings: 32 KB body, 15 AI turns and 10 confirmations per user per 10 minutes,
on top of the 120/minute dashboard limiter.

Range parameters: `preset` (`today`, `yesterday`, `last_7d`, `last_14d`,
`last_30d`, `this_month`, `last_month`, `custom`) and, for `custom`, `since` and
`until` as `YYYY-MM-DD`. Presets are passed through to Meta as `date_preset` so
the range resolves in the ad account's own timezone. `campaigns` also accepts
`status` and `q`, as do the two drill-down list endpoints. Insights endpoints
accept `compare=1`.

Error envelope: `{"error":{"code":"<machine code>","message":"<fallback>"}}`.
The codes are language-agnostic; the Turkish copy lives in
[web/src/lib/labels.ts](../web/src/lib/labels.ts).

## Verifying the Anthropic integration

`npm test` never calls Anthropic. To check a real key end to end:

```bash
npm run build
ANTHROPIC_API_KEY=sk-ant-... npm run claude:verify
```

[scripts/verify-claude.mjs](../scripts/verify-claude.mjs) is the only thing in
the repository that makes a live call, and only when a human runs it. With no
key it exits before building a request rather than pretending to have made one.

It makes two real calls and checks, in order: the key is accepted and the
configured model is reachable; the real system prompt and the real tool schemas
are accepted (a malformed schema fails here rather than in front of a user); the
model actually reaches for a tool; a tool result fed back produces a Turkish
answer; and prompt caching is working (`cache_read_input_tokens > 0` on the
second call).

It does **not** touch Meta — a CLI has no signed-in user and therefore no Meta
token, so the tool result it feeds back is a clearly-labelled stub. Every Claude
response is real; only the ad numbers are synthetic, and the script says so
wherever it prints them. It also asserts the answer does not state a ROAS
figure, because the stub deliberately has none.

## Development

```bash
npm run web:install   # once, installs the frontend workspace
npm run dev:all       # Express on :3000 + Vite on :5173
```

Open **http://localhost:5173/dashboard/**.

Vite serves `/dashboard` itself (that is what `base` does) and proxies `/api`,
`/auth` and `/authorize` to `:3000`, so the browser only ever talks to one
origin and the `SameSite=Lax` session cookie attaches to every request.
`/dashboard` is deliberately *not* proxied — handing it to Express would break
hot reload.

The dev server needs the same env the multi-tenant server always needs:
`META_APP_ID`, `META_APP_SECRET`, `TOKEN_ENCRYPTION_KEY`,
`SESSION_COOKIE_SECRET`, `OAUTH_SECRET` and at least one `AUTH_ALLOWED_*` entry.
Without Firestore configured, sessions and tokens are in memory and lost on
restart.

To run the production bundle locally:

```bash
npm run build && npm run web:build && npm start
# then http://localhost:3000/dashboard
```

The static handler looks for `dist/public/` (the container layout) and falls
back to `web/dist/`, so no copy step is needed locally.

## Production

The frontend ships inside the existing image and the existing Cloud Run
service — no second service, no CDN. The Dockerfile builds `web/` in its own
stage and copies the result to `dist/public/`.

- Hashed assets: `Cache-Control: public, max-age=31536000, immutable`.
- Shell: `no-store`, so a deploy takes effect immediately.
- CSP: `script-src 'self'` with no `unsafe-inline` or `unsafe-eval`.

**Never prefix a secret with `VITE_`.** Vite inlines any `VITE_`-prefixed env
var into the shipped bundle, and this repository is public.

### Deployment environment

Everything the service reads at runtime, and where it comes from. Nothing in
this table is ever sent to the browser.

**Required — the service refuses to start in production without these.**

| Variable | Source in [deploy.yml](../.github/workflows/deploy.yml) | Purpose |
|---|---|---|
| `SERVER_URL` | env var, from `secrets.SERVER_URL` | Public https URL. Builds the Meta OAuth redirect; must be https and a real host in production. |
| `META_APP_ID` | env var, from `secrets.META_APP_ID` | Facebook app id. Its presence is what turns multi-tenant mode on. |
| `META_APP_SECRET` | Secret Manager `meta-app-secret` | Facebook app secret. |
| `TOKEN_ENCRYPTION_KEY` | Secret Manager `token-encryption-key` | AES-256-GCM key for Meta tokens at rest. 64 hex characters. |
| `SESSION_COOKIE_SECRET` | Secret Manager `session-cookie-secret` | Signs the browser session cookie. ≥ 32 characters. |
| `OAUTH_SECRET` | Secret Manager `oauth-secret` | Signs MCP OAuth JWTs. ≥ 32 characters. |
| `AUTH_ALLOWED_EMAILS` / `_DOMAINS` / `_FB_USER_IDS` | env vars | At least one must be non-empty, or no one can complete Meta login. |
| `FIRESTORE_PROJECT_ID` | env var | Where encrypted tokens live. Required in production. |
| `NODE_ENV=production` | env var, literal | Enables the https redirect and HSTS. |

**Dashboard AI — required for the Claude panel to do anything.**

| Variable | Source | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret Manager `anthropic-api-key` | The only credential the assistant uses. Server-side only: it is read in [src/claude/client.ts](../src/claude/client.ts) and appears in no response, log line or tool result. |
| `ANTHROPIC_MODEL` | env var, optional | Defaults to `claude-opus-5`. Only `claude-*` ids are accepted; anything else silently falls back to the default. |
| `DASHBOARD_AI_WRITES` | env var, optional | `off` runs the assistant read-only — the write tools are not declared to the model at all. Any other value (including empty) leaves them available, still behind the confirmation dialog. |

Without `ANTHROPIC_API_KEY` the service starts normally and the panel shows
"Claude AI yapılandırılmamış". That is a supported state, not a failure: the
deploy provisions the Secret Manager entry with a placeholder so the mapping
always resolves, and the panel starts working the moment a real key replaces it.

**Optional, already wired:** `META_API_VERSION`, `LOG_LEVEL`, `NODE_OPTIONS`,
`VIDEO_MAX_CONCURRENT_JOBS`, `GEMINI_ANALYSES_PER_TENANT_PER_HOUR`,
`META_TOKENS`, `MCP_API_KEY`.

#### Adding the Anthropic key

The workflow syncs the GitHub Actions secret into Secret Manager on every
deploy, creating the secret and the IAM binding on first run and adding a new
version only when the value actually changed. So the whole procedure is:

1. Add `ANTHROPIC_API_KEY` to the repository's GitHub Actions secrets.
2. Push to `main` (or re-run the deploy workflow).

To set it without a deploy:

```bash
printf '%s' "sk-ant-..." | gcloud secrets versions add anthropic-api-key \
  --data-file=- --project="$GCP_PROJECT_ID"
gcloud run services update meta-ads-mcp --region="$GCP_REGION"   # pick up the new version
```

#### Cloud Run shape

`--memory=2Gi --cpu=2 --concurrency=40 --timeout=300 --min-instances=0
--max-instances=10 --execution-environment=gen2`.

Two consequences worth knowing:

- **A whole Claude turn fits inside the request timeout.** The agent's own
  ceiling is 120 s against Cloud Run's 300 s, so a long turn returns a real
  answer (or a `timeout` stop reason) rather than a dropped connection. A test
  pins that relationship.
- **Every limiter and cache is per instance.** With concurrency 40 and up to 10
  instances, the 15-AI-turns-per-10-minutes ceiling is per instance, so the
  effective ceiling is up to ten times that. The staged-write store is per
  instance too — see Known limitations.

`/health` is the one path exempt from the production https redirect: container
health probes reach the port directly, with no proxy and therefore no
`x-forwarded-proto`, and a 301 would make a healthy instance look dead. It
carries no cookie, credential or user data; every other path, the dashboard and
OAuth surface included, still redirects.

`--min-instances=0` means cold starts are normal. The container opens its port
after an ffmpeg capability probe that is given at most 10 s, and `/health`
answers from a cached result afterwards rather than spawning a process per
request.

## Known limitations

- The assistant works on one ad account at a time and has no cross-account view.
- Conversation history lives in the browser tab: reloading the page or switching
  ad accounts clears it.
- Staged confirmations are in memory and per instance, so a deploy or an
  instance change between proposing and approving loses the proposal. Nothing
  has been sent to Meta at that point; the user asks again.
- Ad set creation exposes country, age and gender targeting only. Detailed
  targeting, custom audiences and creative uploads stay in Ads Manager or the
  MCP tools.
- `meta_create_ad` needs an existing creative id; the assistant does not upload
  media.
- Navigation state is in memory: there is no URL deep-linking, so the browser
  back button leaves the dashboard rather than stepping back up the hierarchy.
- The drill-down lists up to 500 ad sets per campaign and 500 ads per ad set.
- The per-user rate limiter and the cache are per instance, so both ceilings
  multiply by the running instance count.
- The dashboard shares one Meta quota with the MCP tools: a tripped circuit
  breaker affects both.
- Aggregation across accounts with different currencies is not attempted; the
  account selector is single-select.
- Account authorization reads up to 1000 accounts from `/me/adaccounts`. Beyond
  that the failure is safe (deny), not a leak.
