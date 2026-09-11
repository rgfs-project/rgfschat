import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An in-process HTTP server that speaks the streaming format **observed live**
 * and recorded in `docs/provider-notes.md`.
 *
 * Tests run against this rather than a stubbed client, so the SSE parsing, the
 * `null` content quirk, and the empty-`choices` final chunk are all exercised
 * over real HTTP. If the real server's shape ever changes, the probe script
 * catches it; if our parser regresses, these tests catch it.
 */
export interface MockProviderOptions {
  /** Model ids to advertise. Includes a spaced id by default — real ids have them. */
  models?: string[];
  /** Emitted in order. Reasoning arrives before content, as gpt-oss does. */
  reasoningChunks?: string[];
  contentChunks?: string[];
  finishReason?: string;
  /** Delay between chunks, so cancellation has a window to land. */
  chunkDelayMs?: number;
  /** Force a failure mode. */
  failWith?: { status: number; type?: string; message?: string };
  /** Emit a malformed (non-JSON) data frame before the content. */
  emitGarbageFrame?: boolean;
  /** Emit an error frame mid-stream. */
  errorMidStream?: boolean;
  /** Never respond, to exercise the provider timeout. */
  hang?: boolean;
  /** Require this bearer token; respond 401 otherwise. */
  requireApiKey?: string;
  /** Replaces the whole /v1/models body, to exercise malformed shapes. */
  modelsPayload?: unknown;
}

export interface MockProvider {
  url: string;
  close: () => Promise<void>;
  /** Requests received, for asserting what we actually sent upstream. */
  requests: { path: string; authorization: string | undefined; body: unknown }[];
}

const CHUNK_ID = 'chatcmpl-mock';

export async function startMockProvider(options: MockProviderOptions = {}): Promise<MockProvider> {
  const {
    models = ['GPT', 'Qwen Mini'],
    reasoningChunks = ['thinking ', 'about it'],
    contentChunks = ['Hello', ', ', 'world'],
    finishReason = 'stop',
    chunkDelayMs = 0,
    failWith,
    emitGarbageFrame = false,
    errorMidStream = false,
    hang = false,
    requireApiKey,
    modelsPayload,
  } = options;

  const requests: MockProvider['requests'] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      });

      if (hang) return; // Never responds; the provider timeout must fire.

      if (requireApiKey !== undefined && req.headers.authorization !== `Bearer ${requireApiKey}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Invalid API Key', type: 'authentication_error', code: 401 },
          })
        );
        return;
      }

      if (req.url?.startsWith('/v1/models') === true) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (modelsPayload !== undefined) {
          res.end(
            typeof modelsPayload === 'string' ? modelsPayload : JSON.stringify(modelsPayload)
          );
          return;
        }
        res.end(
          JSON.stringify({
            object: 'list',
            data: models.map((id) => ({
              id,
              aliases: [],
              tags: [],
              object: 'model',
              owned_by: 'llamacpp',
              created: 1_789_106_755,
              // Mirrors the real payload: this leaks the API key path and must
              // never reach a response (INV-04). Tests assert it does not.
              status: {
                value: id === 'GPT' ? 'loaded' : 'unloaded',
                args: [
                  '/app/llama-server',
                  '--api-key-file',
                  '/run/api-key',
                  '--model',
                  `/models/${id}.gguf`,
                ],
                preset: `[${id}]\napi-key-file = /run/api-key\n`,
              },
              architecture: {
                input_modalities: id === 'GPT' ? ['text'] : ['text', 'image'],
                output_modalities: ['text'],
              },
              source: 'preset',
              can_remove: false,
            })),
          })
        );
        return;
      }

      if (req.url?.startsWith('/v1/chat/completions') === true) {
        if (failWith !== undefined) {
          res.writeHead(failWith.status, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: failWith.status,
                message: failWith.message ?? 'mock failure',
                type: failWith.type ?? 'invalid_request_error',
              },
            })
          );
          return;
        }

        void streamCompletion(res, {
          reasoningChunks,
          contentChunks,
          finishReason,
          chunkDelayMs,
          emitGarbageFrame,
          errorMidStream,
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found', code: 404 } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function streamCompletion(
  res: ServerResponse,
  opts: {
    reasoningChunks: string[];
    contentChunks: string[];
    finishReason: string;
    chunkDelayMs: number;
    emitGarbageFrame: boolean;
    errorMidStream: boolean;
  }
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const envelope = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
    choices,
    created: 1_789_108_669,
    id: CHUNK_ID,
    model: 'GPT',
    system_fingerprint: 'b10853-mock',
    object: 'chat.completion.chunk',
    ...extra,
  });

  try {
    // First chunk: role with a NULL content — exactly as observed live.
    send(
      envelope([{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }])
    );

    if (opts.emitGarbageFrame) res.write('data: {not json at all\n\n');

    for (const text of opts.reasoningChunks) {
      if (res.writableEnded) return;
      await wait(opts.chunkDelayMs);
      send(envelope([{ finish_reason: null, index: 0, delta: { reasoning_content: text } }]));
    }

    if (opts.errorMidStream) {
      send({ error: { message: 'exploded', code: 500, type: 'server_error' } });
      res.end();
      return;
    }

    for (const text of opts.contentChunks) {
      if (res.writableEnded) return;
      await wait(opts.chunkDelayMs);
      send(envelope([{ finish_reason: null, index: 0, delta: { content: text } }]));
    }

    if (res.writableEnded) return;
    send(envelope([{ finish_reason: opts.finishReason, index: 0, delta: {} }]));

    // Final chunk: EMPTY choices array plus usage — the shape that breaks
    // naive parsers (provider notes §5).
    send(
      envelope([], {
        usage: { completion_tokens: 5, prompt_tokens: 8, total_tokens: 13 },
        timings: { predicted_per_second: 86.0 },
      })
    );

    res.write('data: [DONE]\n\n');
    res.end();
  } catch {
    // The client went away mid-write; nothing to do.
  }
}
