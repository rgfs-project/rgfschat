# Architecture

The authoritative specification is the project contract (`00-contracts.md`), which is
maintained **outside this repository** alongside the phase prompts that drive the build.
This document records what is **actually built** and where each invariant is enforced.
If this file and the contract disagree, the contract wins and the discrepancy is a bug.

Current state: **Phase 12 complete.**

## 1. Process shape

One Node process serves the API. The client is a separate static bundle, served by Vite in
development and from `dist/client` by any static host in production. There is no runtime
coupling between them beyond `/api`.

```text
client/main.tsx ──▶ client/App.tsx ──▶ client/api.ts ──┐
                                                        │  fetch /api/*
                                          (Vite proxy)   │
server/index.ts ──▶ server/app.ts ──────────────────────┘
                      ├── express.json({ limit })
                      ├── /api  → routes/health.ts
                      ├── /api  → routes/generations.ts ──▶ GenerationManager ──▶ Provider
                      ├── notFoundHandler()
                      └── errorHandler(logger)     ← the single error boundary
```

`server/index.ts` is the only module that reads the environment, owns the listener, and
installs signal handlers. `server/app.ts` is pure construction, which is what makes the app
testable with Supertest without binding a port.

## 2. Layers

| Directory  | Responsibility                         | May import        |
| ---------- | -------------------------------------- | ----------------- |
| `shared/`  | Types and constants used by both sides | nothing           |
| `server/`  | HTTP, config, logging, errors          | `@shared/*`       |
| `client/`  | React UI                               | `@shared/*`       |
| `scripts/` | Build and verification tooling         | nothing app-level |

`@shared/*` resolves through three independent mechanisms that must stay in sync:
`tsconfig.json` `paths` (typecheck), `vite.config.ts` `resolve.alias` (client build),
`vitest.config.ts` `resolve.alias` (tests), and esbuild's `tsconfig` option
(`scripts/build-server.mjs`, server build). The server bundle resolves the alias at build
time, so the shipped JavaScript needs no runtime path mapping.

## 3. Error handling

`AppError` is the only error type thrown deliberately. `errorHandler` translates a small set
of known infrastructure errors (body-parser's `entity.too.large`, `entity.parse.failed`) into
canonical codes, and maps everything else to `INTERNAL` with a fixed message.

Error codes in use (the subset of the contracts §5 table reached so far):

| Code                     | HTTP | Raised by                                       |
| ------------------------ | ---- | ----------------------------------------------- |
| `VALIDATION`             | 400  | schema failure, malformed JSON                  |
| `NOT_FOUND`              | 404  | unmatched route                                 |
| `PAYLOAD_TOO_LARGE`      | 413  | body over `JSON_BODY_LIMIT` (100 kb)            |
| `INTERNAL`               | 500  | anything unhandled                              |
| `PROVIDER_UNAVAILABLE`   | 502  | upstream unreachable                            |
| `PROVIDER_ERROR`         | 502  | upstream rejected, failed, or returned nonsense |
| `PROVIDER_TIMEOUT`       | 504  | upstream exceeded `PROVIDER_TIMEOUT_MS`         |
| `MODEL_NOT_FOUND`        | 400  | model absent from the discovered list           |
| `GENERATION_NOT_FOUND`   | 404  | unknown generation id                           |
| `CONVERSATION_MALFORMED` | 422  | a conversation file that cannot be parsed       |
| `GENERATION_IN_PROGRESS` | 409  | a second send for the same conversation         |
| `CONTEXT_TOO_LARGE`      | 422  | the prompt cannot fit the model's context       |
| `UNAUTHENTICATED`        | 401  | no valid session                                |
| `FORBIDDEN`              | 403  | authenticated but not permitted                 |
| `CSRF_INVALID`           | 403  | missing/invalid CSRF token or cross-origin      |
| `CONFLICT`               | 409  | username already taken                          |
| `REGISTRATION_CLOSED`    | 403  | registration is not open                        |
| `PROVIDER_NOT_FOUND`     | 400  | provider id is not configured                   |
| `ENDPOINT_NOT_ALLOWED`   | 400  | provider endpoint rejected by SSRF policy       |

Express 5 forwards rejected promises from async handlers to the error middleware natively, so
there is no `asyncHandler` wrapper anywhere in the codebase.

## 4. Configuration and logging

`loadConfig` validates the environment once with Zod and throws a message listing offending
keys **without their values**, so a mistyped secret cannot land in a boot log or a crash
report. `createLogger` emits structured JSON and redacts any field whose name matches a
secret-like pattern (`authorization`, `cookie`, `password`, `token`, `apikey`, `secret`,
`session`, `csrf`, …) at any depth. Nothing in Phase 1 handles a secret; the redaction list
exists so later phases inherit it rather than adding it after a leak.

## 4a. Provider (Phase 2)

`Provider` (`server/provider/types.ts`) is deliberately minimal — list models,
stream a chat completion, report a context length — so Phase 5 can add providers
behind it without reshaping generation. `LlamaCppProvider` is the only
implementation and is written against `docs/provider-notes.md`, which records
what a **live** server does rather than what the OpenAI spec implies.

Three observed behaviours shape the code and are covered by tests:

- `delta.content` arrives as `null`, and the final chunk has `choices: []`. Both
  are guarded; the mock provider reproduces both so a regression fails a test.
- `/v1/models` entries embed the upstream command line, including
  `--api-key-file`. `listModels` maps to a three-field DTO and discards the
  rest; nothing else may forward a provider payload (INV-04).
- Probing `/props?model=X` **loads** that model on a router-mode server. Context
  lengths are therefore never warmed eagerly — `contextLength()` returns `null`
  until a value is known, and `DEFAULT_CONTEXT_TOKENS` applies.

Upstream errors are classified and re-thrown as `AppError`; the upstream
`message` is read only to classify and never propagated.

## 4b. Generation lifecycle (Phase 2)

```text
        POST /api/generations
                 │  ids minted, 202 returned immediately
                 ▼
             pending ──────► streaming ──────► completed
                 │               │        └──► cancelled
                 └───────────────┴────────┬──► failed
                                          └──► timed_out
```

Generation is **server-owned**: `manager.start()` returns as soon as the ids
exist and the provider call runs detached. Observation and control are separate
channels — SSE only observes; only `POST /cancel`, a provider failure, a
timeout, or completion ends a generation (INV-06).

`#finish()` is the single guarded transition into a terminal state. Every path
funnels through it, the first arrival wins, and chunks arriving afterwards are
dropped rather than reopening the record (INV-05). `cancel()` transitions
_before_ aborting, so a synchronous unwind cannot double-report.

State is in memory only, capped and evicted by TTL. Phase 6 makes it durable and
adds replay; losing it today fails in-flight generations but nothing persisted.

### SSE conventions

`GET /api/generations/:id/stream` sends `text/event-stream`, `no-cache,
no-transform`, `X-Accel-Buffering: no`, never compressed, with a `: ping`
heartbeat every 10 s (contracts §5 require ≤ 15 s). Every event carries a
monotonically increasing `id` and a named `event`.

The stream opens with a full `snapshot` and then live deltas, so a reconnecting
client resumes without gaps. Per-event replay from `Last-Event-ID` is Phase 6.
An unknown id 404s as JSON _before_ any SSE header is written, so a failure is
never disguised as an empty stream.

`content` and `reasoning` are separate event types and separate fields
throughout. Reasoning is never sent back to the model (contracts §4).

## 4c. Security review (Phase 12)

The full review — controls, the tests backing each, the exception register, and the backup and
restore procedure — is in [`SECURITY.md`](SECURITY.md). It is a separate file because it is
read by a different person at a different time: an operator deciding whether to run this, not
someone changing the code.

Two things found by that review are worth recording here, because both were architectural
rather than local:

- **The auth router is mounted before the global `requireAuth` + `requireCsrf` gate**, because
  login and registration must be reachable without a session. That placement silently exempted
  the _authenticated_ routes in the same router — `logout` and `password` — from CSRF. They now
  require the token per route rather than relying on a gate they sit above.
- **Two limits were missing entirely** for input this process accepts but does not control: an
  image's declared dimensions (a hundred-byte PNG can claim 60000x60000) and a provider's
  response length. Both are now bounded; see §13 and `provider/llamacpp.ts`.

Enumerated tests drive from the real router and from `StoragePaths` itself rather than from
hand-written lists, so a route or a path constructor added later is covered the moment it
exists. That is the property worth having: the failure being guarded against is not a hole in
reviewed code, but one added afterwards by someone who did not know to update a list.

## 5. Invariant register

Every invariant is enforced in code and covered by at least one test whose title names it.

Phase 10 added no invariant. It changes only how the existing application is presented — no
new boundary, no new authority, nothing a server route can be made to get wrong — and an
invariant that only a stylesheet can break is not one this register is for. Its guarantees
are layout, and they are asserted as layout in `e2e/mobile.spec.ts`.

| ID     | Invariant                                                                                                       | Phase | Enforced in                                                         | Tests                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| INV-01 | Every API error uses the canonical error contract; unhandled errors become `INTERNAL` with no internals exposed | 1     | `server/middleware/errorHandler.ts`                                 | `server/middleware/errorHandler.test.ts`                                  |
| INV-02 | Every request body is schema-validated and unknown fields are rejected                                          | 1     | `server/http/validate.ts` (`z.strictObject`)                        | `server/http/validate.test.ts`                                            |
| INV-03 | Responses are explicit DTOs; no secrets, hashes, paths, or upstream bodies in any response                      | 1     | `server/routes/health.ts`, `shared/api.ts`, `errorBody()`           | `server/routes/health.test.ts`, `server/http/validate.test.ts`            |
| INV-04 | Provider credentials and raw provider payloads never reach the browser                                          | 2     | `server/provider/llamacpp.ts` (`listModels` DTO mapping)            | `server/provider/llamacpp.test.ts`, `server/routes/generations.test.ts`   |
| INV-05 | A generation reaches exactly one terminal state                                                                 | 2     | `server/generation/manager.ts` (`#finish`)                          | `server/generation/manager.test.ts`                                       |
| INV-06 | Closing an SSE connection never cancels a generation                                                            | 2     | `server/routes/generations.ts` (`cleanup` only unsubscribes)        | `server/generation/manager.test.ts`, `server/routes/generations.test.ts`  |
| INV-07 | The assistant message is written to canonical storage exactly once per generation                               | 3     | `server/generation/service.ts` (`#persistOnTerminal`)               | `server/storage/persistence.test.ts`                                      |
| INV-08 | The user message is durable before `202` is returned                                                            | 3     | `server/generation/service.ts` (`start`, under the lock)            | `server/storage/persistence.test.ts`                                      |
| INV-09 | `formatVersion: 1` round-trips exactly                                                                          | 3     | `server/storage/markdown.ts`                                        | `server/storage/markdown.test.ts`                                         |
| INV-10 | Malformed conversations are never modified and never break other conversations                                  | 3     | `server/storage/conversations.ts`                                   | `server/storage/storage.test.ts`, `server/storage/persistence.test.ts`    |
| INV-11 | The index is derived: deleting it and restarting loses nothing                                                  | 3     | `server/storage/index.ts`                                           | `server/storage/persistence.test.ts`                                      |
| INV-12 | No filesystem path contains request-controlled input; all paths stay inside `DATA_DIR`                          | 3     | `server/storage/paths.ts`                                           | `server/storage/storage.test.ts`                                          |
| INV-13 | At most one non-terminal generation per conversation                                                            | 3     | `server/generation/service.ts` (`#active` under the lock)           | `server/storage/persistence.test.ts`                                      |
| INV-14 | Identity comes only from server-side state                                                                      | 3     | `server/auth/middleware.ts`; `ownerOf(req)` reads only `req.auth`   | `server/storage/persistence.test.ts`                                      |
| INV-15 | A user can never read, modify, delete, or observe another user's resources (404)                                | 4     | `server/auth/middleware.ts` + `userId` args through storage         | `server/auth/auth.test.ts`                                                |
| INV-16 | Every state-changing route requires a valid CSRF token or same-origin check                                     | 4     | `server/auth/middleware.ts` (`requireCsrf`, `requireSameOrigin`)    | `server/auth/auth.test.ts`                                                |
| INV-17 | Reducing a user's privileges or disabling them revokes all their sessions                                       | 4     | `server/auth/middleware.ts` (record loaded per request)             | `server/auth/auth.test.ts`                                                |
| INV-18 | Only server-validated `(providerId, modelId)` pairs are ever sent to a provider                                 | 5     | `server/provider/hub.ts` + `catalog.requireModel`                   | `server/provider/providers.test.ts`, `server/storage/persistence.test.ts` |
| INV-19 | Every provider endpoint passes SSRF validation on create/edit and at request time                               | 5     | `server/provider/ssrf.ts`                                           | `server/provider/ssrf.test.ts`                                            |
| INV-20 | SSE replay never silently skips events; a too-old `Last-Event-ID` triggers a full resync                        | 6     | `server/generation/manager.ts` (`catchUp`)                          | `server/generation/streaming.test.ts`, `e2e/streaming.spec.ts`            |
| INV-21 | After a restart, no generation remains non-terminal, and partial output is persisted once                       | 6     | `server/generation/recovery.ts`                                     | `server/generation/streaming.test.ts`                                     |
| INV-22 | Rendered Markdown never executes script or raw HTML                                                             | 7     | `client/Markdown.tsx` (`skipHtml`, no `rehype-raw`, `safeUrl`)      | `client/Markdown.test.tsx`                                                |
| INV-23 | A stale response never overwrites newer client state                                                            | 8     | `client/queries.ts` (per-id keys + `AbortSignal`)                   | `client/state.test.tsx`, `e2e/state.spec.ts`                              |
| INV-24 | Admin authorization is enforced server-side on every admin route                                                | 9     | `server/auth/middleware.ts` (`requireAdmin`)                        | `server/routes/admin.test.ts`                                             |
| INV-25 | Secrets are write-only: no API response ever contains a configured secret                                       | 9     | `server/routes/admin.ts` (`toProviderAdminDto`)                     | `server/routes/admin.test.ts` (secret exposure sweep)                     |
| INV-26 | There is always at least one active admin                                                                       | 9     | `server/routes/admin.ts` (`assertNotLastAdmin`)                     | `server/routes/admin.test.ts`                                             |
| INV-27 | Attachment bytes are never served as executable content; media type is sniffed, not trusted                     | 11    | `server/attachments/sniff.ts`, `server/routes/attachments.ts`       | `server/attachments/sniff.test.ts`, `server/routes/attachments.test.ts`   |
| INV-28 | Attachment storage paths never derive from the uploaded filename                                                | 11    | `server/storage/paths.ts` (`attachmentDir`), `shared/attachment.ts` | `server/attachments/store.test.ts`                                        |

## 6. Storage

```text
data/<user-uuid>/chats/<conversation-uuid>.md   canonical
data/<user-uuid>/index/chats.json               derived, deletable
```

**`StoragePaths` is the only module that builds a path under `DATA_DIR`.** Two independent
defences make INV-12 hold: every segment is _validated_ (a canonical lowercase UUID, or a
known filename) rather than escaped, and every resolved path is then asserted to remain
inside the root before any syscall — so a bug in validation still cannot produce an escaping
path. Nothing outside this module joins paths.

**Atomic durable writes** (`atomic.ts`, contracts §2): temp write → `fsync` → `rename` →
`fsync` parent. The rename is atomic on POSIX, so a reader sees either the old bytes or the
new ones, never a partial file. _Windows caveat:_ directory `fsync` is unavailable and is
skipped there, and rename-over-existing differs; single-process POSIX operation is what the
durability guarantee covers.

**Startup sweep** removes only files matching the temp pattern **and** older than process
start, so a write in flight is never destroyed and nothing else can be swept by accident.

**Locking** (`locks.ts`) is in-process and keyed. Every canonical mutation, including
delete, runs under the conversation lock, so a read-modify-write cannot interleave. This is
memory, not files: **two processes sharing one `DATA_DIR` would not see each other's locks**,
which is why contracts §2 declares multi-process deployment unsupported.

Permissions are 0700 for directories and 0600 for files.

### The derived index

`index/chats.json` is a cache, never a source of truth (INV-11). It is rebuilt from the
Markdown when missing, unparseable, or left `dirty` by a crash — the dirty flag is set before
a mutation and cleared with it. `npm run index:rebuild` rebuilds on demand. A file that
cannot be parsed is listed with `malformed: true` rather than skipped, so a corrupt
conversation stays visible and deletable instead of silently vanishing.

## 7. Conversation format

`formatVersion: 1`, implemented in `server/storage/markdown.ts` to contracts §3 and frozen.
The parser returns a typed `ok | malformed` result and never throws on bad content;
filesystem failures are a separate error class. The serializer is pure, which is what makes
the §3.6 round-trip guarantee testable — it is covered by property-based tests over bodies
containing delimiter-like lines, backslashes, blank lines, tabs, and CR.

`reasoning` is modelled as a **field on the assistant message** rather than a separate
message. The contract requires a reasoning block to be immediately followed by its assistant
block, at most one per assistant; as a field those rules cannot be violated by construction,
and reasoning can never be mistaken for prompt history.

Two format properties worth knowing:

- An **empty body** is legal and emits no body lines — contracts §4 writes one for a failed
  generation, and appending a bare newline there would leave a stray blank line.
- A body line **ending in CR cannot round-trip**: CR followed by the file's LF _is_ a CRLF,
  which §3.2 requires normalising to LF. A lone CR _within_ a line survives. This is a
  property of the format, not a parser limitation.

### Generation ↔ storage

`GenerationService` binds the two. The user message is persisted before `POST
/api/generations` returns 202 (INV-08), the whole check-and-append runs under the
conversation lock so two simultaneous sends cannot both pass the in-progress check (INV-13),
and the assistant block — with its reasoning block, if any — is appended exactly once when
the generation reaches a terminal state (INV-07). Generation state is never a second message
store.

**The status enums deliberately differ.** Markdown spells success `complete` (contracts
§3.4); the in-memory generation state is `completed`. `STATUS_FOR_STATE` maps between them in
one place, so the file format stays authoritative without renaming either side.

If a conversation is deleted while its generation runs, the run finishes and its output is
discarded and logged rather than resurrecting the file.

**Prompt assembly** (`generation/prompt.ts`) reads only canonical storage: all system
messages first in file order, then user/assistant bodies in order. Reasoning is never sent
back, and assistant messages with an empty body are skipped — replaying one would teach the
model to answer with silence. Over budget, the oldest non-system messages are dropped whole;
the newest user message is never dropped, and if it alone does not fit the request fails with
`CONTEXT_TOO_LARGE` before the provider is called.

Token counts use the conservative estimate (≥1 token per 3 bytes) rather than the provider's
tokenizer: per `docs/provider-notes.md`, `/tokenize` requires a `model` and triggers a model
load on a router-mode server, so counting tokens would cost a model swap.

## 8. Authentication and sessions

`data/<user-uuid>/user.json` is the canonical account record;
`_system/users.index.json` is a derived username → id map, rebuilt from the canonical records
whenever it is missing or unusable. `passwordHash` never leaves `server/auth/users.ts` —
`toDto` is the only way an account crosses a boundary and it cannot carry the hash (INV-03).

Passwords use **Argon2id** with OWASP parameters. Tests may inject deliberately weak
parameters; the strong ones are the default, so production cannot get the weak ones by
omission. A login for a missing account still pays for a hash, so timing does not reveal
whether a username exists — and a disabled account is rejected exactly like a wrong password.

**Sessions.** A 256-bit token lives only in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in
production). Only its SHA-256 is stored, as the filename under `_system/sessions/`, so a
stolen directory yields no usable tokens. Absolute expiry is never extended; idle expiry
slides on use. The token rotates on login, which defeats fixation.

**The user record is loaded on every request**, not trusted from the session. A disabled
account or a role change therefore takes effect on the very next request rather than at the
next login (INV-17). Changing a password revokes every other session.

**Authorization** is a gate, not a per-route decoration:

```text
app.use('/api', healthRouter())            ← public
app.use(authenticate(...))                 ← resolves the session for everyone
app.use('/api', authRouter(...))           ← login/register/session/logout
app.use('/api', requireAuth(), requireCsrf())   ← everything below is protected
app.use('/api', conversationRouter(...), generationRouter(...))
```

Mounting it this way means a route added later is protected by default; forgetting to guard
it is not possible by omission. One consequence worth knowing: an unknown `/api` path returns
`401` to an anonymous caller (the gate answers first) and `404` to an authenticated one.

**Ownership** is enforced at the service boundary, not only at the route: every storage and
generation call takes a `userId` argument. Cross-user access returns `404`, never `403`, so a
probe cannot distinguish "not yours" from "does not exist" (INV-15). Generations record their
owner, so another user's stream, snapshot, and cancel all 404 too.

**Identity comes only from the session** (INV-14). `ownerOf(req)` reads `req.auth` and
nothing else, and `server/auth/identitySource.test.ts` greps every route file for a user id
taken from the body, params, query, or a header — the failure it guards against is a _future_
route, which no behavioural test would catch.

**First admin**: `npm run user:create -- --username <name> --admin`. The password is read
from a prompt or stdin and `--password` is refused outright, so it cannot leak through shell
history or the process list. `--adopt-local-data` gives the new account `LOCAL_USER_ID` as
its id, so an existing Phase 3 `data/<LOCAL_USER_ID>/` simply becomes theirs with no file
moves.

## 9. Providers and models

`_system/providers.json` is the configuration. It is bootstrapped from
`LLAMA_BASE_URL`/`LLAMA_API_KEY` on first run so Phases 2–4 keep working, and is
authoritative afterwards. **It holds `apiKey` in plaintext**, so it is 0600 and backups of
`data/` are secret. An invalid entry is disabled and logged rather than crashing startup —
one bad provider must not make the application unbootable. Admin editing is Phase 9.

A model is the **pair** `(providerId, modelId)`. Model ids are opaque strings that are never
parsed, and the same id may legitimately exist on two providers meaning different things, so
the pair travels and is validated together. `ProviderHub.resolveModel` checks it against the
server-side cache before anything is minted or persisted; the browser's pair is untrusted, so
a model valid on provider A is rejected against provider B (INV-18).

**Discovery cache** (`catalog.ts`) with a TTL and stale-while-revalidate:

- a successful refresh replaces the list and clears `stale`;
- a **failed** refresh keeps the last good list and marks it `stale`, so the models someone
  was just using stay selectable;
- a provider that has never succeeded is `unavailable` with an empty list;
- discovery never blocks startup, and concurrent refreshes are coalesced into one call.

`GET /api/providers` and `GET /api/models` return narrow DTOs that cannot carry `apiKey` or
`baseUrl` (INV-25). Capabilities come from discovery where the provider reports modalities
(`docs/provider-notes.md` §2 shows llama.cpp does) and from config otherwise; the source is
reported so the UI can distinguish discovered from assumed.

Removing a provider drops its client and cache and **touches no conversation**: old assistant
blocks keep the `provider`/`model` they recorded, and new generations simply cannot select it.

`EchoProvider` is a second, non-HTTP implementation that exists only to prove the abstraction
is real — with a single implementation there is no way to tell whether the interface describes
what generation needs or merely what llama.cpp happens to do.

### SSRF (INV-19)

Validating the URL string is **not sufficient**: a hostname that resolves to a public address
during validation can resolve to `169.254.169.254` a moment later. So:

1. the URL shape is checked — scheme allow-list, no credentials, no fragment — on config load
   and again on every request;
2. at request time the hostname is resolved, **every** returned address is checked (mixing one
   good address in must not unblock the rest), and the connection is **pinned** to a validated
   address through a custom undici lookup, closing the rebinding window;
3. redirects are refused outright — a 302 to a metadata address would walk past every check
   above.

Metadata and link-local ranges (`169.254.0.0/16`, `fd00:ec2::254`, `fe80::/10`, `0.0.0.0/8`,
and their IPv4-mapped IPv6 forms) are blocked **whatever the policy says**. Private ranges are
permitted by default via `ALLOW_PRIVATE_PROVIDER_HOSTS`, because a local llama.cpp is the
primary use case; `PROVIDER_HOST_ALLOWLIST` narrows further.

`safeFetch` returns an explicit `release()` rather than closing the dispatcher itself: the
dispatcher owns the socket, so closing it when `fetch` resolves would truncate an SSE body
before the caller read any of it.

## 10. Streaming

### Replay and resync (INV-20)

Every event carries a monotonically increasing id per generation, and the last
`SSE_REPLAY_EVENTS` (default **2000**) are held in a ring buffer. 2000 is about a
long reply's worth of chunks, so an ordinary reconnect replays exactly rather
than resyncing, while the memory held per generation stays small and bounded.

On connect, the server decides from `Last-Event-ID`:

| Client state                | Response                                |
| --------------------------- | --------------------------------------- |
| no id (fresh observer)      | one `snapshot`, then live events        |
| id equals ours              | nothing; straight to live events        |
| id inside the window        | exactly the missed events, then live    |
| id older than the window    | one `resync` carrying the full snapshot |
| id ahead of anything issued | one `resync` — the id is not ours       |

That last row matters: treating a future id as "up to date" would leave a stale
tab permanently silent. **A gap is never left silent.** The server guarantees
correct replay and the client never deduplicates to compensate — if text arrived
twice that is a server bug, and hiding it in the client would only make it
harder to find. On `resync` the client _replaces_ its state rather than
appending, since what it held may overlap or be missing events entirely.

A terminal generation gets its catch-up and then the stream closes, rather than
holding a connection that will never produce another event.

### Checkpoints

`_system/generations/<id>.json` holds owner, conversation, ids, state, output so
far, last event id, and timestamps. Written on **every state transition** and,
while streaming, at most once per `GENERATION_CHECKPOINT_MS` (default 1000 ms) —
never one write per token.

Writes are **chained per generation**. Two in flight at once race at the final
rename, so a `streaming` write issued just before a `completed` one could land
_after_ it and resurrect the older state, which recovery would then treat as an
interrupted run.

Checkpoints are disposable and are never read as conversation history; the
canonical Markdown stays authoritative.

### Restart policy (INV-21)

In-flight generations do not survive a restart. What survives is the honesty of
the record. Before the listener accepts a single request, `recoverGenerations`
walks every checkpoint: a non-terminal one has its partial output appended with
`status=interrupted`, then the checkpoint is cleared.

The subtle part is a crash _between_ those two steps. A second run would
otherwise append the same message twice, so the scan checks whether an assistant
message with that id is already present and skips the write — exactly once,
however many times recovery runs (INV-07). A checkpoint whose conversation was
deleted is discarded; one whose conversation cannot be written is logged and
left for inspection rather than blocking startup.

### Abandonment

A generation with no observers is **not** abandoned; it runs to completion.
Only terminal generations are evicted, after `GENERATION_RETENTION_MS`.

`activeGenerationId` on `GET /api/conversations/:id` reports a run only while it
is genuinely non-terminal. The in-flight map is cleared after the canonical
write, which leaves a window where the run has finished but the entry remains —
reporting it there made a reloading client subscribe to a finished generation
and render a second, permanently pending reply.

### Serving the client

In production the server also serves `dist/client` with an SPA fallback, so
`npm start` is a complete application rather than an API needing a separate
static host. `/api` is matched first and keeps its canonical JSON 404s; the
fallback is GET/HEAD only, so a mistyped POST still fails loudly instead of
returning HTML.

## 11. Client rendering

### Markdown (INV-22)

Model output is untrusted. It may contain `<script>`, an `<img onerror=…>`, or a
`javascript:` link — either because the model was steered into emitting one, or because it is
faithfully quoting a document that contains one. Rendering runs `react-markdown` +
`remark-gfm` with **two independent defences**:

1. **Raw HTML is never parsed.** `rehype-raw` is deliberately not a dependency and `skipHtml`
   is set, so `<script>alert(1)</script>` is text to display, not markup to build. This is a
   property of what is _installed_, not of a filter that could be misconfigured.
2. **URL schemes are filtered.** Markdown link syntax can carry `javascript:` or `data:` with
   no HTML involved, so every `href` and `src` passes an allow-list
   (`http`, `https`, `mailto`, `tel`). Control characters are stripped _before_ the scheme is
   read, because browsers resolve `java\nscript:` as `javascript:`. A refused link keeps its
   text and loses its href, so the reader still sees what was written. Permitted links get
   `rel="noopener noreferrer"`.

Rendering never alters what is stored: this is a view of the Markdown, and the file on disk
keeps whatever the model actually wrote.

Code fences scroll inside their own block and tables inside their own container, so neither
can make the page scroll horizontally.

### Layout

Exactly **two** scroll containers: the conversation list and the transcript. The document
never scrolls (`html, body { overflow: hidden }`), and every intermediate flex item carries
`min-height: 0` — without it a flex item defaults to `min-height: auto`, grows to fit its
content, and silently hands the scroll back to the body.

Overlays — the model menu and dialogs — render through a portal to `document.body`. The
composer is a rounded, overflow-clipped box, so a menu rendered inside it would be cut off at
its edge; portalling puts it outside every ancestor's overflow and stacking context.

The sidebar is **positioned over** the main column rather than taking a track beside it.
Sharing the width meant every toggle re-measured the transcript — the text column narrowed,
lines re-wrapped, and the conversation shifted under the reader for a change that had nothing
to do with its content. On a wide window `main` takes a `padding-left` of the sidebar's width
so its content is not hidden underneath; on a narrow one it does not, because there the
sidebar is a drawer over the page and insetting would push the transcript off the right edge
to make room for something already covering it.

### Routing

React Router, with the URL as the source of truth for which conversation is open.
`client/routes/paths.ts` holds every literal and is the only place a conversation URL is
built — the client-side echo of the rule the server keeps for filesystem paths.

| Path                    | Screen                                                    |
| ----------------------- | --------------------------------------------------------- |
| `/`                     | redirect to `/chat/new`                                   |
| `/chat/new`             | the draft: a composer with no conversation behind it      |
| `/chat/:conversationId` | one conversation                                          |
| `/chats`                | the conversation index, mostly a narrow-window affordance |
| `/settings`, `/admin`   | panels, as overlays with a URL                            |
| `/login`                | the only route outside `RequireAuth`                      |
| `*`                     | not found                                                 |

**`/chat/new` creates nothing.** Visiting it writes no file; the conversation is created by
the server when the first message is sent, and the URL is then _replaced_ with the real id so
Back does not return to a draft whose message has already gone. Creating on navigation would
leave an empty conversation behind every time someone opened New chat and changed their mind,
which is the behaviour this application deliberately removed.

**Overlays keep a background location.** Settings and Admin are still panels over the chat,
but each is an address, so it can be linked to and dismissed with Back. `AppRoutes` renders
two route tables: the first draws the screen at `location.state.background` when a panel was
opened from inside the application — so the conversation being read stays behind it — and at
the real location otherwise, which is what makes a pasted `/settings` link work. The second
draws the panel. The alternative, nesting them as `/chat/:conversationId/settings`, needs none
of this and costs the short addresses.

**`RequireAuth` is a layout route**, so a route added later is protected by where it is
declared rather than by remembering to wrap it. `unknown` is not `unauthenticated`: while the
session request is in flight it renders the boot placeholder, because redirecting then would
bounce signed-in readers through the login screen on every cold load. The attempted location
travels in history state and is restored after signing in.

The **draft lives above the router** in `Root`, which is why a session expiring mid-sentence
and signing back in returns the reader's unsent text. The open conversation no longer needs
that treatment — it is in the URL.

`Root` mounts `BrowserRouter`; `AppRoot` is everything below it, exported so tests can supply
a `MemoryRouter`. `BrowserRouter` reads jsdom's single shared history, so without that split
whichever test ran last decided which screen the next one started on.

Deep links need the server's SPA history fallback, which `server/app.ts` already had.

### Responsive model (Phase 10)

One breakpoint, **56rem (896px)**, declared as `--breakpoint-narrow` in `theme.css`. It is
asked in two languages that cannot reference each other — `matchMedia` in
`useNarrowViewport`, `@media` in the stylesheets — so `e2e/mobile.spec.ts` asserts both at
895px and 897px. They had already drifted once (56rem against 48rem), leaving a 128px band
where the sidebar was a drawer while the panels still laid out for a desktop.

Below the breakpoint:

- **The sidebar is a modal drawer.** `useFocusTrap` moves focus in, wraps Tab at both ends,
  closes on Escape, and restores focus to the trigger. `main` carries `inert` while it is
  open — not `aria-hidden`, which hides a region from assistive technology but leaves every
  control tabbable and clickable behind the scrim. Choosing a conversation dismisses the
  drawer, since a drawer covers what it navigates to.
- **Overlays become bottom sheets.** A menu anchored to its trigger is wrong on a phone,
  where the trigger is as likely to be at the bottom edge as anywhere. Panels go full-screen.
- **Touch targets are ≥ 44px**, under `@media (pointer: coarse)` — a capability query, not a
  width, because a touchscreen laptop needs them and a phone with a mouse does not. The
  controls are grown rather than given an invisible `::after` pad: a pad pushed behind with
  `z-index: -1` is covered by any ancestor background, and two neighbours 8px apart each
  grown by 6 on a side overlap and answer for each other's taps.

Keyboard avoidance is **CSS only**: `interactive-widget=resizes-content` in the viewport meta
makes the on-screen keyboard shorten the layout viewport, so `100dvh` resolves to the space
above the keys and the composer follows it with no measurement. `env(safe-area-inset-*)` holds
content clear of the cutout and the home indicator. `visualViewport` is listened to in exactly
one place (see below) and is never measured.

### Scroll intent

New content follows the bottom only while the user is pinned there (within 48px). The hard
part is telling a user's scroll from one we caused, since a streaming reply changes
`scrollHeight` constantly and every `scrollTo` fires `scroll` too.

Origin is decided by **position, not by time**. An instant `scrollTo` moves `scrollTop`
synchronously but dispatches its event later, so the position is already final when the event
arrives: if it matches where we sent it, the event is ours. An earlier time-window approach
ignored _every_ scroll inside the window, which meant a user scrolling in the moment after a
token arrived was mistaken for us and dragged back to the bottom. A smooth scroll still needs
a window, since it emits a run of intermediate positions — but it only happens on an explicit
"jump to latest", where the user has just asked to go to the bottom.

Unpinned, arriving content raises a "jump to latest" control instead of moving the viewport.

A **viewport resize is not a scroll** (Phase 10). Opening the on-screen keyboard shortens the
scroller without moving `scrollTop`, and the browser dispatches no `scroll` event for it —
measured at 390×844: `clientHeight` 635 → 211, `scrollTop` unchanged, zero events. A reader
who was at the bottom is therefore left 424px above it with the newest message behind the
keys, and nothing in the scroll path ever learns. So `resize` is handled directly: if pinned,
re-scroll to the bottom. The opposite direction — the viewport growing, which clamps
`scrollTop` down and _does_ emit an event — is covered by a 250ms guard that re-pins rather
than reading the clamp as intent. Both `window.resize` and `visualViewport.resize` are bound,
the latter because a browser that ignores `interactive-widget` moves only the visual viewport;
it is evidence that the reader did not scroll, not a measurement.

### Client data layer

Every server read and write goes through `client/queries.ts`, built on TanStack
Query. The properties this phase needs — request ownership, deduplication of
identical in-flight requests, cancellation on supersession, and stale-response
rejection — are then properties of _one_ mechanism rather than of each call
site. What it replaced was an `AbortController` and a loading flag per
component, which had no answer at all to a slow read for conversation A landing
after the reader had already opened B.

Query keys are built in one place (`keys`), so a key cannot be spelled two ways:
a mutation invalidating `['conversation', id]` while a hook reads
`['conversations', id]` fails silently and looks like a caching bug.

Defaults suit a self-hosted app talking to a server on the same machine:
`refetchOnWindowFocus` is off, because the user is the only writer and a refetch
on every focus is pure noise; retries are off, because a local failure is a real
failure worth showing rather than a flaky network worth papering over, and
silent retries would make the error boundaries fire late.

**The cold start is concurrent.** Session, conversation list and models are all
started on the shell's first render rather than waiting to be mounted by an
authenticated `App`. None of the three needs another's _result_ — only for the
user to turn out to be signed in, which can be settled afterwards by discarding
what was fetched. Previously first paint was three round trips deep for no
reason. If the session resolves unauthenticated, the speculative results are
removed from the cache so one user's list can never be shown to the next.

**The shell never unmounts.** The composer draft and the open conversation live
above the authenticated region, so a session expiring mid-sentence and the user
signing back in returns them to the same conversation with their unsent text
intact. Held inside `App` they would be destroyed by the very transition they
need to survive.

**Any request may discover an expired session.** `request()` in `client/api.ts`
raises one `onAuthExpired` notification when the server answers
`UNAUTHENTICATED`, and the shell makes the transition once. Handling it per call
site would mean every one of them re-implementing the same move, and a missed
one would leave a signed-in shell that can no longer do anything. Auth probes
(`session`, `login`, `register`) suppress it: a rejected credential is an answer,
not an expiry.

**Optimistic sends reconcile, and roll back.** The user's message is shown with a
client-temporary id which is replaced by the server's `userMessageId` from the
`202`. The cache is the single source of truth throughout, so there is never a
second copy to keep in step. A failed send restores the pre-send snapshot and
returns the text to the composer — the transcript then says what is true, which
is that the server never received it.

### INV-23: a stale response never overwrites newer state

Enforced structurally rather than by comparing timestamps. Each conversation is
its own cache entry keyed by id, so a read for A can only ever land in A's entry
and cannot overwrite what is on screen for B. Reads also carry an `AbortSignal`,
so opening B actively cancels A's request rather than merely ignoring it when it
arrives. An aborted fetch is re-thrown as an `AbortError` rather than being
reported as an unreachable server, so superseding a request shows no error.

Verified in `client/state.test.tsx` against a server stand-in that holds each
request open, which is the only way the ordering is observable: against a mock
that answers instantly, every ordering looks correct.

### Error boundaries

Placed per region — shell, sidebar, transcript — rather than once at the root,
so the blast radius matches the failure: a conversation whose content throws
while rendering costs the reader that pane, not the navigation they need to get
away from it. The transcript's boundary is keyed on the open conversation, so
navigating away clears a failure rather than stranding the reader on it.

## 12. Administration

### Authorization (INV-24)

One `requireAdmin`, mounted on the router rather than on each route, for the
same reason `requireAuth` is: a route added later cannot end up unprotected
because someone forgot to repeat the check. It is scoped to `/api/admin` rather
than `/api` — mounted on the latter it would also intercept anything the earlier
routers did not match, so a bad method on a conversation route would answer 403
to a non-admin instead of the 404 it deserves.

The role is resolved from the **stored user record on each request**, never from
the client and never from a value cached at sign-in. That is what makes a
demotion take effect immediately: an admin demoted mid-session is refused on
their very next request. A user disabled or deleted mid-session answers 401
rather than 403 — they are not signed in at all, which is a different fact from
being signed in without permission.

UI that hides admin controls is a courtesy. This is the enforcement.

### Reducing access takes effect now (INV-17)

Disabling, demoting, or deleting a user revokes every session **and** cancels
everything they have running. A generation already in flight would otherwise
keep writing to conversations its owner no longer has access to.
`GenerationManager.cancelAllForOwner` exists for this: unlike `cancel`, it takes
no generation id, because the administrator is acting on the person and does not
know what they have running.

### Last-admin protection (INV-26)

Counted over _active admins other than the target_, which is what makes one rule
cover demoting someone else and demoting yourself — the usual way an operator
locks themselves out. A disabled admin does not count as a way back in. The
refusal is `LAST_ADMIN` (409): a conflict with the state of the system, not a
malformed request.

### Secrets are write-only (INV-25)

No response from the admin surface ever contains an `apiKey`. The DTO carries
`hasApiKey`, which is everything an operator needs and nothing an attacker can
use. On edit the three cases are mutually exclusive so a write is never
ambiguous about a credential: `apiKey` replaces it, `clearApiKey: true` removes
it, and neither keeps what is stored.

This is verified by a **sweep** rather than only by targeted assertions: known
sentinel values are configured, every route is called as both an admin and a
non-admin, and the bodies, headers, and captured log stream are searched for
them. Narrower assertions can only catch the leaks someone thought of.

### Provider writes

Every create and edit re-runs the full SSRF validation (INV-19), not only the
load-time check, and "test connection" goes through the same guarded client — a
test using a plain fetch could report success for an endpoint a real generation
would refuse, which is worse than no test at all. Writes are atomic, then the
live registry is swapped in-process, so a change takes effect without a restart.

### Settings (`_system/settings.json`)

Every key is optional. An absent file, an absent key, or a file that cannot be
parsed all mean "fall back to the environment", so an instance that has never
opened the admin UI behaves exactly as before and a corrupt file degrades rather
than refusing to boot. `registrationMode` overrides the environment once set,
and is resolved **per request** — a value read once at startup would keep the old
answer until a restart, which is exactly the situation an operator is trying to
fix when they close registration.

Model visibility hides `(providerId, modelId)` pairs from non-admins. It is a
rule layered _on top of_ validation, never instead of it: a hidden pair is still
checked against the catalogue, so nothing here weakens INV-18. A hidden model is
refused with `MODEL_NOT_FOUND` — the same answer a model that does not exist
gets, so hiding one cannot be used to discover it is there. Admins are exempt,
so an instance cannot hide every model and leave itself unable to test one.

### Per-model sampling

An administrator sets temperature, top_p, top_k, min_p, repeat_penalty and a
system prompt for a `(providerId, modelId)` pair. They are applied on the server
when a generation starts — the browser has no field for them, because they are
policy for everyone using that model rather than a preference of whoever is
typing.

**An unset field is not sent at all.** Writing our own defaults into every
request would silently override whatever the operator configured on
llama-server, whose defaults vary by build and by model. An explicit `0` is
still sent: "no override" and "override with zero" are different instructions,
and temperature 0 is an ordinary thing to want. Clearing a field on the admin
route uses `null`, which removes it rather than storing zero.

The system prompt is prepended to the `system` list _before_ the prompt is
assembled, so it is charged against the context budget like every other system
message. Appended afterwards it would be free, and a long one would quietly push
the request past the window it was measured against.

A model's own defaults are read from `GET /v1/models`, which router mode answers
with each model's llama-server command line. This costs nothing — the
alternative, `GET /props?model=<id>`, **loads that model and evicts the resident
one** (provider notes §3), which is far too much to pay for displaying a number.
Only the sampling flags are parsed out; the array itself never leaves
`parseLaunchSampler`, because it contains `--api-key-file` and the model's path
on disk (INV-04).

The sampler is **copied** onto the generation record when a run starts. The
settings store hands out the object it holds, so keeping the reference would let
an edit landing mid-flight reach into a generation already under way. Clearing
the last field removes the record entirely rather than leaving a bare
`(providerId, modelId)` pair behind.

### Clearing chat history

`withinHours` deletes conversations _touched inside_ that window — "clear the
last hour" means the recent ones, which is what the person asking means. The
window is one of four fixed values rather than a free number, so a typo cannot
widen it; omitting it clears everything, and the route requires an explicit
`confirm` so there is no accidental path to either.

Anything running for an affected account is cancelled before the files go:
a generation in flight belongs to a conversation inside the window by
definition, since it is being written to right now, and would otherwise be
writing into a conversation that no longer exists (INV-17).

A conversation whose `updatedAt` cannot be parsed is left alone. A window is a
claim about when something happened, and that claim cannot be made for a
timestamp we cannot read — deleting on a guess is the wrong way to be wrong.

### Audit log

One JSON object per line in `_system/audit/<yyyy-mm>.jsonl`. Line-delimited so
an append is a single write with no read-modify-write cycle to lose entries to,
and so a truncated final line costs one record rather than the file.

Entries carry actor, action, target, timestamp, and outcome — never secrets,
passwords, or message content. `details` is filtered on the way in by key and
by type rather than trusted to call sites: the cost of one careless object is a
credential written to a file that is meant to be safe to hand to whoever
investigates an incident. Writing an entry never throws; a failure is logged
instead, because an audit problem must not turn a successful administrative
action into an error the operator has to guess about.

## 13. Attachments (Phase 11)

### Storage

One directory per attachment, under `data/<user>/attachments/<attachment-uuid>/`:

```text
<attachment-uuid>/
├── blob        # the bytes, exactly as uploaded, never rewritten
└── meta.json   # canonical metadata, written LAST
```

The write order is the design. Bytes stream to a temp file in the same directory and are
renamed over `blob` at the end (contracts §2), so a partial upload is never visible under its
final name; `meta.json` is then written last and atomically, so a directory without it is an
upload that did not finish — nothing has to remember whether a blob is real,
because every read goes through the metadata. Those directories are swept at startup once they
are older than the pending TTL; sweeping a young one would delete a request still in flight.

**The id is the only thing in the path (INV-28).** The uploaded filename is display metadata,
stored inside `meta.json`, with control characters removed and separators replaced by U+2215 —
a character that reads as a slash and is not one. `StoragePaths.attachmentDir` accepts only a
canonical UUID and asserts containment like every other path.

### What may be stored

Decided from the bytes. The uploader's `Content-Type` and the filename's extension are hints;
both are attacker-controlled in the case that matters, which is an HTML document named
`photo.png` and sent as `image/png`.

| Accepted                        | Decided by                                                                | Needs                        |
| ------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| PNG, JPEG, WebP, GIF            | magic-byte signature                                                      | the model's `image` modality |
| WAV, MP3, FLAC                  | magic-byte signature                                                      | the model's `audio` modality |
| plain text, Markdown, CSV, JSON | valid UTF-8, no NUL byte; the extension chooses _between_ text types only | nothing                      |

The two media lists are what the models actually take, not what the format zoo offers. Every
Gemma and Qwen model on the reference server accepts images; only some Gemma variants accept
audio, and Qwen accepts none — so capability is checked **per modality** rather than as one
multimodal flag. The audio list is miniaudio's, which is what llama.cpp decodes with.

**Video, PDFs and archives are refused by name**, not left to fall through as "unsupported".
Nothing here can read them, so storing one would mean keeping bytes that could never be sent
anywhere — a file service rather than an attachment — and a reader who tried deserves to be
told which it was. An `.m4a` is refused alongside the video containers it shares a header
with: it is audio, but in a container the decoder cannot open.

SVG and HTML are refused for a different reason: SVG is an image to everyone who discusses it
and a scriptable document to a browser. **Valid UTF-8 is not the same as text** — arbitrary
binary can decode cleanly, since NUL is a legal code point, and a text attachment is inlined
into a prompt, so accepting one means pasting binary into a model's input. A NUL byte is the
tell.

### Serving (INV-27)

`GET /api/attachments/:id/content` sends the **sniffed** type, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private`, and
`Content-Disposition: attachment` for everything except the four raster image types. The
filename goes out in the RFC 5987 form alongside a stripped ASCII one, so a quote in a name
cannot close the header early and add a parameter of its own.

### Limits

Each is an administrator setting with an environment default, resolved **per key** so that
setting one does not reset the others. They are read through a function on every upload rather
than copied at construction — a limit that looks saved and only takes effect after a restart is
worse than one that cannot be changed at all.

| Limit                   | Setting                            | Environment default                           |
| ----------------------- | ---------------------------------- | --------------------------------------------- |
| Per file                | `attachments.maxBytes`             | `ATTACHMENT_MAX_BYTES`, 10 MB                 |
| Per account             | `attachments.maxTotalBytesPerUser` | `ATTACHMENT_MAX_TOTAL_BYTES_PER_USER`, 512 MB |
| Inlined into a prompt   | `attachments.maxInlineChars`       | `ATTACHMENT_MAX_INLINE_CHARS`, 100 000        |
| Unsent uploads kept for | —                                  | `ATTACHMENT_PENDING_TTL_MS`, 24 h             |
| Per message             | —                                  | fixed at 10 by the conversation format        |

The TTL stays environment-only: it is an operational choice about disk rather than a policy an
instance should be able to talk itself out of. The per-message limit is the format's, frozen in
`formatVersion: 1`, so a setting could only ever lower it.

### Lifecycle

An attachment is **pending** until a message references it, and **linked** afterwards.

```text
upload → pending ──(message written)──► linked
            │                              │
            └──(TTL, swept)──► gone        └──(conversation deleted)──► gone
```

- **Linking happens after the Markdown is durable, inside the conversation lock.** That order
  is the recoverable one: a crash between the two leaves attachments pending that a message
  already names, and `reconcileAttachments` adopts them at startup by reading the Markdown
  back. The other order would leave an attachment claiming a message that was never written,
  which nothing can detect. Reconciliation never deletes — unreferenced bytes are the sweep's
  business, and conflating the two would let a bug there destroy files.
- **A linked attachment cannot be deleted on its own.** Removing it would leave canonical
  Markdown pointing at nothing.
- **Deleting a conversation releases its attachments, Markdown first.** An orphan is safe and
  collectable; a dangling reference is not. A malformed conversation cannot be read for its
  references, so its attachments are left as orphans rather than the delete being refused
  (INV-10).
- **A missing attachment is never `CONVERSATION_MALFORMED`.** The UI shows a placeholder and
  prompt assembly skips it.

### Prompt assembly

Text is inlined as a fenced block labelled with its filename, truncated at the configured
inline limit with a visible marker — in the prompt only; what is stored is
never altered. Images become OpenAI `image_url` content parts carrying `data:` URLs, verified
against the live server (docs/provider-notes.md §9). A remote URL is never sent: that would
make the provider fetch a destination the client chose.

**Capability is checked before anything is persisted.** `architecture.input_modalities` from
discovery says whether a model can see; a model without a projector answers an image with a
_500_, and by then the user's question would already be on disk and unanswerable. Images in
older turns are dropped for a model that cannot see, rather than failing — a picture three
questions ago must not break the conversation. Each image costs a documented 1200-token
estimate, because the true cost depends on how a model tiles it and can only be learned by
sending it.

### Not in scope, and worth saying

There is **no virus scanning**. Bytes are stored as received and served back only to the person
who uploaded them, sandboxed and never as executable content — but an operator hosting this for
others should put scanning in front of `data/` if that matters to them.
