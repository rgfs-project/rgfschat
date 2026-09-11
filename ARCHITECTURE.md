# Architecture

The authoritative specification is the project contract (`00-contracts.md`), which is
maintained **outside this repository** alongside the phase prompts that drive the build.
This document records what is **actually built** and where each invariant is enforced.
If this file and the contract disagree, the contract wins and the discrepancy is a bug.

Current state: **Phase 2 complete.**

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

| Code                   | HTTP | Raised by                                       |
| ---------------------- | ---- | ----------------------------------------------- |
| `VALIDATION`           | 400  | schema failure, malformed JSON                  |
| `NOT_FOUND`            | 404  | unmatched route                                 |
| `PAYLOAD_TOO_LARGE`    | 413  | body over `JSON_BODY_LIMIT` (100 kb)            |
| `INTERNAL`             | 500  | anything unhandled                              |
| `PROVIDER_UNAVAILABLE` | 502  | upstream unreachable                            |
| `PROVIDER_ERROR`       | 502  | upstream rejected, failed, or returned nonsense |
| `PROVIDER_TIMEOUT`     | 504  | upstream exceeded `PROVIDER_TIMEOUT_MS`         |
| `MODEL_NOT_FOUND`      | 400  | model absent from the discovered list           |
| `GENERATION_NOT_FOUND` | 404  | unknown generation id                           |

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

| ID     | Invariant                                                                                                       | Phase | Enforced in                                                  | Tests                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| INV-01 | Every API error uses the canonical error contract; unhandled errors become `INTERNAL` with no internals exposed | 1     | `server/middleware/errorHandler.ts`                          | `server/middleware/errorHandler.test.ts`                                 |
| INV-02 | Every request body is schema-validated and unknown fields are rejected                                          | 1     | `server/http/validate.ts` (`z.strictObject`)                 | `server/http/validate.test.ts`                                           |
| INV-03 | Responses are explicit DTOs; no secrets, hashes, paths, or upstream bodies in any response                      | 1     | `server/routes/health.ts`, `shared/api.ts`, `errorBody()`    | `server/routes/health.test.ts`, `server/http/validate.test.ts`           |
| INV-04 | Provider credentials and raw provider payloads never reach the browser                                          | 2     | `server/provider/llamacpp.ts` (`listModels` DTO mapping)     | `server/provider/llamacpp.test.ts`, `server/routes/generations.test.ts`  |
| INV-05 | A generation reaches exactly one terminal state                                                                 | 2     | `server/generation/manager.ts` (`#finish`)                   | `server/generation/manager.test.ts`                                      |
| INV-06 | Closing an SSE connection never cancels a generation                                                            | 2     | `server/routes/generations.ts` (`cleanup` only unsubscribes) | `server/generation/manager.test.ts`, `server/routes/generations.test.ts` |
| INV-07 | The assistant message is written to canonical storage exactly once per generation                               | 3     | pending                                                      | pending                                                                  |
| INV-08 | The user message is durable before `202` is returned                                                            | 3     | pending                                                      | pending                                                                  |
| INV-09 | `formatVersion: 1` round-trips exactly                                                                          | 3     | pending                                                      | pending                                                                  |
| INV-10 | Malformed conversations are never modified and never break other conversations                                  | 3     | pending                                                      | pending                                                                  |
| INV-11 | The index is derived: deleting it and restarting loses nothing                                                  | 3     | pending                                                      | pending                                                                  |
| INV-12 | No filesystem path contains request-controlled input; all paths stay inside `DATA_DIR`                          | 3     | pending                                                      | pending                                                                  |
| INV-13 | At most one non-terminal generation per conversation                                                            | 3     | pending                                                      | pending                                                                  |
| INV-14 | Identity comes only from server-side state                                                                      | 3     | pending                                                      | pending                                                                  |
| INV-15 | A user can never read, modify, delete, or observe another user's resources (404)                                | 4     | pending                                                      | pending                                                                  |
| INV-16 | Every state-changing route requires a valid CSRF token or same-origin check                                     | 4     | pending                                                      | pending                                                                  |
| INV-17 | Reducing a user's privileges or disabling them revokes all their sessions                                       | 4     | pending                                                      | pending                                                                  |
| INV-18 | Only server-validated `(providerId, modelId)` pairs are ever sent to a provider                                 | 5     | pending                                                      | pending                                                                  |
| INV-19 | Every provider endpoint passes SSRF validation on create/edit and at request time                               | 5     | pending                                                      | pending                                                                  |
| INV-20 | SSE replay never silently skips events; a too-old `Last-Event-ID` triggers a full resync                        | 6     | pending                                                      | pending                                                                  |
| INV-21 | After a restart, no generation remains non-terminal, and partial output is persisted once                       | 6     | pending                                                      | pending                                                                  |
| INV-22 | Rendered Markdown never executes script or raw HTML                                                             | 7     | pending                                                      | pending                                                                  |
| INV-23 | A stale response never overwrites newer client state                                                            | 8     | pending                                                      | pending                                                                  |
| INV-24 | Admin authorization is enforced server-side on every admin route                                                | 9     | pending                                                      | pending                                                                  |
| INV-25 | Secrets are write-only: no API response ever contains a configured secret                                       | 9     | pending                                                      | pending                                                                  |
| INV-26 | There is always at least one active admin                                                                       | 9     | pending                                                      | pending                                                                  |
| INV-27 | Attachment bytes are never served as executable content; media type is sniffed, not trusted                     | 11    | pending                                                      | pending                                                                  |
| INV-28 | Attachment storage paths never derive from the uploaded filename                                                | 11    | pending                                                      | pending                                                                  |

## 6. Storage

N/A until Phase 3. `data/` exists as a boundary and is git-ignored except for `.gitkeep`.
`DATA_DIR` is resolved to an absolute path at boot, but nothing reads or writes it yet.
The centralized path-construction module required by contracts §1 arrives with Phase 3, and
deliberately does not exist now — an unused abstraction would be scaffolding for a phase
whose requirements are not yet in front of us.

## 7. Conversation format

N/A until Phase 3. Frozen at `formatVersion: 1` by contracts §3 once it ships.

## 8. Authentication and sessions

N/A until Phase 4. Phase 1–3 have no concept of a user; Phase 3 uses a configured
`LOCAL_USER_ID`.

## 9. Providers and models

Implemented for llama.cpp in Phase 2 — see §4a and `docs/provider-notes.md`.
Multi-provider configuration, the model cache, and SSRF validation are Phase 5.

## 10. Streaming

SSE observation is implemented — see §4b. Replay from `Last-Event-ID`, resync,
checkpoints, and the restart policy are Phase 6.

## 11. Attachments

N/A until Phase 11.
