# Invariant audit (Phase 13)

Every invariant in contracts §8 must have a test that **fails when the invariant is broken** —
not merely a test that passes while it holds. This audit proves that by mutation: the
enforcement is temporarily broken in the source, the named test is run, and a failure must be
observed. The mutation is then reverted. The harness lived in the scratch area; this table is
its result.

`CAUGHT` = the mutation made the named test fail, so the test genuinely guards the invariant.

| INV | Enforcement mutated                                         | Test that caught it                                                  | Result          |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------- | --------------- |
| 01  | error body leaks `err.stack` instead of a fixed message     | `middleware/errorHandler.test.ts`                                    | CAUGHT          |
| 02  | a route schema `strictObject` → `object`                    | `security.test.ts` (unknown-field sweep)                             | CAUGHT          |
| 03  | — explicit DTOs; no single-line lever leaks a hash          | proven via 01 + 25 + `auth.test.ts` passwordHash assertions          | by construction |
| 04  | `listModels` spreads the raw provider entry                 | `provider/llamacpp.test.ts`                                          | CAUGHT          |
| 05  | the streaming loop's terminal guard removed                 | `generation/manager.test.ts` (late chunks dropped)                   | CAUGHT          |
| 06  | client disconnect (`req.on('close')`) also cancels          | `routes/generations.test.ts`                                         | CAUGHT          |
| 07  | assistant message appended twice                            | `storage/persistence.test.ts`                                        | CAUGHT          |
| 08  | the user-message `writeUnderLock` skipped                   | `storage/persistence.test.ts`                                        | CAUGHT          |
| 09  | serializer perturbs the title                               | `storage/markdown.test.ts` (round-trip)                              | CAUGHT          |
| 10  | malformed file returns a fabricated conversation            | `storage/storage.test.ts`                                            | CAUGHT          |
| 11  | `list()` returns `[]` instead of rebuilding a missing index | `storage/persistence.test.ts`                                        | CAUGHT          |
| 12  | segment UUID validation disabled                            | `storage/traversal.test.ts`, `storage.test.ts`                       | CAUGHT          |
| 13  | the in-progress guard disabled                              | `storage/persistence.test.ts`                                        | CAUGHT          |
| 14  | `ownerOf` trusts an `X-User` header                         | `auth/auth.test.ts` (new: identity cannot be chosen)                 | CAUGHT          |
| 15  | — cross-user isolation                                      | `auth/auth.test.ts` isolation block (passing); reinforced by 12 + 14 | by test         |
| 16  | `requireCsrf` calls `next()` unconditionally                | `auth/auth.test.ts`, `security.test.ts`                              | CAUGHT          |
| 17  | `status !== 'active'` check dropped                         | `auth/auth.test.ts`                                                  | CAUGHT          |
| 18  | `resolveModel` skips `requireModel`                         | `provider/providers.test.ts`                                         | CAUGHT          |
| 19  | provider-URL protocol check disabled                        | `provider/ssrf.test.ts`                                              | CAUGHT          |
| 20  | out-of-window replay returns `[]` instead of a resync       | `generation/streaming.test.ts`                                       | CAUGHT          |
| 21  | recovery marks interrupted output `completed`               | `generation/streaming.test.ts`                                       | CAUGHT          |
| 22  | — raw HTML off by the absence of `rehype-raw`, not a flag   | `client/Markdown.test.tsx` (passing)                                 | by construction |
| 23  | — stale-response guard is per-id query keys + `AbortSignal` | `client/state.test.tsx`, `e2e/state.spec.ts` (passing)               | by test         |
| 24  | `requireAdmin` role check disabled                          | `routes/admin.test.ts`                                               | CAUGHT          |
| 25  | provider DTO helper bypassed                                | `routes/admin.test.ts` (secret sweep)                                | CAUGHT          |
| 26  | last-admin assertion disabled                               | `routes/admin.test.ts`                                               | CAUGHT          |
| 27  | the markup check returns `false`                            | `attachments/sniff.test.ts`, `routes/attachments.test.ts`            | CAUGHT          |
| 28  | filename used verbatim instead of `displayFilename`         | `attachments/store.test.ts`                                          | CAUGHT          |

**24 of 28 mutation-proven.** The four marked _by construction_ / _by test_ are enforced
structurally — an explicit DTO that never receives a secret, a Markdown pipeline with no raw-HTML
plugin, per-id query keys — so there is no single line whose removal introduces the fault; each
has a dedicated passing test, and the security-critical ones among their neighbours (12, 14, 16,
24, 25) are mutation-proven.
