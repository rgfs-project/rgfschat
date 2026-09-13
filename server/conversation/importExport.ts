import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import {
  AUTO_TITLE_MAX_LENGTH,
  FORMAT_VERSION,
  isCanonicalUuid,
  TITLE_MAX_LENGTH,
  type Conversation,
  type Message,
} from '@shared/conversation.ts';

/**
 * Reading a Claude data export.
 *
 * Shared by the command-line importer and the route behind the settings panel,
 * so the two cannot disagree about what an export means. Everything here is
 * pure: it takes bytes and returns conversations, and the caller decides where
 * they go.
 */

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

export const exportSchema = z.array(conversationSchema);

export const memoriesFileSchema = z
  .object({
    memory_files: z.array(z.object({ path: z.string(), content: z.string() }).passthrough()),
  })
  .passthrough();

/** What a conversion left behind, so a report can say it out loud. */
export interface Dropped {
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

/**
 * The export's own timestamp for one message, when it is usable.
 *
 * Unlike `isoOr` there is no fallback worth having: the conversation's
 * `created_at` is not when this message was sent, and stamping every message
 * with the moment of the import would be inventing a history. A message whose
 * time cannot be read is written without one.
 */
function messageTime(value: string): string | undefined {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

export interface Converted {
  id: string;
  conversation: Conversation;
  dropped: Dropped;
  /** It had messages, and none of them survived conversion. */
  emptied: boolean;
}

export function convertConversation(source: z.infer<typeof conversationSchema>): Converted {
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

    const time = messageTime(message.created_at);

    if (message.sender === 'human') {
      messages.push({ type: 'user', id, body, ...(time === undefined ? {} : { time }) });
    } else {
      messages.push({
        type: 'assistant',
        id,
        status: 'complete',
        body,
        ...(reasoning === '' ? {} : { reasoning }),
        ...(time === undefined ? {} : { time }),
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
 * how two different paths still arrive as two different memories.
 */
export function memoryNameFrom(path: string, maxLength: number): string {
  const name = path
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return name === '' ? 'memory' : name;
}

export interface ExportContents {
  conversations: z.infer<typeof exportSchema>;
  memories: { path: string; content: string }[];
}

/**
 * Finds what can be imported in whatever was uploaded.
 *
 * An export is delivered as several archives, and people hand over whichever
 * one they have — the whole zip, one of its members, or the bare JSON. So the
 * bytes are examined rather than the filename trusted: a zip is unpacked and
 * its members read, and anything else is tried as JSON.
 *
 * Unrecognised members are ignored rather than refused, because an export
 * carries files this application has no use for and refusing the archive over
 * them would make the common case impossible.
 */
export function readExport(bytes: Uint8Array): ExportContents {
  const found: ExportContents = { conversations: [], memories: [] };

  const files = isZip(bytes) ? unzipSync(bytes) : { 'upload.json': bytes };
  const decoder = new TextDecoder();

  for (const [name, content] of Object.entries(files)) {
    if (content.length === 0 || !name.toLowerCase().endsWith('.json')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(content));
    } catch {
      continue;
    }

    const conversations = exportSchema.safeParse(parsed);
    if (conversations.success) {
      found.conversations.push(...conversations.data);
      continue;
    }

    const memories = memoriesFileSchema.safeParse(parsed);
    if (memories.success) found.memories.push(...memories.data.memory_files);
  }

  return found;
}

/** `PK\x03\x04`, the local file header every zip begins with. */
function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
