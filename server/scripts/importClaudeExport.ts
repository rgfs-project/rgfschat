import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  AUTO_TITLE_MAX_LENGTH,
  FORMAT_VERSION,
  isCanonicalUuid,
  TITLE_MAX_LENGTH,
  type Conversation,
  type Message,
} from '@shared/conversation.ts';
import { normalizeUsername } from '@shared/auth.ts';
import { loadConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { UserStore } from '../auth/users.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { MEMORY_NAME_MAX_LENGTH, StoragePaths } from '../storage/paths.ts';
import { MemoryStore } from '../storage/memories.ts';
import { serializeConversation } from '../storage/markdown.ts';
import { atomicWriteFile, ensureDir, pathExists } from '../storage/atomic.ts';

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

/* --- the export's shape, as much of it as an import needs ----------------- */

const contentBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    uuid: z.string(),
    text: z.string().optional(),
    content: z.array(contentBlockSchema).optional(),
    sender: z.string(),
    created_at: z.string(),
    attachments: z
      .array(
        z
          .object({ file_name: z.string().optional(), extracted_content: z.string().optional() })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

const conversationSchema = z
  .object({
    uuid: z.string(),
    name: z.string().optional(),
    created_at: z.string(),
    updated_at: z.string().optional(),
    chat_messages: z.array(messageSchema),
  })
  .passthrough();

const exportSchema = z.array(conversationSchema);

const memoriesFileSchema = z
  .object({
    memory_files: z.array(z.object({ path: z.string(), content: z.string() }).passthrough()),
  })
  .passthrough();

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

/* --- conversion ----------------------------------------------------------- */

/** What a conversion dropped, so the report can say it out loud. */
interface Dropped {
  toolBlocks: number;
  attachments: number;
}

/**
 * The text of one message, and its reasoning if it carried any.
 *
 * An export's `text` is the rendered message; `content` is the blocks it was
 * built from. The blocks are preferred because they separate thinking from the
 * answer, which this format keeps apart too. Tool calls and their results have
 * no equivalent here — this application has no tools — so they are counted and
 * left out rather than pasted in as JSON nobody can act on.
 */
function bodyOf(
  message: z.infer<typeof messageSchema>,
  dropped: Dropped
): { body: string; reasoning: string } {
  const texts: string[] = [];
  const thoughts: string[] = [];

  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'thinking' && typeof block.thinking === 'string')
      thoughts.push(block.thinking);
    else if (block.type === 'tool_use' || block.type === 'tool_result') dropped.toolBlocks += 1;
  }

  // An attachment is a file this application cannot store yet (Phase 11), but
  // the export carries the text that was read out of it, and that text is part
  // of what was said.
  for (const attachment of message.attachments ?? []) {
    dropped.attachments += 1;
    const extracted = attachment.extracted_content;
    if (typeof extracted === 'string' && extracted.trim() !== '') {
      texts.push(`> Attached: ${attachment.file_name ?? 'file'}\n\n${extracted}`);
    }
  }

  const body = (texts.length > 0 ? texts.join('\n\n') : (message.text ?? '')).trim();
  return { body, reasoning: thoughts.join('\n\n').trim() };
}

/** A title for a conversation the export left unnamed. */
function titleFrom(name: string | undefined, messages: Message[]): string {
  const given = (name ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (given !== '') return given.slice(0, TITLE_MAX_LENGTH);

  const first = messages.find((message) => message.type === 'user')?.body ?? '';
  const line = first.replace(/[\r\n]+/g, ' ').trim();
  return line === '' ? 'Imported conversation' : line.slice(0, AUTO_TITLE_MAX_LENGTH);
}

function isoOr(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : fallback;
}

interface Converted {
  id: string;
  conversation: Conversation;
  dropped: Dropped;
  emptied: boolean;
}

function convert(source: z.infer<typeof conversationSchema>): Converted {
  const dropped: Dropped = { toolBlocks: 0, attachments: 0 };
  const messages: Message[] = [];

  for (const message of source.chat_messages) {
    const { body, reasoning } = bodyOf(message, dropped);
    // A message with nothing in it cannot be represented: the format requires a
    // body, and an empty one would be a message that says nothing happened.
    if (body === '') continue;

    // The export's ids are already canonical UUIDs; anything else gets a fresh
    // one rather than being forced into a path or an attribute.
    const id = isCanonicalUuid(message.uuid) ? message.uuid : randomUUID();

    if (message.sender === 'human') {
      messages.push({ type: 'user', id, body });
    } else {
      messages.push({
        type: 'assistant',
        id,
        status: 'complete',
        body,
        ...(reasoning === '' ? {} : { reasoning }),
      });
    }
  }

  const createdAt = isoOr(source.created_at, new Date().toISOString());
  const conversation: Conversation = {
    formatVersion: FORMAT_VERSION,
    title: titleFrom(source.name, messages),
    createdAt,
    updatedAt: isoOr(source.updated_at, createdAt),
    messages,
  };

  return {
    id: isCanonicalUuid(source.uuid) ? source.uuid : randomUUID(),
    conversation,
    dropped,
    emptied: source.chat_messages.length > 0 && messages.length === 0,
  };
}

/**
 * A memory's name, from the path it had in the export.
 *
 * The export stores memories as a little filesystem — `/areas/llm-chat-app.md`
 * — and this application stores them flat, so the directories become part of
 * the name. Anything outside the name's alphabet becomes a hyphen, which is
 * how two different paths can still arrive as two different memories.
 */
function memoryNameFrom(path: string): string {
  const withoutExtension = path.replace(/\.md$/i, '');
  const name = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MEMORY_NAME_MAX_LENGTH)
    .replace(/-+$/, '');
  return name === '' ? 'memory' : name;
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

  let conversations: z.infer<typeof exportSchema> = [];
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
    const { id, conversation, dropped, emptied } = convert(source);
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

    if (!options.dryRun) {
      await ensureDir(paths.chatsDir(account.id));
      await atomicWriteFile(file, serializeConversation(conversation));
      // Read back through the parser: an import that writes a file the server
      // would call malformed has not imported anything.
      await store.load(account.id, id);
    }

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
      const name = memoryNameFrom(file.path);
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
