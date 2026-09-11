# Architecture

The authoritative specification is the project contract (`00-contracts.md`), which is
maintained **outside this repository** alongside the phase prompts that drive the build.
This document records what is **actually built** and where each invariant is enforced.
If this file and the contract disagree, the contract wins and the discrepancy is a bug.

Current state: **Phase 5 complete.**

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

## 5. Invariant register

Every invariant is enforced in code and covered by at least one test whose title names it.

| ID     | Invariant                                                                                                       | Phase | Enforced in                                                       | Tests                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| INV-01 | Every API error uses the canonical error contract; unhandled errors become `INTERNAL` with no internals exposed | 1     | `server/middleware/errorHandler.ts`                               | `server/middleware/errorHandler.test.ts`                                  |
| INV-02 | Every request body is schema-validated and unknown fields are rejected                                          | 1     | `server/http/validate.ts` (`z.strictObject`)                      | `server/http/validate.test.ts`                                            |
| INV-03 | Responses are explicit DTOs; no secrets, hashes, paths, or upstream bodies in any response                      | 1     | `server/routes/health.ts`, `shared/api.ts`, `errorBody()`         | `server/routes/health.test.ts`, `server/http/validate.test.ts`            |
| INV-04 | Provider credentials and raw provider payloads never reach the browser                                          | 2     | `server/provider/llamacpp.ts` (`listModels` DTO mapping)          | `server/provider/llamacpp.test.ts`, `server/routes/generations.test.ts`   |
| INV-05 | A generation reaches exactly one terminal state                                                                 | 2     | `server/generation/manager.ts` (`#finish`)                        | `server/generation/manager.test.ts`                                       |
| INV-06 | Closing an SSE connection never cancels a generation                                                            | 2     | `server/routes/generations.ts` (`cleanup` only unsubscribes)      | `server/generation/manager.test.ts`, `server/routes/generations.test.ts`  |
| INV-07 | The assistant message is written to canonical storage exactly once per generation                               | 3     | `server/generation/service.ts` (`#persistOnTerminal`)             | `server/storage/persistence.test.ts`                                      |
| INV-08 | The user message is durable before `202` is returned                                                            | 3     | `server/generation/service.ts` (`start`, under the lock)          | `server/storage/persistence.test.ts`                                      |
| INV-09 | `formatVersion: 1` round-trips exactly                                                                          | 3     | `server/storage/markdown.ts`                                      | `server/storage/markdown.test.ts`                                         |
| INV-10 | Malformed conversations are never modified and never break other conversations                                  | 3     | `server/storage/conversations.ts`                                 | `server/storage/storage.test.ts`, `server/storage/persistence.test.ts`    |
| INV-11 | The index is derived: deleting it and restarting loses nothing                                                  | 3     | `server/storage/index.ts`                                         | `server/storage/persistence.test.ts`                                      |
| INV-12 | No filesystem path contains request-controlled input; all paths stay inside `DATA_DIR`                          | 3     | `server/storage/paths.ts`                                         | `server/storage/storage.test.ts`                                          |
| INV-13 | At most one non-terminal generation per conversation                                                            | 3     | `server/generation/service.ts` (`#active` under the lock)         | `server/storage/persistence.test.ts`                                      |
| INV-14 | Identity comes only from server-side state                                                                      | 3     | `server/auth/middleware.ts`; `ownerOf(req)` reads only `req.auth` | `server/storage/persistence.test.ts`                                      |
| INV-15 | A user can never read, modify, delete, or observe another user's resources (404)                                | 4     | `server/auth/middleware.ts` + `userId` args through storage       | `server/auth/auth.test.ts`                                                |
| INV-16 | Every state-changing route requires a valid CSRF token or same-origin check                                     | 4     | `server/auth/middleware.ts` (`requireCsrf`, `requireSameOrigin`)  | `server/auth/auth.test.ts`                                                |
| INV-17 | Reducing a user's privileges or disabling them revokes all their sessions                                       | 4     | `server/auth/middleware.ts` (record loaded per request)           | `server/auth/auth.test.ts`                                                |
| INV-18 | Only server-validated `(providerId, modelId)` pairs are ever sent to a provider                                 | 5     | `server/provider/hub.ts` + `catalog.requireModel`                 | `server/provider/providers.test.ts`, `server/storage/persistence.test.ts` |
| INV-19 | Every provider endpoint passes SSRF validation on create/edit and at request time                               | 5     | `server/provider/ssrf.ts`                                         | `server/provider/ssrf.test.ts`                                            |
| INV-20 | SSE replay never silently skips events; a too-old `Last-Event-ID` triggers a full resync                        | 6     | pending                                                           | pending                                                                   |
| INV-21 | After a restart, no generation remains non-terminal, and partial output is persisted once                       | 6     | pending                                                           | pending                                                                   |
| INV-22 | Rendered Markdown never executes script or raw HTML                                                             | 7     | pending                                                           | pending                                                                   |
| INV-23 | A stale response never overwrites newer client state                                                            | 8     | pending                                                           | pending                                                                   |
| INV-24 | Admin authorization is enforced server-side on every admin route                                                | 9     | pending                                                           | pending                                                                   |
| INV-25 | Secrets are write-only: no API response ever contains a configured secret                                       | 9     | pending                                                           | pending                                                                   |
| INV-26 | There is always at least one active admin                                                                       | 9     | pending                                                           | pending                                                                   |
| INV-27 | Attachment bytes are never served as executable content; media type is sniffed, not trusted                     | 11    | pending                                                           | pending                                                                   |
| INV-28 | Attachment storage paths never derive from the uploaded filename                                                | 11    | pending                                                           | pending                                                                   |

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

SSE observation is implemented — see §4b. Replay from `Last-Event-ID`, resync,
checkpoints, and the restart policy are Phase 6.

## 11. Attachments

N/A until Phase 11.
