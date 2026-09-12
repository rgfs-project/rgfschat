import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { AttachmentStore } from '../attachments/store.ts';
import { ConversationStore } from './conversations.ts';
import { ChatIndex } from './index.ts';
import { StoragePaths } from './paths.ts';

/**
 * Backing up `data/` and restoring it into a fresh directory.
 *
 * The documented procedure, executed. A backup procedure that has never been
 * restored is a belief rather than a plan, and the specific belief worth
 * testing here is that `index/` really is derived: the restore deliberately
 * omits it, and everything must still come back.
 */

const logger = createLogger({ level: 'error', write: () => undefined });
const USER = '77777777-7777-4777-8777-777777777777';

let source: string;
let target: string;

// eslint-disable-next-line @typescript-eslint/require-await -- stands in for a request stream
async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

function storesFor(dataDir: string): {
  paths: StoragePaths;
  store: ConversationStore;
  index: ChatIndex;
  attachments: AttachmentStore;
  users: UserStore;
} {
  const paths = new StoragePaths(dataDir);
  const store = new ConversationStore({ paths, logger });
  return {
    paths,
    store,
    index: new ChatIndex({ store, logger }),
    attachments: new AttachmentStore(paths, {
      maxBytes: 1_000_000,
      maxTotalBytesPerUser: 10_000_000,
      pendingTtlMs: 60_000,
      maxImagePixels: 50_000_000,
    }),
    users: new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS }),
  };
}

beforeEach(async () => {
  source = await mkdtemp(join(tmpdir(), 'backup-source-'));
  target = await mkdtemp(join(tmpdir(), 'backup-target-'));
});

afterEach(async () => {
  await rm(source, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

describe('backup and restore', () => {
  it('restores conversations, attachments and accounts into a fresh DATA_DIR', async () => {
    const original = storesFor(source);

    // A realistic instance: an account, a conversation, and a file attached
    // to a message in it.
    const account = await original.users.create({
      username: 'keeper',
      password: 'a-good-password',
    });

    const attachmentsFor = new AttachmentStore(new StoragePaths(source), {
      maxBytes: 1_000_000,
      maxTotalBytesPerUser: 10_000_000,
      pendingTtlMs: 60_000,
      maxImagePixels: 50_000_000,
    });
    await attachmentsFor.ensureUserDir(account.id);
    const { meta } = await attachmentsFor.create(
      account.id,
      'notes.md',
      once(new Uint8Array(Buffer.from('# Kept\n', 'utf8')))
    );

    const { id: conversationId } = await original.store.create(account.id, 'Worth keeping');
    await original.store.update(account.id, conversationId, (current) => ({
      ...current,
      messages: [{ type: 'user', id: USER, body: 'the message', attachments: [meta.id] }],
    }));
    await original.index.rebuild(account.id);

    /*
     * The backup, as documented: everything under `data/` except `index/`,
     * which is derived. Sessions and generations are also skippable; they are
     * kept here so the copy is the simple one an operator would actually run.
     */
    await cp(source, target, {
      recursive: true,
      filter: (path) => !path.includes(`${join('', 'index')}`),
    });

    // Nothing pre-warmed: a fresh process reading a restored directory.
    const restored = storesFor(target);

    const conversation = await restored.store.load(account.id, conversationId);
    expect(conversation.title).toBe('Worth keeping');
    const restoredMessage = conversation.messages[0];
    expect(restoredMessage?.type).toBe('user');
    expect(restoredMessage?.type === 'user' ? restoredMessage.attachments : undefined).toEqual([
      meta.id,
    ]);

    // The attachment's bytes and metadata both survived.
    const restoredMeta = await restored.attachments.read(account.id, meta.id);
    expect(restoredMeta.sha256).toBe(meta.sha256);
    expect((await restored.attachments.bytes(account.id, meta.id)).toString('utf8')).toBe(
      '# Kept\n'
    );

    // The account is there, and its password still verifies — so the hash was
    // restored intact rather than re-created.
    const verified = await restored.users.verify('keeper', 'a-good-password');
    expect(verified?.id).toBe(account.id);
  });

  it('rebuilds the index it was restored without (INV-11)', async () => {
    const original = storesFor(source);
    const account = await original.users.create({
      username: 'keeper',
      password: 'a-good-password',
    });
    const { id } = await original.store.create(account.id, 'Findable');
    await original.index.rebuild(account.id);

    await cp(source, target, {
      recursive: true,
      filter: (path) => !path.includes(`${join('', 'index')}`),
    });

    const restored = storesFor(target);
    // Absent, as the backup left it.
    await expect(readdir(join(target, account.id, 'index'))).rejects.toThrow();

    const listed = await restored.index.rebuild(account.id);

    expect(listed.map((entry) => entry.id)).toContain(id);
  });

  it('a backup contains secrets, which is why it is one', async () => {
    /*
     * Not a behaviour to fix — an assertion that the documentation is telling
     * the truth. `providers.json` holds API keys at rest (contracts §1), so a
     * backup of `data/` is a secret-bearing artefact and README and
     * SECURITY.md say so.
     */
    const systemDir = join(source, '_system');
    await cp(join(source), join(source), { recursive: true }).catch(() => undefined);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(systemDir, { recursive: true });
    await writeFile(
      join(systemDir, 'providers.json'),
      JSON.stringify({ providers: [{ id: 'local', apiKey: 'sentinel-key-in-backup' }] }),
      'utf8'
    );

    await cp(source, target, { recursive: true });

    const copied = await readFile(join(target, '_system', 'providers.json'), 'utf8');
    expect(copied).toContain('sentinel-key-in-backup');
  });
});
