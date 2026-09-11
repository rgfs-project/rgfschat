# Architecture

The authoritative specification is [`.Phases/00-contracts.md`](.Phases/00-contracts.md).
This document records what is **actually built** and where each invariant is enforced.
If this file and the contracts disagree, the contracts win and the discrepancy is a bug.

Current state: **Phase 1 complete.**

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

Error codes in use (Phase 1 subset of the contracts §5 table):

| Code                | HTTP | Raised by                            |
| ------------------- | ---- | ------------------------------------ |
| `VALIDATION`        | 400  | schema failure, malformed JSON       |
| `NOT_FOUND`         | 404  | unmatched route                      |
| `PAYLOAD_TOO_LARGE` | 413  | body over `JSON_BODY_LIMIT` (100 kb) |
| `INTERNAL`          | 500  | anything unhandled                   |

Express 5 forwards rejected promises from async handlers to the error middleware natively, so
there is no `asyncHandler` wrapper anywhere in the codebase.

## 4. Configuration and logging

`loadConfig` validates the environment once with Zod and throws a message listing offending
keys **without their values**, so a mistyped secret cannot land in a boot log or a crash
report. `createLogger` emits structured JSON and redacts any field whose name matches a
secret-like pattern (`authorization`, `cookie`, `password`, `token`, `apikey`, `secret`,
`session`, `csrf`, …) at any depth. Nothing in Phase 1 handles a secret; the redaction list
exists so later phases inherit it rather than adding it after a leak.

## 5. Invariant register

Every invariant is enforced in code and covered by at least one test whose title names it.

| ID     | Invariant                                                                                                       | Phase | Enforced in                                               | Tests                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------- | -------------------------------------------------------------- |
| INV-01 | Every API error uses the canonical error contract; unhandled errors become `INTERNAL` with no internals exposed | 1     | `server/middleware/errorHandler.ts`                       | `server/middleware/errorHandler.test.ts`                       |
| INV-02 | Every request body is schema-validated and unknown fields are rejected                                          | 1     | `server/http/validate.ts` (`z.strictObject`)              | `server/http/validate.test.ts`                                 |
| INV-03 | Responses are explicit DTOs; no secrets, hashes, paths, or upstream bodies in any response                      | 1     | `server/routes/health.ts`, `shared/api.ts`, `errorBody()` | `server/routes/health.test.ts`, `server/http/validate.test.ts` |
| INV-04 | Provider credentials and raw provider payloads never reach the browser                                          | 2     | pending                                                   | pending                                                        |
| INV-05 | A generation reaches exactly one terminal state                                                                 | 2     | pending                                                   | pending                                                        |
| INV-06 | Closing an SSE connection never cancels a generation                                                            | 2     | pending                                                   | pending                                                        |
| INV-07 | The assistant message is written to canonical storage exactly once per generation                               | 3     | pending                                                   | pending                                                        |
| INV-08 | The user message is durable before `202` is returned                                                            | 3     | pending                                                   | pending                                                        |
| INV-09 | `formatVersion: 1` round-trips exactly                                                                          | 3     | pending                                                   | pending                                                        |
| INV-10 | Malformed conversations are never modified and never break other conversations                                  | 3     | pending                                                   | pending                                                        |
| INV-11 | The index is derived: deleting it and restarting loses nothing                                                  | 3     | pending                                                   | pending                                                        |
| INV-12 | No filesystem path contains request-controlled input; all paths stay inside `DATA_DIR`                          | 3     | pending                                                   | pending                                                        |
| INV-13 | At most one non-terminal generation per conversation                                                            | 3     | pending                                                   | pending                                                        |
| INV-14 | Identity comes only from server-side state                                                                      | 3     | pending                                                   | pending                                                        |
| INV-15 | A user can never read, modify, delete, or observe another user's resources (404)                                | 4     | pending                                                   | pending                                                        |
| INV-16 | Every state-changing route requires a valid CSRF token or same-origin check                                     | 4     | pending                                                   | pending                                                        |
| INV-17 | Reducing a user's privileges or disabling them revokes all their sessions                                       | 4     | pending                                                   | pending                                                        |
| INV-18 | Only server-validated `(providerId, modelId)` pairs are ever sent to a provider                                 | 5     | pending                                                   | pending                                                        |
| INV-19 | Every provider endpoint passes SSRF validation on create/edit and at request time                               | 5     | pending                                                   | pending                                                        |
| INV-20 | SSE replay never silently skips events; a too-old `Last-Event-ID` triggers a full resync                        | 6     | pending                                                   | pending                                                        |
| INV-21 | After a restart, no generation remains non-terminal, and partial output is persisted once                       | 6     | pending                                                   | pending                                                        |
| INV-22 | Rendered Markdown never executes script or raw HTML                                                             | 7     | pending                                                   | pending                                                        |
| INV-23 | A stale response never overwrites newer client state                                                            | 8     | pending                                                   | pending                                                        |
| INV-24 | Admin authorization is enforced server-side on every admin route                                                | 9     | pending                                                   | pending                                                        |
| INV-25 | Secrets are write-only: no API response ever contains a configured secret                                       | 9     | pending                                                   | pending                                                        |
| INV-26 | There is always at least one active admin                                                                       | 9     | pending                                                   | pending                                                        |
| INV-27 | Attachment bytes are never served as executable content; media type is sniffed, not trusted                     | 11    | pending                                                   | pending                                                        |
| INV-28 | Attachment storage paths never derive from the uploaded filename                                                | 11    | pending                                                   | pending                                                        |

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

N/A until Phase 2 (llama.cpp) and Phase 5 (multi-provider).

## 10. Streaming

N/A until Phase 2 (SSE) and Phase 6 (replay, resync, restart policy).

## 11. Attachments

N/A until Phase 11.
