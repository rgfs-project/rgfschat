#!/usr/bin/env tsx
/**
 * Provider probe — verify, do not assume.
 *
 * Phase 2 of `.Phases/` requires that the provider implementation be written
 * against observed behaviour rather than against what the OpenAI spec or the
 * llama.cpp README imply. This script talks to a live `llama-server` and prints
 * a report; the findings are transcribed into `docs/provider-notes.md`, with
 * anything not observed marked UNVERIFIED.
 *
 * Usage:
 *   LLAMA_BASE_URL=http://host:port LLAMA_API_KEY=… npx tsx scripts/probe-provider.ts [model]
 *
 * It is gated on LLAMA_BASE_URL and exits 0 (skipped) when that is unset, so it
 * is safe to invoke from CI where no provider exists.
 */

const baseUrl = process.env['LLAMA_BASE_URL']?.replace(/\/+$/, '');
const apiKey = process.env['LLAMA_API_KEY'];
const requestedModel = process.argv[2];

if (baseUrl === undefined || baseUrl === '') {
  console.log('LLAMA_BASE_URL is not set — probe skipped.');
  process.exit(0);
}

const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

function section(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

function finding(label: string, value: unknown): void {
  console.log(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

/** Truncates deep/large payloads so the report stays readable. */
function preview(value: unknown, max = 400): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function getJson(
  path: string,
  headers: Record<string, string> = authHeaders
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function probeAuth(): Promise<void> {
  section('1. Auth behaviour');

  const withKey = await getJson('/v1/models');
  finding('GET /v1/models with key', withKey.status);

  const withoutKey = await getJson('/v1/models', {});
  finding('GET /v1/models without key', withoutKey.status);
  finding('error shape when unauthorized', preview(withoutKey.body, 200));

  const health = await getJson('/health', {});
  finding('GET /health without key', `${health.status} ${preview(health.body, 80)}`);
}

interface ModelEntry {
  id: string;
  status?: { value?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  source?: string;
}

async function probeModels(): Promise<ModelEntry[]> {
  section('2. Model discovery — /v1/models');

  const { status, body } = await getJson('/v1/models');
  finding('status', status);

  const data = (body as { data?: ModelEntry[] } | null)?.data;
  if (!Array.isArray(data)) {
    finding('UNEXPECTED shape', preview(body));
    return [];
  }

  finding('model count', data.length);
  finding('top-level keys', Object.keys(body as object));
  finding('entry keys', Object.keys(data[0] ?? {}));
  finding(
    'ids (note: may contain spaces — must be URL-encoded)',
    data.map((m) => m.id)
  );
  finding(
    'ids containing whitespace',
    data.filter((m) => /\s/.test(m.id)).map((m) => m.id)
  );
  finding(
    'statuses',
    data.map((m) => `${m.id}=${m.status?.value ?? '?'}`)
  );
  finding(
    'multimodal (input modalities beyond text)',
    data
      .filter((m) => (m.architecture?.input_modalities ?? []).some((x) => x !== 'text'))
      .map((m) => `${m.id}:[${(m.architecture?.input_modalities ?? []).join(',')}]`)
  );

  return data;
}

async function probeProps(): Promise<void> {
  section('3. Context length discovery — /props');

  const { status, body } = await getJson('/props');
  finding('status', status);

  const props = body as Record<string, unknown> | null;
  finding('keys', props === null ? null : Object.keys(props));
  finding('role', props?.['role'] ?? 'absent');
  finding('n_ctx (default_generation_settings)', preview(props?.['default_generation_settings']));
  finding('model_path', props?.['model_path'] ?? 'absent');
  finding('build_info', props?.['build_info'] ?? 'absent');
}

async function probeTokenize(): Promise<void> {
  section('4. Tokenize endpoint');

  const response = await fetch(`${baseUrl}/tokenize`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello world' }),
  });
  const body: unknown = await response.json().catch(() => null);
  finding('POST /tokenize status', response.status);
  finding('body', preview(body, 200));
}

async function probeSlots(): Promise<void> {
  section('5. Slots');

  const { status, body } = await getJson('/slots');
  finding('GET /slots status', status);
  finding('body', preview(body, 200));
}

async function probeUnknownModel(): Promise<void> {
  section('6. Error — unknown model');

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'definitely-not-a-real-model-xyz',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4,
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  finding('status', response.status);
  finding('body', preview(body, 300));
}

/** Deliberately loose: the probe's job is to discover the shape, not assume it. */
interface ProbeChunk {
  choices?: {
    delta?: { role?: unknown; content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }[];
  usage?: unknown;
  timings?: unknown;
}

interface StreamObservations {
  model: string;
  firstChunkKeys: string[];
  roleChunkSeen: boolean;
  contentChunks: number;
  reasoningChunks: number;
  finishReasons: string[];
  sawUsage: boolean;
  usagePreview: string;
  sawTimings: boolean;
  timingsPreview: string;
  terminatedWithDone: boolean;
  firstChunkPreview: string;
  lastChunkPreview: string;
  contentSample: string;
  reasoningSample: string;
  ttfbMs: number;
  totalMs: number;
}

async function probeStreaming(model: string): Promise<StreamObservations | null> {
  section(`7. Streaming chat completion — model "${model}"`);

  const started = Date.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
      max_tokens: 120,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  finding('status', response.status);
  finding('content-type', response.headers.get('content-type'));

  if (!response.ok || response.body === null) {
    finding('FAILED body', preview(await response.text(), 300));
    return null;
  }

  const obs: StreamObservations = {
    model,
    firstChunkKeys: [],
    roleChunkSeen: false,
    contentChunks: 0,
    reasoningChunks: 0,
    finishReasons: [],
    sawUsage: false,
    usagePreview: '',
    sawTimings: false,
    timingsPreview: '',
    terminatedWithDone: false,
    firstChunkPreview: '',
    lastChunkPreview: '',
    contentSample: '',
    reasoningSample: '',
    ttfbMs: 0,
    totalMs: 0,
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let isFirst = true;

  // SSE framing: events are separated by a blank line; each data line is JSON
  // except the sentinel `[DONE]`.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();

        if (payload === '[DONE]') {
          obs.terminatedWithDone = true;
          continue;
        }

        let chunk: ProbeChunk;
        try {
          chunk = JSON.parse(payload) as ProbeChunk;
        } catch {
          finding('UNPARSEABLE data line', preview(payload, 200));
          continue;
        }

        if (isFirst) {
          isFirst = false;
          obs.ttfbMs = Date.now() - started;
          obs.firstChunkKeys = Object.keys(chunk);
          obs.firstChunkPreview = preview(chunk, 300);
        }
        obs.lastChunkPreview = preview(chunk, 300);

        const delta = chunk?.choices?.[0]?.delta;
        if (delta?.role !== undefined) obs.roleChunkSeen = true;
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          obs.contentChunks += 1;
          if (obs.contentSample.length < 120) obs.contentSample += delta.content;
        }
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          obs.reasoningChunks += 1;
          if (obs.reasoningSample.length < 120) obs.reasoningSample += delta.reasoning_content;
        }

        const finish = chunk?.choices?.[0]?.finish_reason;
        if (finish !== null && finish !== undefined) obs.finishReasons.push(String(finish));

        if (chunk.usage !== undefined && chunk.usage !== null) {
          obs.sawUsage = true;
          obs.usagePreview = preview(chunk.usage, 300);
        }
        if (chunk.timings !== undefined && chunk.timings !== null) {
          obs.sawTimings = true;
          obs.timingsPreview = preview(chunk.timings, 300);
        }
      }
    }
  }

  obs.totalMs = Date.now() - started;

  finding('first chunk keys', obs.firstChunkKeys);
  finding('first chunk', obs.firstChunkPreview);
  finding('role delta seen', obs.roleChunkSeen);
  finding('content chunks', obs.contentChunks);
  finding('reasoning_content chunks', obs.reasoningChunks);
  finding('content sample', JSON.stringify(obs.contentSample));
  finding('reasoning sample', JSON.stringify(obs.reasoningSample));
  finding('finish reasons', obs.finishReasons);
  finding('usage chunk present', obs.sawUsage);
  finding('usage', obs.usagePreview || 'n/a');
  finding('timings chunk present', obs.sawTimings);
  finding('timings', obs.timingsPreview || 'n/a');
  finding('terminated with [DONE]', obs.terminatedWithDone);
  finding('last chunk', obs.lastChunkPreview);
  finding('time to first chunk (ms)', obs.ttfbMs);
  finding('total (ms)', obs.totalMs);

  return obs;
}

async function probeCancel(model: string): Promise<void> {
  section(`8. Cancellation — aborting mid-stream ("${model}")`);

  const controller = new AbortController();
  const started = Date.now();

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Write a long essay about the sea.' }],
        max_tokens: 2000,
        stream: true,
      }),
      signal: controller.signal,
    });

    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    finding('aborted after first chunk at (ms)', Date.now() - started);
    finding('abort raised on client', 'no error until next read');

    try {
      await reader.read();
    } catch (err) {
      finding('next read threw', err instanceof Error ? err.name : String(err));
    }
  } catch (err) {
    finding('fetch threw', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

async function probeOversizedPrompt(model: string): Promise<void> {
  section(`9. Error — oversized prompt ("${model}")`);

  // Far beyond any configured n_ctx, to observe how the server rejects it.
  const huge = 'word '.repeat(400_000);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: huge }],
        max_tokens: 8,
      }),
    });
    const body: unknown = await response.json().catch(() => null);
    finding('status', response.status);
    finding('body', preview(body, 300));
  } catch (err) {
    finding('threw', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

async function main(): Promise<void> {
  console.log(`Probing ${baseUrl}`);
  console.log(`API key: ${apiKey ? 'provided' : 'not provided'}`);

  await probeAuth();
  const models = await probeModels();
  await probeProps();
  await probeTokenize();
  await probeSlots();
  await probeUnknownModel();

  const model = requestedModel ?? models[0]?.id;
  if (model === undefined) {
    console.log('\nNo model available — streaming probes skipped.');
    return;
  }

  await probeStreaming(model);
  await probeCancel(model);
  await probeOversizedPrompt(model);

  section('Done');
  console.log('Transcribe these findings into docs/provider-notes.md.');
  console.log('Mark anything not observed above as UNVERIFIED.\n');
}

await main();
