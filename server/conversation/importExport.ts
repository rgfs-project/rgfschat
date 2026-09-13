import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import {
  artifactMediaTypeFor,
  isArtifactMediaType,
  type ArtifactMediaType,
} from '@shared/artifact.ts';
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

/**
 * The blocks an artifact arrives in.
 *
 * The current export splits one artifact across a *pair*: `create_file` in a
 * `tool_use` carries the bytes, and `present_files` in the matching
 * `tool_result` carries the metadata that makes it an artifact rather than a
 * scratch file. `file_path` is the join key.
 *
 * The older export used a single `tool_use` named `artifacts` carrying
 * everything at once. Both are read, because a reader's archive can reach back
 * further than the format does — an account with artifacts from before the
 * change would otherwise import as nothing at all.
 */
const contentBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    name: z.string().optional(),
    input: z
      .object({
        // create_file
        path: z.string().optional(),
        file_text: z.string().optional(),
        description: z.string().optional(),
        // the legacy `artifacts` tool
        command: z.string().optional(),
        title: z.string().optional(),
        content: z.string().optional(),
        type: z.string().optional(),
        language: z.string().optional(),
      })
      .passthrough()
      .optional(),
    content: z
      .array(
        z
          .object({
            type: z.string().optional(),
            file_path: z.string().optional(),
            name: z.string().optional(),
            mime_type: z.string().optional(),
            artifact_publishable: z.boolean().optional(),
          })
          .passthrough()
      )
      .optional(),
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
    memory_files: z.array(
      z
        .object({ path: z.string(), content: z.string(), updated_at: z.string().optional() })
        .passthrough()
    ),
  })
  .passthrough();

/** What a conversion left behind, so a report can say it out loud. */
export interface Dropped {
  toolBlocks: number;
  attachments: number;
}

/** One artifact recovered from a conversation, ready for the store. */
export interface ImportedArtifact {
  name: string;
  mediaType: ArtifactMediaType;
  content: string;
  description?: string | undefined;
  createdAt?: string | undefined;
}

/**
 * The artifacts one message produced.
 *
 * Written as a pass over a single message because that is the unit the pairing
 * holds in: a `create_file` and the `present_files` naming it are blocks of the
 * same assistant turn. Collecting across the whole conversation would work too,
 * and would also let a path written in one turn be claimed by a presentation
 * three turns later, which is not a thing that happens and not a thing worth
 * being right about.
 *
 * A file that was written but never presented is deliberately skipped: the
 * model writes working files as well as artifacts, and `present_files` is the
 * line between them.
 */
function artifactsIn(message: z.infer<typeof messageSchema>): ImportedArtifact[] {
  const written = new Map<string, { content: string; description?: string | undefined }>();
  const presented = new Map<string, { name: string; mediaType?: string | undefined }>();
  const legacy: ImportedArtifact[] = [];

  for (const block of message.content ?? []) {
    if (block.type === 'tool_use' && block.name === 'create_file') {
      const path = block.input?.path;
      const text = block.input?.file_text;
      if (typeof path === 'string' && typeof text === 'string' && text !== '') {
        written.set(path, { content: text, description: block.input?.description });
      }
      continue;
    }

    /*
     * The legacy shape: one block carrying the lot. `update` commands are
     * ignored rather than applied — an export gives no guarantee that the
     * original is in the same archive, and a patch applied to the wrong base
     * is worse than an artifact that is one revision old.
     */
    if (block.type === 'tool_use' && block.name === 'artifacts') {
      const command = block.input?.command;
      const content = block.input?.content;
      if (command === 'create' && typeof content === 'string' && content !== '') {
        // `id` is outside the schema and arrives as `unknown` from the
        // passthrough, so it is only used when it really is a string.
        const fallbackId = block.input?.['id'];
        const title =
          block.input?.title ?? (typeof fallbackId === 'string' ? fallbackId : 'artifact');
        const language = block.input?.language ?? '';
        legacy.push({
          name: title,
          mediaType: legacyMediaType(block.input?.type, language),
          content,
          createdAt: messageTime(message.created_at),
        });
      }
      continue;
    }

    if (block.type === 'tool_result' && block.name === 'present_files') {
      for (const resource of block.content ?? []) {
        // `artifact_publishable` is the export's own word for "this is an
        // artifact". A resource presented without it is a file being shown.
        if (resource.type !== 'local_resource' || resource.artifact_publishable !== true) continue;
        if (typeof resource.file_path !== 'string') continue;
        presented.set(resource.file_path, {
          name: resource.name ?? resource.file_path,
          mediaType: resource.mime_type,
        });
      }
    }
  }

  const paired: ImportedArtifact[] = [];
  for (const [path, meta] of presented) {
    const file = written.get(path);
    if (file === undefined) continue;

    // The export's declared type when we recognise it, else the path's
    // extension: a presented type we have no way to render is not better than
    // a guess we can.
    const declared = meta.mediaType ?? '';
    paired.push({
      name: meta.name,
      mediaType: isArtifactMediaType(declared) ? declared : artifactMediaTypeFor(path),
      content: file.content,
      description: file.description,
      createdAt: messageTime(message.created_at),
    });
  }

  return [...paired, ...legacy];
}

/**
 * The legacy tool's own vocabulary.
 *
 * It named a type, and for code it named `application/vnd.ant.code` with the
 * real language beside it — as a language *name*, not a file extension, which
 * is why this cannot just hand the string to the path-based guess.
 */
const LEGACY_LANGUAGES: Readonly<Record<string, ArtifactMediaType>> = {
  python: 'text/x-python',
  py: 'text/x-python',
  javascript: 'application/javascript',
  js: 'application/javascript',
  jsx: 'application/javascript',
  typescript: 'text/x-typescript',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  json: 'application/json',
  sql: 'text/x-sql',
  yaml: 'text/x-yaml',
  yml: 'text/x-yaml',
  css: 'text/css',
  html: 'text/html',
  markdown: 'text/markdown',
  md: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  mermaid: 'text/mermaid',
  mmd: 'text/mermaid',
};

function legacyMediaType(type: string | undefined, language: string): ArtifactMediaType {
  if (type !== undefined && isArtifactMediaType(type)) return type;
  if (type === 'application/vnd.ant.html') return 'text/html';
  if (type === 'application/vnd.ant.markdown') return 'text/markdown';
  if (type === 'application/vnd.ant.svg') return 'image/svg+xml';
  if (type === 'application/vnd.ant.mermaid') return 'text/mermaid';

  return LEGACY_LANGUAGES[language.toLowerCase()] ?? artifactMediaTypeFor(`x.${language}`);
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
    else if (block.type === 'tool_use' || block.type === 'tool_result') {
      // Counted as dropped only when nothing was kept from it. An artifact is
      // no longer a block thrown away, so reporting it as one would tell the
      // reader their work was lost at the moment it was saved.
      if (!KEPT_TOOLS.has(block.name ?? '')) dropped.toolBlocks += 1;
    }
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

/** Tool blocks that are read rather than discarded, and so are not "dropped". */
const KEPT_TOOLS = new Set(['create_file', 'present_files', 'artifacts']);

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
  /** What the conversation produced, to be stored beside it rather than in it. */
  artifacts: ImportedArtifact[];
  /** It had messages, and none of them survived conversion. */
  emptied: boolean;
}

export function convertConversation(source: z.infer<typeof conversationSchema>): Converted {
  const dropped: Dropped = { toolBlocks: 0, attachments: 0 };
  const messages: Message[] = [];
  const artifacts: ImportedArtifact[] = [];

  for (const message of source.chat_messages) {
    artifacts.push(...artifactsIn(message));
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
    artifacts,
    // A conversation whose only content was tool calls is empty as a
    // *transcript*, but it may still have produced artifacts worth keeping.
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

/**
 * A memory's text, without the export's own book-keeping.
 *
 * The export files carry YAML front matter — `name`, `description`, `sources`,
 * `aliases` — describing how that product indexes the note. Every memory here
 * is prepended to the system prompt of every generation, so keeping it would
 * spend context on another application's filing system: on a short note it is
 * most of the bytes. The name is already the filename, and the rest has no
 * meaning on this side.
 *
 * Only a fence that opens on the first line is treated as front matter, and
 * only when it closes. Anything else is a document that happens to contain a
 * rule, and is left exactly as it was.
 */
export function memoryBody(content: string): string {
  const normalised = content.replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n')) return content.trim();

  const end = normalised.indexOf('\n---', 3);
  if (end === -1) return content.trim();

  const after = normalised.slice(end + 4);
  const body = after.replace(/^[^\n]*\n?/, '').trim();

  // A note that is nothing but front matter still has to be worth keeping:
  // an empty memory is refused by the store, so the original is better.
  return body === '' ? content.trim() : body;
}

export interface ExportContents {
  conversations: z.infer<typeof exportSchema>;
  memories: { path: string; content: string; updated_at?: string | undefined }[];
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
