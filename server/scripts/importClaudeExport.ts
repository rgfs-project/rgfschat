import { readFile } from 'node:fs/promises';
import { normalizeUsername } from '@shared/auth.ts';
import {
  convertConversation,
  exportSchema,
  memoriesFileSchema,
  memoryNameFrom,
} from '../conversation/importExport.ts';
import { loadConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { UserStore } from '../auth/users.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { MEMORY_NAME_MAX_LENGTH, StoragePaths } from '../storage/paths.ts';
import { MemoryStore } from '../storage/memories.ts';
import { pathExists } from '../storage/atomic.ts';

/**
 * Imports a Claude.ai data export into an account (contracts §3).
 *
 *   npm run import:claude -- --username ada --file conversations.json
 *   npm run import:claude -- --username ada --memories memories.json
 *   npm run import:claude -- --username ada --file conversations.json --dry-run
 *
 * `conversations.json` and `memories.json` come from the archives of the same
 * names; either may be given, or both.
 *
 * The other two archives an export carries are recognised and refused with a
 * reason rather than quietly ignored: `feedback` is monthly reflections on how
 * *that* product was used, and `light_metadata` is the account's profile and
 * its login history. Neither describes anything this application holds, and a
 * login history imported from somewhere else would be a record of events that
 * never happened here.
 *
 * Conversations are written through the same serializer the server uses, so
 * anything this produces is a file the server can read; a round trip through
 * the parser proves it before the file lands. Nothing existing is overwritten:
 * an id already present is skipped, so running it twice imports nothing twice.
 */

interface Options {
  username: string;
  file: string;
  memories: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  let username = '';
  let file = '';
  let memories = '';
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--username' || arg === '-u') {
      username = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--file' || arg === '-f') {
      file = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--memories' || arg === '-m') {
      memories = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--feedback' || arg === '--metadata') {
      // Named so the refusal is specific; see the note at the top of the file.
      throw new Error(
        `${arg} cannot be imported: it describes the other product's account, not conversations. ` +
          'Reflections and login history have nothing here to import into.'
      );
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg !== undefined && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (username === '' || (file === '' && memories === '')) {
    throw new Error(
      'Usage: npm run import:claude -- --username <name> ' +
        '[--file <conversations.json>] [--memories <memories.json>] [--dry-run]'
    );
  }
  return { username, file, memories, dryRun };
}

/* --- the script ----------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger({ level: 'silent', write: () => {} });
  const paths = new StoragePaths(config.dataDir);

  const users = new UserStore({ paths, logger });
  const account = await users.findByUsername(normalizeUsername(options.username));
  if (account === null) throw new Error(`No such account: ${options.username}`);

  let conversations: ReturnType<typeof exportSchema.parse> = [];
  if (options.file !== '') {
    const parsed = exportSchema.safeParse(
      JSON.parse(await readFile(options.file, 'utf8')) as unknown
    );
    if (!parsed.success) {
      throw new Error(
        `${options.file} is not a Claude conversations export: ${parsed.error.issues[0]?.message ?? 'unrecognised shape'}`
      );
    }
    conversations = parsed.data;
  }

  const store = new ConversationStore({ paths, logger });
  const index = new ChatIndex({ store, logger });
  const memoryStore = new MemoryStore(paths, logger);
  await store.init(account.id);

  const report = {
    imported: 0,
    skippedExisting: 0,
    skippedEmpty: 0,
    toolBlocks: 0,
    attachments: 0,
  };

  for (const source of conversations) {
    const { id, conversation, dropped, emptied } = convertConversation(source);
    report.toolBlocks += dropped.toolBlocks;
    report.attachments += dropped.attachments;

    if (conversation.messages.length === 0) {
      report.skippedEmpty += 1;
      process.stdout.write(
        `  skipped  ${conversation.title}${emptied ? ' (nothing importable in it)' : ' (no messages)'}\n`
      );
      continue;
    }

    const file = paths.conversationFile(account.id, id);
    if (await pathExists(file)) {
      report.skippedExisting += 1;
      process.stdout.write(`  present  ${conversation.title}\n`);
      continue;
    }

    if (!options.dryRun) await store.writeImported(account.id, id, conversation);

    report.imported += 1;
    process.stdout.write(
      `  ${options.dryRun ? 'would  ' : 'ok     '}  ${conversation.title} (${conversation.messages.length} messages)\n`
    );
  }

  if (!options.dryRun && report.imported > 0) await index.rebuild(account.id);

  /* --- memories ---------------------------------------------------------- */

  let remembered = 0;
  if (options.memories !== '') {
    const parsed = memoriesFileSchema.safeParse(
      JSON.parse(await readFile(options.memories, 'utf8')) as unknown
    );
    if (!parsed.success) {
      throw new Error(`${options.memories} is not a Claude memories export.`);
    }

    for (const file of parsed.data.memory_files) {
      const name = memoryNameFrom(file.path, MEMORY_NAME_MAX_LENGTH);
      if (!options.dryRun) await memoryStore.write(account.id, name, file.content);
      remembered += 1;
      process.stdout.write(
        `  ${options.dryRun ? 'would  ' : 'ok     '}  memory ${name} (${Buffer.byteLength(file.content)} bytes)\n`
      );
    }
  }

  process.stdout.write(
    `\n${options.dryRun ? 'Dry run. ' : ''}${report.imported} conversation(s) imported, ` +
      `${report.skippedExisting} already present, ${report.skippedEmpty} empty. ` +
      `${remembered} memory/memories imported.\n` +
      (report.toolBlocks > 0 ? `${report.toolBlocks} tool block(s) left out.\n` : '') +
      (report.attachments > 0
        ? `${report.attachments} attachment(s): the text read out of them was kept, the files were not.\n`
        : '')
  );
}

await main();
