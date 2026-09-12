# Security

What this application defends against, what it does not, and what an operator has to do
themselves. Written during the Phase 12 review; every claim below is backed by code and by a
test named in the same row.

This is a **single-process, self-hosted** application (contracts §2). Several controls are
per-process, and that is called out wherever it matters rather than left implied.

---

## Threat model

| In scope                                        | Out of scope                                                |
| ----------------------------------------------- | ----------------------------------------------------------- |
| A signed-in user reaching another user's data   | A hostile administrator — an admin can already read `data/` |
| An unauthenticated caller reaching anything     | An attacker with filesystem access to `data/`               |
| A cross-site page acting with a reader's cookie | Denial of service by volume; put a proxy in front           |
| A hostile file uploaded as an attachment        | Malware in an attachment — there is no virus scanning       |
| A compromised or broken model provider          | Side-channel and timing attacks on the host                 |

---

## Controls

### Identity and sessions

| Control                                                                             | Where                              | Test                    |
| ----------------------------------------------------------------------------------- | ---------------------------------- | ----------------------- |
| Session tokens are random 256-bit, stored only as SHA-256                           | `auth/sessions.ts`                 | `auth/sessions.test.ts` |
| Cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production                        | `routes/auth.ts`                   | `routes/auth.test.ts`   |
| Token rotates on login and on privilege change                                      | `auth/sessions.ts`                 | `auth/sessions.test.ts` |
| Absolute and idle expiry enforced server-side                                       | `auth/sessions.ts`                 | `auth/sessions.test.ts` |
| Disabling, demoting, deleting or changing a password revokes every session (INV-17) | `auth/users.ts`, `routes/admin.ts` | `routes/admin.test.ts`  |
| Passwords hashed with Argon2id                                                      | `auth/users.ts`                    | `auth/users.test.ts`    |

Identity comes only from the session (INV-14). No route accepts a `userId`.

### Authorization

Ownership is enforced at the service and storage boundary, not in the route. A cross-user
reference is `404`, never `403`, so ownership is never revealed (contracts §5). Admin routes
are guarded server-side on every route (INV-24), enumerated from the router rather than from a
list — `routes/admin.test.ts`, `attachments/linking.test.ts`, `attachments/store.test.ts`.

### CSRF (INV-16)

Synchroniser token bound to the session, required on every non-GET request.
`security.test.ts` enumerates **every route the application mounts** and asserts each
state-changing one refuses a request that carries a session cookie and no token.

Login and registration have no session to bind a token to and are protected by a same-origin
check instead; that is asserted separately in the same file.

> **Found by this review.** `POST /api/auth/logout` had no CSRF protection, and
> `POST /api/auth/password` was exempt by the same mechanism — the auth router is mounted
> before the global gate, because login must be reachable without a session. Fixed by requiring
> the token per route. The password route was not exploitable only because `validateBody`
> rejected the request first, which is not a security control.

### Input validation (INV-02)

Every route has a strict schema that rejects unknown fields, enumerated in `security.test.ts`.

> **Found by this review.** `POST /api/auth/logout` had no schema at all. A route with none
> accepts whatever it is handed and ignores it, which is indistinguishable from one whose
> schema was forgotten.

### Responses and errors (INV-01, INV-03)

Responses are built from explicit DTOs; no internal record is spread into `res.json`.
`security.test.ts` fuzzes every state-changing route with malformed payloads and asserts no
stack trace, no `DATA_DIR` path, no provider key and no password hash reaches a response. Logs
are checked against the same sentinels.

### Filesystem (INV-12, INV-28)

Path construction is centralised in `storage/paths.ts`. Every segment is validated before any
syscall, and every resolved path is asserted to remain inside `DATA_DIR`.
`storage/traversal.test.ts` drives **every constructor on the class**, in every argument
position, against traversal, absolute paths, encoded traversal and embedded NULs — so a
constructor added later is covered the moment it exists.

Uploaded filenames never reach a path (INV-28); they are display metadata.

### Uploads (INV-27)

| Control                                                                  | Test                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Type decided by magic bytes; `Content-Type` and extension are hints      | `attachments/sniff.test.ts`                                   |
| SVG and HTML refused by name                                             | `attachments/sniff.test.ts`                                   |
| Binary that happens to be valid UTF-8 refused as text                    | `attachments/sniff.test.ts`                                   |
| Video, PDF and archives refused by name                                  | `attachments/sniff.test.ts`                                   |
| Declared image dimensions capped (decompression bomb)                    | `attachments/dimensions.test.ts`, `attachments/store.test.ts` |
| Size enforced **while streaming**; nothing oversized survives a refusal  | `attachments/store.test.ts`                                   |
| Per-user quota                                                           | `attachments/store.test.ts`                                   |
| Sniffed `Content-Type`, `nosniff`, sandbox CSP, `attachment` disposition | `routes/attachments.test.ts`                                  |
| Filename cannot break out of `Content-Disposition`                       | `routes/attachments.test.ts`                                  |

### Outbound requests (INV-19)

Provider endpoints pass SSRF validation on every create, edit and request. DNS is resolved and
the socket **pinned to the validated address**, so it cannot be rebound afterwards, and
`redirect: 'error'` refuses redirects outright — following one would re-resolve a host that was
already checked. `provider/ssrf.test.ts`.

Only `data:` URLs are ever sent for attachments. A remote URL would make the provider fetch a
destination the client chose.

### Resource limits

| Limit                                   | Default | Where                                 |
| --------------------------------------- | ------- | ------------------------------------- |
| JSON body                               | 100 kB  | `JSON_BODY_LIMIT`                     |
| Attachment, per file                    | 10 MB   | `ATTACHMENT_MAX_BYTES`                |
| Attachment, per account                 | 512 MB  | `ATTACHMENT_MAX_TOTAL_BYTES_PER_USER` |
| Declared image pixels                   | 50 M    | `ATTACHMENT_MAX_IMAGE_PIXELS`         |
| Provider response per generation        | 64 MB   | `provider/llamacpp.ts`                |
| Concurrent generations per conversation | 1       | INV-13                                |

The provider cap exists because the provider is configured by an administrator and reached over
the network: trusted, but not controlled. `provider/responseCap.test.ts` — note that without
the cap those tests do not fail, they hang.

### Rate limiting

| Route            | Limit       | Counted by               |
| ---------------- | ----------- | ------------------------ |
| Login            | 20 / 15 min | address **and** username |
| Register         | 10 / 15 min | address **and** username |
| Password change  | 10 / 15 min | account                  |
| Upload           | 60 / min    | account                  |
| Generation start | 30 / min    | account                  |
| Admin mutations  | 120 / min   | account                  |

Two dimensions on login because either alone leaves a hole: per address lets a botnet spread
one account's guesses across many hosts; per username lets one host work through a list of
accounts. `middleware/rateLimit.test.ts`, `routes/attachments.test.ts`.

### Headers and CSP

`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
`form-action 'self'`, plus `nosniff`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy` and the cross-origin isolation headers. HSTS in production over TLS only.

**No `unsafe-inline` for scripts in production.** The shell's one inline script — which applies
the stored theme before the first paint — is allowed by SHA-256 hash, read from the built
`index.html` so it cannot go stale. Development adds what Vite needs, in a branch built
separately rather than by weakening the production set. `middleware/securityHeaders.test.ts`.

### Dependencies

`npm audit --omit=dev` reports **0 vulnerabilities** as of 2026-09-12. Run it against the
production tree, not the dev one; a finding is documented here, never suppressed to get a clean
exit code.

---

## Exceptions

Unresolved findings, each with its risk and what compensates for it.

### E-1 · Rate limits are per process

**Requirement:** rate limiting on authentication, uploads, generation and admin mutations.
**Why unresolved:** counters live in memory. Contracts §2 makes this application single-process
and says multi-host deployment is unsupported, so a shared store would solve a problem this
deployment does not have.
**Risk:** two instances behind a load balancer give a caller twice the configured budget.
**Compensating control:** documented here and in the module; the supported deployment is one
process.
**Remediation:** a shared counter (Redis or equivalent) if multi-process is ever supported.

### E-2 · `trust proxy` is off, so address limits collapse behind a reverse proxy

**Requirement:** per-address limits on login and registration.
**Why unresolved:** enabling `trust proxy` without knowing the hop count lets a caller spoof
`X-Forwarded-For` and bypass the limit entirely.
**Risk:** behind a reverse proxy every request appears to come from the proxy, so the
per-address limit becomes global — too strict rather than bypassable.
**Compensating control:** the per-username and per-account limits are unaffected, and those are
the ones that bound credential guessing.
**Remediation:** an `TRUST_PROXY_HOPS` setting an operator sets deliberately.

### E-3 · No virus scanning of attachments

**Requirement:** none — explicitly out of scope for Phase 11.
**Risk:** a reader can store a file that is malicious to whatever opens it elsewhere.
**Compensating control:** bytes are served only to the account that uploaded them, sandboxed,
never as executable content, and never rendered as HTML.
**Remediation:** an operator hosting this for other people should scan `data/` out of band.

### E-4 · `style-src` allows `unsafe-inline`

**Requirement:** strict CSP.
**Why unresolved:** React writes `style` attributes — the upload progress fill among them — and
there is no hash form covering attribute styles.
**Risk:** bounded; a style cannot execute.
**Compensating control:** `script-src` has no `unsafe-inline`, which is where execution lives.
**Remediation:** a nonce threaded through the components that set styles, if the risk ever
justifies the change.

### E-5 · Containment assertion is not reachable by any test

**Requirement:** every resolved path stays inside `DATA_DIR` (INV-12).
**Why unresolved:** nothing that survives segment validation can escape, so the second layer
cannot be exercised from outside.
**Risk:** none today; it is defence in depth against a constructor added later that forgets to
validate.
**Compensating control:** `storage/traversal.test.ts` enumerates constructors from the class, so
such a constructor would be caught by the validation test instead.
**Remediation:** none needed; recorded so the coverage is not overstated.

---

## Backups

`data/` is the **complete** persistent state. Nothing outside it needs backing up; nothing
inside it is reconstructible from elsewhere.

### What to copy

| Path                                                     | Back up?                                                |
| -------------------------------------------------------- | ------------------------------------------------------- |
| `data/<user>/chats/`                                     | **yes** — canonical conversations                       |
| `data/<user>/attachments/`                               | **yes** — the files those conversations refer to        |
| `data/<user>/user.json`, `preferences.json`, `memories/` | **yes**                                                 |
| `data/_system/providers.json`, `settings.json`, `audit/` | **yes**                                                 |
| `data/<user>/index/`                                     | no — derived, rebuilt on demand (INV-11)                |
| `data/_system/sessions/`                                 | optional — omitting it signs everyone out               |
| `data/_system/generations/`                              | optional — omitting it fails in-flight generations only |

### A backup contains secrets

`providers.json` holds provider API keys at rest, and every conversation and attachment is user
content. **Treat a backup exactly as you would treat the server's disk**: encrypt it, and
restrict who can read it.

### Consistency

Writes are atomic per file, but a backup taken while the server is running can catch two files
mid-change relative to one another. Either **stop the server**, or take a **filesystem
snapshot**. A plain `cp -a` of a live directory is the case this warns about.

### Restoring

```bash
systemctl stop rgfschat          # or however it is run
rm -rf /srv/rgfschat/data        # only into a directory you mean to replace
cp -a /backups/data /srv/rgfschat/data
chown -R rgfschat:rgfschat /srv/rgfschat/data
chmod -R u=rwX,go= /srv/rgfschat/data
systemctl start rgfschat
```

Then verify: sign in, open a conversation with an attachment, and confirm the file downloads.
The derived index rebuilds itself on first use, so its absence is expected.

This procedure is executed as a test, not merely described —
`server/storage/backupRestore.test.ts` restores into a fresh `DATA_DIR` **without** `index/` and
asserts conversations, attachment bytes, attachment metadata and password hashes all survive.

---

## Reporting

This is a personal, self-hosted project with no security contact. If you are running it for
other people, you are the security contact.
