import { parseDocument, type Document } from 'yaml';
import {
  FORMAT_VERSION,
  MESSAGE_STATUSES,
  isCanonicalTimestamp,
  isCanonicalUuid,
  isValidTitle,
  type AssistantMessage,
  type Conversation,
  type Message,
  type MessageStatus,
} from '@shared/conversation.ts';

/**
 * Canonical conversation Markdown — `formatVersion: 1` (contracts §3).
 *
 * The parser never throws for content problems: it returns a typed result so a
 * malformed file is a value, not an exception (contracts §3.7). Filesystem
 * errors are a separate concern handled by the caller.
 *
 * The serializer is pure — no clock, no randomness, no I/O — which is what
 * makes the round-trip guarantee in §3.6 testable.
 */

export type ParseResult =
  { ok: true; conversation: Conversation } | { ok: false; reason: string; line: number };

function malformed(reason: string, line: number): ParseResult {
  return { ok: false, reason, line };
}

/** A line that *looks* like a delimiter. Every one of these must parse fully (§3.4). */
const DELIMITER_LIKE = /^[ \t]*<!--[ \t]*cc:/;
/** An escaped content line: one or more backslashes then something delimiter-like (§3.5). */
const ESCAPED_DELIMITER_LIKE = /^\\+[ \t]*<!--[ \t]*cc:/;
/** What the serializer must escape: zero or more backslashes then delimiter-like (§3.5). */
const NEEDS_ESCAPE = /^\\*[ \t]*<!--[ \t]*cc:/;

const MESSAGE_TYPES = ['system', 'user', 'reasoning', 'assistant'] as const;
type BlockType = (typeof MESSAGE_TYPES)[number];

const ATTRIBUTE_KEYS = ['id', 'status', 'provider', 'model', 'attachments'] as const;
type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

/** Which attributes each type permits, and which are required (§3.4). */
const ATTRIBUTE_RULES: Record<BlockType, { required: AttributeKey[]; optional: AttributeKey[] }> = {
  system: { required: ['id'], optional: [] },
  user: { required: ['id'], optional: ['attachments'] },
  reasoning: { required: ['id'], optional: [] },
  assistant: { required: ['id', 'status'], optional: ['provider', 'model'] },
};

interface ParsedDelimiter {
  type: BlockType;
  attributes: Map<AttributeKey, string>;
}

// ---------------------------------------------------------------------------
// Delimiter parsing
// ---------------------------------------------------------------------------

/**
 * Parses one delimiter line against the full grammar. Returns `null` with a
 * reason when the line is delimiter-like but does not conform.
 */
function parseDelimiter(
  line: string
): { ok: true; value: ParsedDelimiter } | { ok: false; reason: string } {
  let i = 0;
  const skipWs = (): number => {
    let n = 0;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
      i += 1;
      n += 1;
    }
    return n;
  };

  skipWs();
  if (!line.startsWith('<!--', i)) return { ok: false, reason: 'expected "<!--"' };
  i += 4;
  skipWs();
  if (!line.startsWith('cc:', i)) return { ok: false, reason: 'expected "cc:"' };
  i += 3;

  // TYPE
  const typeStart = i;
  while (i < line.length && /[a-z]/.test(line[i] as string)) i += 1;
  const rawType = line.slice(typeStart, i);
  if (!(MESSAGE_TYPES as readonly string[]).includes(rawType)) {
    return { ok: false, reason: `unknown block type "${rawType}"` };
  }
  const type = rawType as BlockType;

  const attributes = new Map<AttributeKey, string>();

  for (;;) {
    const wsBefore = skipWs();

    if (line.startsWith('-->', i)) {
      i += 3;
      skipWs();
      if (i !== line.length) return { ok: false, reason: 'trailing characters after "-->"' };
      return { ok: true, value: { type, attributes } };
    }

    if (i >= line.length) return { ok: false, reason: 'missing "-->"' };
    // ATTR must be preceded by at least one space or tab.
    if (wsBefore === 0) return { ok: false, reason: 'missing whitespace before attribute' };

    const keyStart = i;
    while (i < line.length && /[a-z]/.test(line[i] as string)) i += 1;
    const rawKey = line.slice(keyStart, i);
    if (!(ATTRIBUTE_KEYS as readonly string[]).includes(rawKey)) {
      return { ok: false, reason: `unknown attribute "${rawKey}"` };
    }
    const key = rawKey as AttributeKey;
    if (attributes.has(key)) return { ok: false, reason: `duplicate attribute "${key}"` };

    if (line[i] !== '=') return { ok: false, reason: `expected "=" after "${key}"` };
    i += 1;

    const value = readValue(line, i);
    if (!value.ok) return { ok: false, reason: value.reason };
    i = value.next;
    attributes.set(key, value.value);
  }
}

/** Reads BARE or QUOTED starting at `start`. */
function readValue(
  line: string,
  start: number
): { ok: true; value: string; next: number } | { ok: false; reason: string } {
  if (line[start] === '"') {
    // QUOTED — a JSON string literal. Find its end by scanning escapes, then
    // let JSON.parse do the unescaping so the semantics match the spec exactly.
    let i = start + 1;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        const literal = line.slice(start, i + 1);
        try {
          const parsed: unknown = JSON.parse(literal);
          if (typeof parsed !== 'string')
            return { ok: false, reason: 'quoted value is not a string' };
          return { ok: true, value: parsed, next: i + 1 };
        } catch {
          return { ok: false, reason: 'invalid JSON string literal' };
        }
      }
      i += 1;
    }
    return { ok: false, reason: 'unterminated quoted value' };
  }

  let i = start;
  while (i < line.length && /[A-Za-z0-9._-]/.test(line[i] as string)) i += 1;
  if (i === start) return { ok: false, reason: 'empty attribute value' };
  return { ok: true, value: line.slice(start, i), next: i };
}

/** Validates attribute presence and values for a block type (§3.4). */
function validateAttributes(
  { type, attributes }: ParsedDelimiter,
  line: number
): { ok: true } | { ok: false; reason: string; line: number } {
  const rules = ATTRIBUTE_RULES[type];
  const allowed = new Set<AttributeKey>([...rules.required, ...rules.optional]);

  for (const key of attributes.keys()) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `attribute "${key}" is not allowed on "${type}"`, line };
    }
  }
  for (const key of rules.required) {
    if (!attributes.has(key)) {
      return { ok: false, reason: `"${type}" requires attribute "${key}"`, line };
    }
  }

  const id = attributes.get('id');
  if (id !== undefined && !isCanonicalUuid(id)) {
    return { ok: false, reason: 'id is not a canonical lowercase UUID', line };
  }

  const status = attributes.get('status');
  if (status !== undefined && !(MESSAGE_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, reason: `invalid status "${status}"`, line };
  }

  const attachments = attributes.get('attachments');
  if (attachments !== undefined) {
    const ids = attachments.split(',');
    if (ids.length < 1 || ids.length > 10) {
      return { ok: false, reason: 'attachments must list 1-10 ids', line };
    }
    for (const candidate of ids) {
      if (!isCanonicalUuid(candidate)) {
        return { ok: false, reason: 'attachments contains a non-canonical UUID', line };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

const FRONT_MATTER_KEYS = ['formatVersion', 'title', 'createdAt', 'updatedAt'] as const;

interface FrontMatter {
  title: string;
  createdAt: string;
  updatedAt: string;
}

function parseFrontMatter(
  lines: string[]
): { ok: true; value: FrontMatter; next: number } | { ok: false; reason: string; line: number } {
  if (lines[0] !== '---') return { ok: false, reason: 'file must begin with "---"', line: 1 };

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { ok: false, reason: 'unterminated front matter', line: 1 };

  const body = lines.slice(1, end).join('\n');

  let doc: Document;
  try {
    doc = parseDocument(body, { schema: 'core' });
  } catch {
    return { ok: false, reason: 'front matter is not valid YAML', line: 2 };
  }
  if (doc.errors.length > 0) {
    return { ok: false, reason: 'front matter is not valid YAML', line: 2 };
  }

  // Key order and duplicates are checked against the document AST, because a
  // plain object cannot express "exactly these four keys, in this order".
  const contents = doc.contents as { items?: { key?: { value?: unknown } }[] } | null;
  const items = contents?.items;
  if (!Array.isArray(items)) {
    return { ok: false, reason: 'front matter must be a mapping', line: 2 };
  }

  const keys = items.map((item) => {
    const key: unknown = item.key?.value;
    return typeof key === 'string' ? key : '';
  });
  if (keys.length !== FRONT_MATTER_KEYS.length) {
    return { ok: false, reason: 'front matter must have exactly four keys', line: 2 };
  }
  for (let i = 0; i < FRONT_MATTER_KEYS.length; i += 1) {
    if (keys[i] !== FRONT_MATTER_KEYS[i]) {
      return {
        ok: false,
        reason: `front matter key ${i + 1} must be "${FRONT_MATTER_KEYS[i]}", found "${keys[i]}"`,
        line: 2 + i,
      };
    }
  }

  const data = doc.toJS() as Record<string, unknown>;

  if (data['formatVersion'] !== FORMAT_VERSION) {
    // No implicit migration: any other value is malformed (§3.3).
    return { ok: false, reason: 'formatVersion must be the integer 1', line: 2 };
  }

  const title = data['title'];
  if (typeof title !== 'string' || !isValidTitle(title)) {
    return { ok: false, reason: 'title must be a 1-200 character single-line string', line: 3 };
  }

  const createdAt = data['createdAt'];
  if (typeof createdAt !== 'string' || !isCanonicalTimestamp(createdAt)) {
    return { ok: false, reason: 'createdAt must be YYYY-MM-DDTHH:mm:ss.sssZ', line: 4 };
  }

  const updatedAt = data['updatedAt'];
  if (typeof updatedAt !== 'string' || !isCanonicalTimestamp(updatedAt)) {
    return { ok: false, reason: 'updatedAt must be YYYY-MM-DDTHH:mm:ss.sssZ', line: 5 };
  }

  return { ok: true, value: { title, createdAt, updatedAt }, next: end + 1 };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Strips leading and trailing blank lines; all other bytes are preserved (§3.5). */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] as string).trim() === '') start += 1;
  while (end > start && (lines[end - 1] as string).trim() === '') end -= 1;
  return lines.slice(start, end);
}

function unescapeBody(lines: string[]): string {
  return lines.map((line) => (ESCAPED_DELIMITER_LIKE.test(line) ? line.slice(1) : line)).join('\n');
}

export function parseConversation(input: string): ParseResult {
  // BOM is accepted and dropped; CRLF is normalised to LF. A lone CR is content.
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  const front = parseFrontMatter(lines);
  if (!front.ok) return malformed(front.reason, front.line);

  interface RawBlock {
    delimiter: ParsedDelimiter;
    line: number;
    body: string[];
  }

  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;

  for (let i = front.next; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const lineNumber = i + 1;

    if (DELIMITER_LIKE.test(line)) {
      const parsed = parseDelimiter(line);
      if (!parsed.ok) return malformed(parsed.reason, lineNumber);

      const valid = validateAttributes(parsed.value, lineNumber);
      if (!valid.ok) return malformed(valid.reason, valid.line);

      current = { delimiter: parsed.value, line: lineNumber, body: [] };
      blocks.push(current);
      continue;
    }

    if (current === null) {
      // Only blank lines may precede the first delimiter (§3.5).
      if (line.trim() !== '') return malformed('content before the first delimiter', lineNumber);
      continue;
    }

    current.body.push(line);
  }

  // Fold reasoning blocks into the assistant block that must immediately follow.
  const messages: Message[] = [];
  const seenIds = new Set<string>();
  let pendingReasoning: { id: string; body: string; line: number } | null = null;

  for (const block of blocks) {
    const { type, attributes } = block.delimiter;
    const id = attributes.get('id') as string;
    const body = unescapeBody(trimBlankEdges(block.body));

    if (type === 'reasoning') {
      if (pendingReasoning !== null) {
        return malformed('a reasoning block must be followed by its assistant block', block.line);
      }
      pendingReasoning = { id, body, line: block.line };
      continue;
    }

    if (pendingReasoning !== null) {
      if (type !== 'assistant' || id !== pendingReasoning.id) {
        return malformed(
          'a reasoning block must be immediately followed by the assistant block with the same id',
          block.line
        );
      }
    }

    if (seenIds.has(id)) return malformed(`duplicate id "${id}"`, block.line);
    seenIds.add(id);

    switch (type) {
      case 'system':
        messages.push({ type: 'system', id, body });
        break;
      case 'user': {
        const attachments = attributes.get('attachments');
        messages.push({
          type: 'user',
          id,
          ...(attachments !== undefined ? { attachments: attachments.split(',') } : {}),
          body,
        });
        break;
      }
      case 'assistant': {
        const message: AssistantMessage = {
          type: 'assistant',
          id,
          status: attributes.get('status') as MessageStatus,
          ...(attributes.has('provider') ? { provider: attributes.get('provider') as string } : {}),
          ...(attributes.has('model') ? { model: attributes.get('model') as string } : {}),
          ...(pendingReasoning !== null ? { reasoning: pendingReasoning.body } : {}),
          body,
        };
        pendingReasoning = null;
        messages.push(message);
        break;
      }
    }
  }

  if (pendingReasoning !== null) {
    return malformed(
      'a reasoning block must be followed by its assistant block',
      pendingReasoning.line
    );
  }

  return {
    ok: true,
    conversation: {
      formatVersion: FORMAT_VERSION,
      title: front.value.title,
      createdAt: front.value.createdAt,
      updatedAt: front.value.updatedAt,
      messages,
    },
  };
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * JSON string literal with `<`, `>`, and `&` escaped as `<`, `>`,
 * `&`, so a value can never contain `-->` (§3.4).
 */
function quote(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function escapeBody(body: string): string {
  return body
    .split('\n')
    .map((line) => (NEEDS_ESCAPE.test(line) ? `\\${line}` : line))
    .join('\n');
}

function delimiterFor(type: BlockType, attributes: [AttributeKey, string][]): string {
  const rendered = attributes.map(([key, value]) => `${key}=${value}`).join(' ');
  return `<!-- cc:${type}${rendered === '' ? '' : ` ${rendered}`} -->`;
}

/** Pure: no clock, no randomness, no I/O (§3.6). */
export function serializeConversation(conversation: Conversation): string {
  const front = [
    '---',
    `formatVersion: ${FORMAT_VERSION}`,
    `title: ${JSON.stringify(conversation.title)}`,
    `createdAt: ${JSON.stringify(conversation.createdAt)}`,
    `updatedAt: ${JSON.stringify(conversation.updatedAt)}`,
    '---',
    '',
  ].join('\n');

  const blocks: string[] = [];

  // A block is its delimiter plus, only when non-empty, its body. An empty body
  // contributes no lines at all — contracts §4 writes one for a failed
  // generation, and appending a bare "\n" there would leave a stray blank line.
  const block = (delimiter: string, body: string): string =>
    body === '' ? delimiter : `${delimiter}\n${escapeBody(body)}`;

  for (const message of conversation.messages) {
    if (message.type === 'assistant' && message.reasoning !== undefined) {
      blocks.push(block(delimiterFor('reasoning', [['id', message.id]]), message.reasoning));
    }

    // Canonical attribute order: id, status, provider, model, attachments.
    const attributes: [AttributeKey, string][] = [['id', message.id]];
    if (message.type === 'assistant') {
      attributes.push(['status', message.status]);
      if (message.provider !== undefined) attributes.push(['provider', quote(message.provider)]);
      if (message.model !== undefined) attributes.push(['model', quote(message.model)]);
    }
    if (message.type === 'user' && message.attachments !== undefined) {
      attributes.push(['attachments', quote(message.attachments.join(','))]);
    }

    blocks.push(block(delimiterFor(message.type, attributes), message.body));
  }

  // A zero-message file is just the front matter. Otherwise a blank line
  // separates the front matter from the first block and each block from the
  // next, and the file ends in exactly one newline (§3.5).
  if (blocks.length === 0) return front;
  return `${front}\n${blocks.join('\n\n')}\n`;
}
