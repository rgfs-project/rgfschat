import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger.ts';
import { LlamaCppProvider } from './llamacpp.ts';
import { DEFAULT_HOST_POLICY } from './ssrf.ts';
import { AppError } from '../errors/AppError.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * What happens when the provider does not stop.
 *
 * An administrator configures the provider and it is reached over the network,
 * which makes it something this process trusts but cannot control. A
 * compromised or simply broken one can stream forever, and every byte is
 * accumulated in memory and checkpointed to disk — so the answer needs a bound
 * of its own, not only the request.
 */

const logger = createLogger({ level: 'error', write: () => undefined });

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

/** A provider that streams `frame` forever, never ending. */
async function endlessProvider(frame: string): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

    // Written on a timer so the socket does not simply block, and so the test
    // can be torn down between writes.
    const timer = setInterval(() => {
      if (!res.write(frame)) return;
    }, 1);
    res.on('close', () => clearInterval(timer));
  });

  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

async function drain(baseUrl: string, maxResponseBytes: number): Promise<unknown> {
  const provider = new LlamaCppProvider(
    {
      baseUrl,
      timeoutMs: 30_000,
      apiKey: undefined,
      defaultContextTokens: 8_192,
      maxOutputTokens: 128,
    },
    logger,
    {
      policy: { ...DEFAULT_HOST_POLICY, allowPrivateHosts: true },
      maxResponseBytes,
    }
  );

  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- draining, not reading
    for await (const _chunk of provider.streamChat({
      model: 'GPT',
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 16,
      signal: new AbortController().signal,
    })) {
      // Consumed and discarded; the cap is what should end this.
    }
  } catch (error) {
    return error;
  }
  return null;
}

describe('a provider that never stops', () => {
  it('is cut off once it exceeds the cap', async () => {
    // Well-formed frames, arriving without end.
    const frame = `data: ${JSON.stringify({
      choices: [{ index: 0, finish_reason: null, delta: { content: 'x'.repeat(512) } }],
    })}\n\n`;

    const error = await drain(await endlessProvider(frame), 64 * 1024);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_ERROR');
    expect((error as AppError).message).toMatch(/more data than/i);
  }, 30_000);

  it('is cut off when the data never forms a frame at all', async () => {
    /*
     * No blank line, ever. The byte counter alone would catch this eventually,
     * but the buffer it accumulates in is the thing that grows first — a
     * single frame of unbounded length is the same attack without any frame
     * boundary to count.
     */
    const error = await drain(await endlessProvider('x'.repeat(4096)), 64 * 1024);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_ERROR');
  }, 30_000);

  it('says nothing about the provider in the message it raises', async () => {
    const error = await drain(await endlessProvider('x'.repeat(4096)), 64 * 1024);

    // INV-04: no upstream body, no host, no port.
    const message = (error as AppError).message;
    expect(message).not.toMatch(/127\.0\.0\.1|http:|xxxx/);
  }, 30_000);
});
