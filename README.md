# Workspace

A self-hosted chat workspace. Conversations are plain Markdown files on disk, generation is
owned by the server, and the model provider is replaceable.

This repository is built in phases against a project contract kept outside the repository.
**Phase 14** is complete: the foundation and HTTP conventions, canonical Markdown persistence
with a rebuildable index, accounts with sessions and CSRF protection, multiple model providers
with SSRF-protected discovery, reconnectable streaming that survives a reload, a dropped
connection, or a restart, the chat interface and its conversation navigation, a resilient
client data layer, an admin surface with server-enforced authorization, per-user settings, a
layout that is responsive by design from a 390px phone to a wide desktop, and image and text
attachments with sniffed types, quotas, and per-model capability checks, and a security
hardening pass with rate limiting, a strict content security policy, a documented and
tested backup procedure, and a visual-polish and accessibility pass (WCAG 2.2 AA, axe-clean in
both themes, with a screen-reader live region for streaming).

Security controls, the exception register, and how to back up and restore are in
[`SECURITY.md`](SECURITY.md).

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
npm run test:e2e
```

`npm run index:rebuild` rebuilds the derived conversation index from the Markdown.

`test:e2e` drives a real browser against the built server with Playwright: reloading
mid-generation, losing the network and reconnecting, and cancelling. Install the browser once
with `npx playwright install chromium`.

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
| `TLS_CERT_FILE`          | _(unset)_               | PEM cert; with the key below, serves HTTPS directly  |
| `TLS_KEY_FILE`           | _(unset)_               | PEM private key; both or neither                     |

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

## On a phone

The interface is responsive by design rather than a shrunk desktop. One breakpoint at
**56rem (896px)**: above it the sidebar is a column beside the transcript, below it a modal
drawer over the page — with a backdrop, a focus trap, Escape and backdrop dismissal, and the
page behind marked `inert`. Menus become bottom sheets, panels go full-screen, and every
touch target is at least 44×44 CSS px on a coarse pointer.

The on-screen keyboard is handled in CSS alone. `interactive-widget=resizes-content` makes it
shorten the layout viewport, so the composer stays above the keys and the page itself never
becomes the scroll container. `viewport-fit=cover` plus `env(safe-area-inset-*)` keeps content
clear of a display cutout and the home indicator.

`e2e/mobile.spec.ts` covers 390×844, 402×714 (an iPhone 17 in Safari), 820×1180, 1440×900,
and the breakpoint at ±1px.

## Attachments

Images (PNG, JPEG, WebP, GIF), audio (WAV, MP3, FLAC) and text files (plain text, Markdown,
CSV, JSON) can be attached to a message by clicking the paperclip, dragging onto the composer,
or pasting an image.

**Video, PDFs and archives are refused.** No model here can read them, so storing them would
just be keeping files nothing could use.

Images and audio are only sent to a model that reports the matching input modality, and the
two are separate: on a typical llama.cpp server every Gemma and Qwen model accepts images,
while only some Gemma variants accept audio. The composer says so before you send, and the
server refuses otherwise.

The type is decided by reading the file's **bytes**, not its name or the `Content-Type` the
browser sends — so a script named `photo.png` is stored and served as text, never as an image.
SVG is rejected: it is an image to everyone who talks about it and a scriptable document to a
browser.

The first three are also administrator settings, which override these defaults without a
restart.

| Limit                      | Variable                              | Default            |
| -------------------------- | ------------------------------------- | ------------------ |
| Per file                   | `ATTACHMENT_MAX_BYTES`                | 10 MB              |
| Per account, in total      | `ATTACHMENT_MAX_TOTAL_BYTES_PER_USER` | 512 MB             |
| Unsent uploads kept for    | `ATTACHMENT_PENDING_TTL_MS`           | 24 hours           |
| Text inlined into a prompt | `ATTACHMENT_MAX_INLINE_CHARS`         | 100 000 characters |
| Per message                | fixed by the conversation format      | 10                 |

Which models can see or listen is discovered from the provider, not configured.

**Attachments are part of `data/` and therefore part of your backups.** They live under
`data/<user-uuid>/attachments/`, and a backup that excludes them will restore conversations
whose images and files are gone. There is no virus scanning — if you host this for other
people, put scanning in front of `data/` yourself.

## Docker

A multi-stage image builds the client and server, prunes to production
dependencies (keeping argon2's compiled binary), and runs as a non-root user
with `/data` as a persistent volume. Verified end to end on both Docker and
rootless Podman.

### Run it with Podman Compose

```bash
# 1. Build and start the server on http://localhost:3001
podman-compose up -d

# 2. Create the first admin. A fresh volume has no accounts and registration
#    is closed by default, so this is the way in. The password is read from
#    stdin — never an argument — so it stays out of shell history and `ps`.
#    Use `podman run -i`, not `podman-compose run`: podman-compose does not
#    attach stdin the same way and the prompt will hang.
printf 'your-strong-password\n' | podman run -i --rm \
  -v workspace_chatui-data:/data localhost/workspace_app:latest \
  create-admin --username admin --admin

# 3. Sign in at http://localhost:3001 as `admin`. Stop with:
podman-compose down          # add -v to also delete the data volume
```

The volume is named `workspace_chatui-data` (the compose project prefix +
`chatui-data`); confirm with `podman volume ls`. Point `LLAMA_BASE_URL` at a
reachable provider in `docker-compose.yml` or the environment — keep that hop
`https://` or on a private network ([`SECURITY.md`](SECURITY.md)).

> **Podman vs Docker.** Two differences. Podman's default OCI image format
> ignores `HEALTHCHECK`; build with `podman build --format docker` to keep it
> (Docker honours it as written). And the stdin note in step 2 above is
> Podman-specific — under Docker, `docker compose run --rm -i app create-admin
--username admin --admin` works directly.

### Run it with Docker

```bash
docker compose up -d --build
docker compose run --rm -i app create-admin --username admin --admin
```

Or without compose:

```bash
docker build -t chatui .
docker volume create chatui-data
docker run -i --rm -v chatui-data:/data chatui create-admin --username admin --admin
docker run -d -p 3001:3001 -v chatui-data:/data \
  -e LLAMA_BASE_URL=https://your-llama-host:8080 chatui
```

For TLS, mount a cert and key and set `TLS_CERT_FILE` / `TLS_KEY_FILE`, or
terminate TLS at a proxy in front. `/data` is the entire persistent state; back
up the volume (it holds secrets — see SECURITY.md). `docker stop` /
`podman stop` triggers the server's graceful shutdown via `dumb-init`.

### The published image

A built image is published to GHCR and is public, so it needs no login to pull:

```bash
podman pull ghcr.io/rgfs-project/rgfschat:latest
```

Every build is also tagged with its commit SHA
(`ghcr.io/rgfs-project/rgfschat:<sha>`); prefer a SHA tag when you want a
deployment pinned to an exact build rather than moving with `latest`. To use it
with the Compose file above, replace the service's `build: .` with
`image: ghcr.io/rgfs-project/rgfschat:latest`.

### Building the image in CI

[`.github/workflows/docker.yml`](.github/workflows/docker.yml) builds the image
on every push to `main` and on version tags, **smoke-tests that it is
self-contained** (creates an admin, boots, checks `/api/health`, and confirms
the API — not just a static server — answers with the canonical `401`), and
**publishes to GHCR** — from the same cached layers it just tested, with a
build-provenance attestation. Publishing is restricted to the canonical
repository; nothing is published from a fork or from a pull request.

To run it on demand — a first publish, or a manual re-build — open the repo's
**Actions** tab, choose **Docker**, and click **Run workflow** (the
`workflow_dispatch` trigger).

The workflow needs no secrets you have to set — it authenticates to GHCR with
the built-in `GITHUB_TOKEN`. Its smoke-test credentials are throwaway, on a
temporary volume, passed on stdin, and never printed.

## First run

There are no accounts to begin with, and registration is closed by default, so create the
first admin from the command line:

```bash
npm run user:create -- --username ada --admin
```

The password is read from a prompt (or stdin, for scripting: `echo "…" | npm run user:create
-- --username ada --admin`). It is **never** accepted as a command-line argument, where it
would land in your shell history and in the process list.

Upgrading from Phase 3? Add `--adopt-local-data` to hand the existing
`data/<LOCAL_USER_ID>/` directory to the new account — nothing moves on disk:

```bash
npm run user:create -- --username ada --admin --adopt-local-data
```

Set `REGISTRATION_MODE=open` to let people sign themselves up.

## Providers

Providers live in `data/_system/providers.json`, created on first run from `LLAMA_BASE_URL`
and `LLAMA_API_KEY`. After that the file is authoritative — edit it and restart. (Editing
from the admin UI arrives in Phase 9.)

```json
{
  "version": 1,
  "providers": [
    {
      "id": "local",
      "name": "Local llama.cpp",
      "kind": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8080",
      "apiKey": "optional-bearer-token",
      "timeoutMs": 120000,
      "capabilities": { "vision": true },
      "contextTokens": 131072
    }
  ]
}
```

> **This file holds secrets.** `apiKey` is stored in plaintext, so the file is written 0600
> and **any backup of `data/` must be treated as secret**. It never leaves the server: the
> API returns only `id`, `name`, `status`, and capabilities.

An invalid entry is disabled and logged rather than crashing startup, so one bad provider
cannot make the application unbootable. A provider that is unreachable shows as _unavailable_
and the others keep working; if discovery fails after having succeeded, the last known model
list stays selectable and is marked _stale_.

### Outbound request safety

Provider endpoints are checked before **every** request, not just when configured. Cloud
metadata and link-local addresses are blocked unconditionally, DNS is resolved and the
connection pinned to a checked address (which defeats DNS rebinding), and redirects are never
followed.

| Variable                       | Default   | Purpose                                                                                    |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------ |
| `ALLOW_PRIVATE_PROVIDER_HOSTS` | `true`    | Allow `127.0.0.1`, LAN, and other private ranges. Metadata ranges stay blocked either way. |
| `PROVIDER_HOST_ALLOWLIST`      | _(empty)_ | Comma-separated hostnames; when set, nothing else may be used.                             |

Set `ALLOW_PRIVATE_PROVIDER_HOSTS=false` if every provider is remote and you want the
strictest posture.

## Your data

Everything lives under `DATA_DIR` (default `./data`):

```text
data/<user-uuid>/chats/<conversation-uuid>.md   canonical — plain Markdown you can read,
                                                diff, grep, and edit by hand
data/<user-uuid>/index/chats.json               derived — a cache, safe to delete
```

Conversations are the source of truth. Edit one in your editor and the change is picked up on
the next read; run `npm run index:rebuild` (or just restart) to refresh the cached list.

If the server stops mid-reply, the partial text is kept: on the next start it is written to
the conversation marked `interrupted`, rather than vanishing or pretending to be a complete
answer. Closing the tab does **not** cancel a generation — reopening the conversation picks
the stream back up where it was.

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
