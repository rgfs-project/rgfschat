# Workspace

A self-hosted chat workspace. Conversations are plain Markdown files on disk, generation is
owned by the server, and the model provider is replaceable.

This repository is built in phases against a project contract kept outside the repository.
**Phase 3** is complete: the foundation and HTTP
conventions, a llama.cpp provider with server-owned generations and SSE streaming, and
canonical Markdown persistence with a rebuildable index. There is still no authentication —
that is Phase 4, so do not expose this to a network you do not control.

## Prerequisites

- Node 22 (`.nvmrc` pins the major; `nvm use` picks it up)
- npm 9+

## Install

```bash
npm ci
```

## Run

```bash
npm run dev
```

Starts the API on `http://localhost:3001` and the Vite dev server on
`http://localhost:5173`, which proxies `/api` to the API. Open the client URL; the page
calls `GET /api/health` and shows a loading, error, or result state.

The two dev processes deliberately use different port variables: `PORT` is the **client**
port, `API_PORT` is the API's. Sharing one variable makes the API fail with `EADDRINUSE`.

Run them separately with `npm run dev:client` / `npm run dev:server`.

## Build and serve

```bash
npm run build     # client → dist/client, server → dist/server
npm start         # runs the built server
npm run preview   # serves the built client, proxying /api
```

## Quality gates

Every gate runs in CI on each push, and all must pass before a phase is tagged.

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
```

`npm run index:rebuild` rebuilds the derived conversation index from the Markdown.

`verify` is the one that matters most: it builds, boots the **real** server on a free port
with a throwaway `DATA_DIR`, and checks the health DTO, the canonical 404, and clean
shutdown on `SIGTERM`. Nothing is mocked.

## Configuration

Copy `.env.example` to `.env`. Every variable has a safe default, so an empty file works.
The environment is validated once at boot and the process exits with a readable message if
it is invalid — never with a stack trace, and never echoing the offending value.

| Variable                 | Default                 | Purpose                                              |
| ------------------------ | ----------------------- | ---------------------------------------------------- |
| `NODE_ENV`               | `development`           | `development` \| `test` \| `production`              |
| `PORT`                   | `3001`                  | API port (client port under `npm run dev`)           |
| `API_PORT`               | `3001`                  | API port used by `npm run dev`                       |
| `DATA_DIR`               | `./data`                | Persistent boundary — conversations live here        |
| `LOG_LEVEL`              | `info`                  | `debug` \| `info` \| `warn` \| `error` \| `silent`   |
| `LOCAL_USER_ID`          | a fixed UUID            | Temporary single-user identity until Phase 4         |
| `VITE_API_TARGET`        | `http://localhost:3001` | Dev/preview proxy target                             |
| `LLAMA_BASE_URL`         | `http://127.0.0.1:8080` | llama.cpp `llama-server` endpoint                    |
| `LLAMA_API_KEY`          | _(unset)_               | **Secret.** Bearer token, if the server requires one |
| `PROVIDER_TIMEOUT_MS`    | `120000`                | Generous: a cold model load can take ~12 s           |
| `DEFAULT_CONTEXT_TOKENS` | `8192`                  | Fallback when a model's real context is unknown      |
| `MAX_OUTPUT_TOKENS`      | `2048`                  | Per-generation output cap                            |

`.env` is git-ignored and loaded natively by Node (`--env-file-if-exists`), so there is no
dotenv dependency.

## Talking to llama.cpp

Point `LLAMA_BASE_URL` at a running `llama-server`. Before trusting any assumption about how
it behaves, run the probe against it:

```bash
npm run probe:provider
```

It reports auth behaviour, the model-list shape, streaming chunk shapes, `reasoning_content`,
context-length discovery, and error responses. Findings are written up in
[`docs/provider-notes.md`](docs/provider-notes.md) — **that file, not the OpenAI spec, is what
the provider is implemented against.** Anything not observed live is marked UNVERIFIED.

Three things it turned up that are worth knowing if you run a router-mode server:

- **Model ids can contain spaces** (`Qwen Mini`), so they are URL-encoded and treated as opaque.
- **`GET /props?model=X` loads that model**, evicting the resident one. Context lengths are
  therefore discovered lazily, never enumerated at startup.
- **Reasoning can consume the entire output budget**, finishing cleanly with empty content.
  If replies come back blank, raise `MAX_OUTPUT_TOKENS`.

## Layout

```text
client/     React 19 app (Vite)
server/     Express 5 API
  provider/   llama.cpp client + an HTTP mock that replays observed wire shapes
  generation/ the server-owned generation state machine
shared/     Types used by both, imported as @shared/*
scripts/    dev, build-server, verify, probe-provider
docs/       provider-notes.md — observed provider behaviour
data/       Persistent boundary — committed empty; contents are never tracked
```

## Your data

Everything lives under `DATA_DIR` (default `./data`):

```text
data/<user-uuid>/chats/<conversation-uuid>.md   canonical — plain Markdown you can read,
                                                diff, grep, and edit by hand
data/<user-uuid>/index/chats.json               derived — a cache, safe to delete
```

Conversations are the source of truth. Edit one in your editor and the change is picked up on
the next read; run `npm run index:rebuild` (or just restart) to refresh the cached list.

**Backups: copy all of `data/`.** `index/` is optional — it is rebuilt from the Markdown when
missing, unparseable, or left half-written by a crash. Deleting `data/<user-uuid>/` removes
that user and everything they own.

A conversation file that cannot be parsed is **never** repaired, normalised, or rewritten. It
stays listed, reads and renames return `CONVERSATION_MALFORMED`, and you can still delete it.
Other conversations are unaffected.

### Single process only

Locking is in-memory, so **two servers sharing one `DATA_DIR` would not see each other's
locks** and could lose writes. Run exactly one process per `DATA_DIR`. Durability is
guaranteed on POSIX; on Windows the directory `fsync` barrier is unavailable and
rename-over-existing differs, so Windows is not covered by the durability guarantee.

## Architecture intent

The shape of the system is fixed by the project contract (`00-contracts.md`), kept outside
this repository, which every phase defers to.
The load-bearing decisions:

- **Markdown is canonical.** Conversations are files a user can read, diff, and back up.
  Indexes are derived and can be deleted at any time.
- **The browser is not trusted.** Identity comes from server-side state, never from a
  header or body. Every request is schema-validated and rejects unknown fields; every
  response is an explicit DTO.
- **One error contract.** Every failure leaves through a single boundary in the shape
  `{ error: { code, message, details? } }`. Unhandled errors become `INTERNAL` and expose
  nothing about the inside of the process.
- **`data/` is the persistence boundary.** Everything a user owns lives in one directory
  named by their UUID; deleting it removes them completely.

`ARCHITECTURE.md` tracks the invariant register and which tests enforce it.
