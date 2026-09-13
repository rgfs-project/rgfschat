import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, type Page } from '@playwright/test';

/**
 * End-to-end fixtures.
 *
 * Each test gets its own server process, its own `DATA_DIR`, and a mock
 * provider whose stream the test controls. Nothing here talks to a real model:
 * the point is to exercise reconnection and cancellation deterministically, and
 * a real provider would make the timing a matter of luck.
 *
 * Setting `E2E_CONTAINER_IMAGE` runs the same suite against a container image
 * instead of `dist/` on the host — the whole point being that the specs do not
 * change, so a pass means the packaged image behaves like the tree it was built
 * from. See `startContainer` for the two things that mode has to arrange.
 */

export const ADMIN_USERNAME = 'e2e';
export const ADMIN_PASSWORD = 'correct horse battery';
const PROVIDER_KEY = 'e2e-provider-key';

/** Image to test instead of the host build, when running in container mode. */
const CONTAINER_IMAGE = process.env['E2E_CONTAINER_IMAGE'] ?? '';
/** `podman` and `docker` are interchangeable for everything used here. */
const CONTAINER_ENGINE = process.env['E2E_CONTAINER_ENGINE'] ?? 'podman';

/** Emits chunks only when the test asks for them. */
export interface MockProviderHandle {
  url: string;
  /** Sends one content chunk to every open stream. */
  send: (text: string) => void;
  /** Ends every open stream normally. */
  finish: () => void;
  close: () => Promise<void>;
  /** How many chat completions have been requested. */
  requests: number;
  /**
   * Resolves once the server has opened a stream to us.
   *
   * Sending before that would write into nothing — the test would look like a
   * lost-chunk bug when it is really just a race with connection setup.
   */
  waitForStream: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

async function startMockProvider(): Promise<MockProviderHandle> {
  const open = new Set<ServerResponse>();
  const handle: MockProviderHandle = {
    url: '',
    requests: 0,
    send: (text) => {
      for (const res of open) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, finish_reason: null, delta: { content: text } }],
            object: 'chat.completion.chunk',
          })}\n\n`
        );
      }
    },
    finish: () => {
      for (const res of open) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, finish_reason: 'stop', delta: {} }],
            object: 'chat.completion.chunk',
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      }
      open.clear();
    },
    close: () => Promise.resolve(),
    waitForStream: async () => {
      for (let i = 0; i < 300; i += 1) {
        if (open.size > 0) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('provider stream never opened');
    },
  };

  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url?.startsWith('/v1/models') === true) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            /*
             * Two models on purpose. `e2e-model` is first and so is what the
             * client defaults to, which keeps every existing test unchanged;
             * `e2e-vision` exists so the attachment tests can exercise both
             * sides of the capability check against a real catalogue.
             */
            data: [
              { id: 'e2e-model', architecture: { input_modalities: ['text'] } },
              { id: 'e2e-vision', architecture: { input_modalities: ['text', 'image'] } },
            ],
          })
        );
        return;
      }

      if (req.url?.startsWith('/v1/chat/completions') === true) {
        handle.requests += 1;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(
          `data: ${JSON.stringify({
            choices: [
              { index: 0, finish_reason: null, delta: { role: 'assistant', content: null } },
            ],
            object: 'chat.completion.chunk',
          })}\n\n`
        );
        open.add(res);
        res.on('close', () => open.delete(res));
        return;
      }

      res.writeHead(404).end('{}');
    });
  });

  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  handle.url = `http://127.0.0.1:${port}`;
  handle.close = () =>
    new Promise<void>((resolve) => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return handle;
}

export interface AppFixture {
  baseUrl: string;
  dataDir: string;
  provider: MockProviderHandle;
}

/**
 * A running server, however it was started.
 *
 * `died` lets the health wait fail immediately with the reason instead of
 * spending its whole timeout polling something that has already crashed —
 * without it, a container that exits on a bad mount looks identical to one that
 * is merely slow.
 */
interface ServerHandle {
  died: () => Promise<string | null>;
  logs: () => Promise<string>;
  stop: () => Promise<void>;
}

type ServerEnv = Record<string, string>;

function engine(args: string[], input?: string): string {
  const result = spawnSync(CONTAINER_ENGINE, args, {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
  if (result.status !== 0) {
    throw new Error(
      `${CONTAINER_ENGINE} ${args.slice(0, 2).join(' ')} failed: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

/** The host build: what every run did before container mode existed. */
function startHostServer(env: ServerEnv): ServerHandle {
  spawnSync(
    'npx',
    ['tsx', 'server/scripts/createUser.ts', '--username', ADMIN_USERNAME, '--admin'],
    {
      input: `${ADMIN_PASSWORD}\n`,
      env,
      encoding: 'utf8',
    }
  );

  const child: ChildProcess = spawn(process.execPath, ['dist/server/index.js'], {
    env,
    stdio: 'ignore',
  });

  return {
    died: () => Promise.resolve(child.exitCode === null ? null : `exit ${child.exitCode}`),
    logs: () => Promise.resolve('(host server runs with stdio ignored)'),
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    },
  };
}

/**
 * The packaged image, driven so that the specs cannot tell the difference.
 *
 * Two things have to be arranged for that to hold:
 *
 * `--userns=keep-id` maps this user to the same uid inside the container, which
 * is the image's unprivileged `node` user. Without it a rootless bind mount is
 * written as a subordinate uid and the fixtures that seed conversations by
 * writing files — and read them back — would be looking at a directory they
 * cannot touch.
 *
 * `--network=host` because the mock provider listens on the host's loopback.
 * The container has to reach it, and the server has to be reachable on the port
 * the test picked; sharing the namespace is the one arrangement that needs no
 * address rewriting on either side, and the provider URL stays literally what
 * the host build is given.
 */
function startContainer(env: ServerEnv, dataDir: string): ServerHandle {
  const name = `chatui-e2e-${randomUUID().slice(0, 8)}`;
  // Only the variables the image does not already set; DATA_DIR stays /data.
  const passthrough = ['PORT', 'LOG_LEVEL', 'LLAMA_BASE_URL', 'LLAMA_API_KEY', 'SSE_REPLAY_EVENTS'];
  const envArgs = passthrough.flatMap((key) => ['-e', `${key}=${env[key] ?? ''}`]);
  const mount = ['--userns=keep-id', '--network=host', '-v', `${dataDir}:/data`];

  engine(
    [
      'run',
      '-i',
      '--rm',
      ...mount,
      CONTAINER_IMAGE,
      'create-admin',
      '--username',
      ADMIN_USERNAME,
      '--admin',
    ],
    `${ADMIN_PASSWORD}\n`
  );

  engine(['run', '-d', '--name', name, ...mount, ...envArgs, CONTAINER_IMAGE]);

  return {
    died: () => {
      const state = spawnSync(CONTAINER_ENGINE, ['inspect', '-f', '{{.State.Running}}', name], {
        encoding: 'utf8',
      });
      if (state.status !== 0) return Promise.resolve('container is gone');
      return Promise.resolve(state.stdout.trim() === 'true' ? null : 'container is not running');
    },
    logs: () =>
      Promise.resolve(
        spawnSync(CONTAINER_ENGINE, ['logs', '--tail', '40', name], { encoding: 'utf8' }).stdout ??
          ''
      ),
    stop: () => {
      spawnSync(CONTAINER_ENGINE, ['rm', '-f', name], { encoding: 'utf8' });
      return Promise.resolve();
    },
  };
}

async function waitForHealth(baseUrl: string, server: ServerHandle): Promise<void> {
  const deadline = Date.now() + 60_000;
  let polls = 0;
  while (Date.now() < deadline) {
    // Checking liveness costs a subprocess in container mode, so do it every
    // second rather than every attempt.
    if (polls % 10 === 0) {
      const dead = await server.died();
      if (dead !== null) throw new Error(`server ${dead}\n${await server.logs()}`);
    }
    polls += 1;
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never became healthy\n${await server.logs()}`);
}

export const test = base.extend<{ app: AppFixture }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature
  app: async ({}, use) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-e2e-'));
    const provider = await startMockProvider();
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const env = {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: 'production',
      LOG_LEVEL: 'error',
      LLAMA_BASE_URL: provider.url,
      LLAMA_API_KEY: PROVIDER_KEY,
      // A tiny replay window would hide replay bugs behind resyncs.
      SSE_REPLAY_EVENTS: '2000',
    } as ServerEnv;

    // Creating the account is part of starting a server: it must exist before
    // the UI is opened, and in container mode it is the image's own CLI that
    // has to do it.
    const server = CONTAINER_IMAGE === '' ? startHostServer(env) : startContainer(env, dataDir);

    try {
      await waitForHealth(baseUrl, server);
      await use({ baseUrl, dataDir, provider });
    } finally {
      // A failed start must still not leak a container or a temp directory.
      await server.stop();
      await provider.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
});

export { expect } from '@playwright/test';

/**
 * Signs in through the real login form and lands on the chat view.
 *
 * Waits on the composer rather than on "New chat". The latter lives inside the
 * sidebar, and below the breakpoint the sidebar is a closed drawer — so on any
 * narrow viewport this waited for a control that was deliberately hidden and
 * timed out after a minute. The composer is in the main column at every width,
 * and it appears only once signed in, which is the thing being waited for.
 */
export async function signIn(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl);
  await page.getByLabel('Username').fill(ADMIN_USERNAME);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await composerField(page).waitFor();
}

/** Creates a conversation and sends one message, leaving it mid-stream. */
export async function startGeneration(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'New chat' }).click();
  const composer = composerField(page);
  // The composer is disabled until a conversation exists and a model is chosen.
  await expectEnabled(composer);
  await composer.fill(text);
  await composer.press('Enter');
}

/** The message field, addressed by its label so the placeholder can change. */
export function composerField(page: Page) {
  return page.getByLabel('Message', { exact: true });
}

async function expectEnabled(locator: ReturnType<typeof composerField>): Promise<void> {
  await locator.waitFor();
  for (let i = 0; i < 200; i += 1) {
    if (await locator.isEnabled()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('composer never became enabled');
}

/**
 * Creates `count` conversations on disk, each with one distinguishable message.
 *
 * New chat no longer creates anything — a conversation begins when a message is
 * sent — so a test that needs conversations to exist either drives a generation
 * per conversation, which tests the provider rather than the thing under test,
 * or writes them. This writes them with the server's own serializer, and drops
 * the derived index so the server rebuilds it from what is actually there.
 *
 * Returns the marker written into each, so a test can tell which one it is
 * looking at.
 *
 * **Call this before `signIn`, not after.** Dropping the index while a page is
 * already loaded races the server: a `GET /conversations` still in flight from
 * that page rebuilds and writes the index, and if that write lands after this
 * delete, the reload is served a stale index listing nothing. Seeding before
 * anything has loaded closes the window rather than waiting it out.
 */
export interface SeedOptions {
  /** The body of each seeded message, when the marker alone is not enough —
      a wide code block, say, for a test about horizontal overflow. */
  body?: string;
  /** How many user messages each conversation gets, for tests that need the
      transcript to be taller than the viewport. Defaults to one. */
  messages?: number;
}

export async function seedConversations(
  dataDir: string,
  count: number,
  options: SeedOptions = {}
): Promise<string[]> {
  const { serializeConversation } = await import('../server/storage/markdown.ts');
  const { FORMAT_VERSION } = await import('../shared/conversation.ts');

  // `_system` holds users and sessions; the conversation directories are the
  // per-user ones beside it.
  const userId = (await readdir(dataDir)).find((name) => !name.startsWith('_'));
  if (userId === undefined) throw new Error('seed: no user directory');

  const chats = join(dataDir, userId, 'chats');
  await mkdir(chats, { recursive: true });

  const markers: string[] = [];
  const now = new Date().toISOString();

  const perConversation = Math.max(1, options.messages ?? 1);

  for (let index = 0; index < count; index += 1) {
    const marker = `marker-for-conversation-${index}`;
    markers.push(marker);

    // The marker stays in the first message whatever the body is, so a test
    // can still find the conversation it seeded.
    const messages = Array.from({ length: perConversation }, (_unused, position) => ({
      type: 'user' as const,
      id: randomUUID(),
      body: position === 0 ? (options.body ?? marker) : `${marker} line ${position}`,
    }));

    await writeFile(
      join(chats, `${randomUUID()}.md`),
      serializeConversation({
        formatVersion: FORMAT_VERSION,
        title: `Conversation ${index}`,
        createdAt: now,
        updatedAt: now,
        messages,
      }),
      'utf8'
    );
  }

  // Derived, deletable, rebuildable — so deleting it is how a fixture tells the
  // server that what is on disk has changed underneath it.
  await rm(join(dataDir, userId, 'index', 'chats.json'), { force: true });

  return markers;
}

/**
 * Grows an existing conversation to `count` user messages by rewriting its file.
 *
 * There is no API for appending a message — messages only come from a
 * generation — and driving 200 generations through the mock provider would take
 * minutes and test the provider rather than the layout. Writing the file with
 * the same serializer the server uses keeps the fixture honest: if the format
 * changed underneath it, this would produce a file the server rejects.
 */
export async function seedMessages(dataDir: string, count: number): Promise<void> {
  const { parseConversation, serializeConversation } =
    await import('../server/storage/markdown.ts');

  const file = await findOnlyConversationFile(dataDir);
  const parsed = parseConversation(await readFile(file, 'utf8'));
  if (!parsed.ok) throw new Error('seed: existing conversation did not parse');

  const messages = Array.from({ length: count }, (_, i) => ({
    type: 'user' as const,
    id: randomUUID(),
    body: `seeded message number ${i}`,
  }));

  await writeFile(file, serializeConversation({ ...parsed.conversation, messages }), 'utf8');
}

/** Locates the single chat file under a fresh DATA_DIR. */
async function findOnlyConversationFile(dataDir: string): Promise<string> {
  for (const userId of await readdir(dataDir)) {
    const chats = join(dataDir, userId, 'chats');
    const entries = await readdir(chats).catch(() => [] as string[]);
    const first = entries.find((name) => name.endsWith('.md'));
    if (first !== undefined) return join(chats, first);
  }
  throw new Error('seed: no conversation file found');
}
