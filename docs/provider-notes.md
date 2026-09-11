# Provider notes — llama.cpp (`llama-server`)

Observed behaviour of a live server, recorded by `scripts/probe-provider.ts`. The provider
implementation is written against **this file**, not against the OpenAI specification or the
llama.cpp README. Anything not observed live is marked **UNVERIFIED**.

|               |                                                                            |
| ------------- | -------------------------------------------------------------------------- |
| Probed        | 2026-09-10                                                                 |
| Build         | `b10853-9dcf84e5a`                                                         |
| Mode          | **router** (`role: "router"`, `max_instances: 1`, `models_autoload: true`) |
| Models        | 20                                                                         |
| Probe command | `LLAMA_BASE_URL=… LLAMA_API_KEY=… npx tsx scripts/probe-provider.ts "GPT"` |

> This server is in **router mode**, which differs from single-model `llama-server` in ways
> that matter (see §7). Single-model behaviour is **UNVERIFIED**; the provider must not
> assume `role: "router"` is present.

## 1. Auth

- Bearer token in `Authorization`. Verified: correct key → `200`, no key → `401`.
- Error shape is consistent across failures:
  ```json
  { "error": { "message": "Invalid API Key", "type": "authentication_error", "code": 401 } }
  ```
  Note this is **not** our error contract; it must be normalized and never forwarded (INV-04).
- `GET /health` is **unauthenticated** and returns `{"status":"ok"}`. Usable as a liveness
  probe without holding the key.
- **UNVERIFIED**: behaviour when the server runs without `--api-key` at all.

## 2. `GET /v1/models`

Shape: `{ "data": [...], "object": "list" }`. Entry keys:

```text
id, aliases, tags, object, owned_by, created, status, architecture, source, can_remove
```

- `status.value` is `"loaded"` | `"unloaded"`. **UNVERIFIED**: whether a transient
  `"loading"` value exists — never observed, but not ruled out.
- `architecture.input_modalities` is an array such as `["text"]`, `["text","image"]`, or
  `["text","image","audio"]`. This is the honest source for the `vision` capability that
  Phase 11 needs.
- `source` is `"preset"` or `"models_dir"`.

### ⚠ Model ids may contain spaces

Observed ids include `Gemi Mini`, `North Mini`, `Qwen Max`, `Qwen Mini`. Consequences:

- Any id placed in a query string **must** be URL-encoded (`Qwen%20Mini` verified working).
- An id must never be interpolated into a filesystem path (contracts §1 forbids this anyway).
- Ids are opaque: do not assume they match `[a-z0-9-]`.

### ⚠ `status.args` / `status.preset` leak server internals

Each entry carries the **full command line** of the model process, including
`--api-key-file /run/api-key`, absolute GGUF paths, and every sampling parameter. This is
exactly the "raw provider payload" INV-04 forbids reaching the browser. The provider maps
entries to a narrow DTO (`id`, modalities, loaded state) and discards the rest.

## 3. Context length discovery

| Source                      | Result                                         | Cost                            |
| --------------------------- | ---------------------------------------------- | ------------------------------- |
| `GET /props` (router level) | `n_ctx: 0`, `model_path: "none"` — **useless** | free                            |
| `GET /props?model=<id>`     | real `n_ctx` (e.g. `131072`) and `model_path`  | **loads the model**             |
| `GET /slots?model=<id>`     | real `n_ctx` per slot                          | **UNVERIFIED** whether it loads |
| Oversized-prompt error      | `n_ctx` **and** `n_prompt_tokens`              | one failed request              |

Observed per-model `n_ctx`: `Bonsai` 262144, `GPT` 131072, `Qwen Mini` 131072, `Muse` 65536.

### ⚠ `GET /props?model=X` triggers a model load and evicts the current model

Verified with a controlled test:

```text
T0 before:            [("Muse", "loaded")]
GET /props?model=North%20Mini   → n_ctx 131072
T1 immediately after: [("North Mini", "loaded")]
T2 after 12s:         [("North Mini", "loaded")]
```

So context discovery is **not** free metadata. Enumerating all 20 models at startup would
force 20 sequential model loads and leave a random model resident.

**Design consequence.** The provider must not warm a context-length cache eagerly. It
discovers `n_ctx` only for the model a generation is about to use — which is being loaded
anyway — and caches it per model id for the process lifetime. Until a model has been used
once, `DEFAULT_CONTEXT_TOKENS` applies. This matters in Phase 3, where the context budget
is computed before calling the provider.

## 4. Tokenization

`POST /tokenize` **requires** `model` in the body; without it: `400 "model name is missing
from the request"`. With it:

```json
{ "model": "GPT", "content": "hello world" }  →  { "tokens": [24912, 2375] }
```

A real tokenizer is therefore available, which contracts §4 prefers over the conservative
byte estimate. **UNVERIFIED**: whether `/tokenize` triggers a model load like `/props` does.
Assume it does until proven otherwise, and prefer the estimate for models not yet resident.

## 5. Streaming — `POST /v1/chat/completions` with `stream: true`

`Content-Type: text/event-stream`. Frames are `data: <json>` separated by blank lines,
terminated by `data: [DONE]`. `stream_options: { include_usage: true }` is honoured.

Chunk keys: `choices, created, id, model, system_fingerprint, object`.

**First chunk** carries the role and a **null** content:

```json
{"choices":[{"finish_reason":null,"index":0,
  "delta":{"role":"assistant","content":null}}], "object":"chat.completion.chunk", …}
```

**Final chunk** has an **empty `choices` array** plus usage and timings:

```json
{"choices":[], "usage":{"completion_tokens":100,"prompt_tokens":80,"total_tokens":180,
  "prompt_tokens_details":{"cached_tokens":60}},
 "timings":{"predicted_per_second":86.0, …}}
```

### ⚠ Two shapes that break naive parsers

1. **`delta.content` can be `null`**, not merely absent or empty. Code must test
   `typeof content === 'string'`, not truthiness on a possibly-missing key.
2. **`choices` can be `[]`**, so `chunk.choices[0].delta` throws on the final chunk. Every
   access must be guarded.

Both are covered by the mock provider used in tests, so a regression fails a test rather
than a live request.

### `reasoning_content`

Verified present, as `delta.reasoning_content`, interleaved in the same stream as content.
For `GPT` (gpt-oss-20b) on a trivial prompt: **81 reasoning chunks vs 9 content chunks**.

Consequences: a generation can look stalled for a long time while only reasoning arrives, so
reasoning must be surfaced separately in state, events, and UI (Phase 2 requirement), and it
is never sent back to the model (contracts §4). A `max_tokens` budget can be consumed
entirely by reasoning, yielding `finish_reason: "length"` with **empty content** — observed
directly in early manual probing with `max_tokens: 16`.

**UNVERIFIED**: whether reasoning appears for non-gpt-oss models here; it depends on
`--reasoning-format` and the model. The provider must treat it as optional.

Finish reasons observed: `"stop"`, `"length"`. **UNVERIFIED**: `"content_filter"`,
`"tool_calls"`.

## 6. Errors

| Condition                              | Status | `type`                      | Notes                               |
| -------------------------------------- | ------ | --------------------------- | ----------------------------------- |
| Bad/missing key                        | 401    | `authentication_error`      |                                     |
| Unknown model                          | 400    | `invalid_request_error`     | `model 'x' not found`               |
| Missing model on `/tokenize`, `/slots` | 400    | `invalid_request_error`     | router mode                         |
| Oversized prompt                       | 400    | `exceed_context_size_error` | includes `n_prompt_tokens`, `n_ctx` |

Oversized example — note it discloses the real context size:

```json
{"error":{"code":400,"message":"request (400068 tokens) exceeds the available context size
  (131072 tokens), try increasing it","type":"exceed_context_size_error",
  "n_prompt_tokens":400068,"n_ctx":131072}}
```

All of these normalize to `PROVIDER_ERROR` (or `MODEL_NOT_FOUND` for the unknown-model case)
with **no upstream body forwarded**.

**UNVERIFIED**: 5xx responses, and mid-stream error frames. Never observed; the provider
still handles a `data:` frame containing `error` defensively.

## 7. Router-mode behaviour

- `max_instances: 1` and `--parallel 1` per model: **one generation at a time**. Concurrent
  requests queue.
- Requesting a different model **swaps** the resident one. Measured cold start ≈ **12 s**
  for `GPT` (gpt-oss-20b); the model then stays resident.
- Warm timings for `GPT`: 267 ms to first chunk, ~86 tok/s generation, ~77 tok/s prompt.
- `PROVIDER_TIMEOUT_MS` must therefore be generous — a cold load plus generation can exceed
  30 s. Default is 120 s.

**UNVERIFIED**: eviction policy, behaviour under concurrent requests for different models,
and whether a queued request can time out waiting for a swap.

## 8. Cancellation

Aborting the `fetch` via `AbortSignal` mid-stream works: the in-flight `reader.read()`
rejects with `AbortError`. Verified after the first chunk at 139 ms.

**UNVERIFIED**: whether the server actually stops computing on disconnect, or runs to
completion and discards. Contracts treat cancellation as client-side regardless — the
generation reaches a terminal `cancelled` state locally (INV-05) whatever upstream does.

## 9. Summary of constraints on the implementation

1. URL-encode model ids; treat them as opaque strings that may contain spaces.
2. Never forward `/v1/models` entries raw — `status.args` leaks the API-key path (INV-04).
3. Guard `delta.content === null` and `choices === []`.
4. Do not eagerly probe per-model `/props`; it loads models. Discover `n_ctx` lazily, cache it.
5. Keep `reasoning_content` separate everywhere; expect it to dominate token count.
6. Expect single-flight generation and ~12 s cold starts; set timeouts accordingly.
7. Normalize every upstream error; never leak `message` bodies or `n_ctx` internals upstream.
