/**
 * Artifacts — fenced code blocks, surfaced as things you can open.
 *
 * An artifact is **derived, never stored**. The conversation Markdown is frozen
 * at `formatVersion: 1` (contracts §3), so there is no artifact delimiter, no
 * new attribute, and nothing on disk to migrate: an artifact is a projection of
 * a fenced code block that is already in a message body. Deleting the message
 * deletes the artifact, editing it re-derives one, and a backup restored from
 * before this feature existed has artifacts the moment it is read.
 *
 * That is also why extraction lives here rather than on either side alone. The
 * server lists artifacts across every conversation without loading them into
 * the browser, and the client opens one out of a conversation it already holds.
 * If those two disagreed about where a block starts, the gallery and the panel
 * would show different code for the same id; sharing one scanner is what makes
 * that impossible.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';

/** Below this a fence is a phrase in a sentence, not something to open. */
export const ARTIFACT_MIN_LINES = 3;
/** …unless it is long enough to be worth opening anyway (one wide line). */
export const ARTIFACT_MIN_CHARS = 120;

/** Titles are a UI affordance; anything longer is a paragraph. */
const TITLE_MAX_LENGTH = 80;
const TITLE_MIN_LENGTH = 3;

export interface CodeBlock {
  /** The fence info word, lowercased — `ts` in ```` ```ts ````. `null` if bare. */
  language: string | null;
  /** The block's content, fence lines excluded, common indent removed. */
  code: string;
  /** Position among *all* fenced blocks in the body, from 0. */
  ordinal: number;
}

/** A code block plus everything needed to list it without its content. */
export interface ArtifactSummary {
  /** `<messageId>#<ordinal>` — stable while the message body is unchanged. */
  id: string;
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  title: string;
  language: string | null;
  lines: number;
  /** The conversation's `updatedAt`. Message bodies carry no timestamp of
      their own in `formatVersion: 1`, so this is the honest closest thing. */
  updatedAt: string;
}

/** A summary plus the code itself, for the panel and for downloading. */
export interface ArtifactDto extends ArtifactSummary {
  code: string;
}

/**
 * Splits a message body into code blocks, in document order.
 *
 * This uses `mdast-util-from-markdown` — the parser react-markdown itself
 * parses with — rather than scanning for fence lines. A hand-rolled scanner
 * gets the easy cases right and then disagrees with the renderer on the ones
 * that actually occur: a fence indented inside a list item, a fence inside a
 * blockquote, a ```` ```` ```` block containing ```, an info string with a
 * backtick in it. Every such disagreement is a panel showing different text
 * than the message it was opened from. Sharing the parser makes agreement
 * structural instead of something a test has to keep chasing.
 *
 * Indented (four-space) blocks count too, because react-markdown renders them
 * through the same component: if it looks like a code block in the transcript,
 * it is one here.
 */
export function extractCodeBlocks(body: string): CodeBlock[] {
  // Parsing every message of every conversation is the gallery's whole cost, and
  // most messages are prose. A code node needs a fence or a four-space indent,
  // so a body with neither cannot contain one.
  if (!HAS_CODE.test(body)) return [];

  const blocks: CodeBlock[] = [];

  const visit = (node: Node): void => {
    if (node.type === 'code') {
      blocks.push({
        language:
          typeof node.lang === 'string' && node.lang !== '' ? node.lang.toLowerCase() : null,
        code: typeof node.value === 'string' ? node.value : '',
        ordinal: blocks.length,
      });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };

  visit(fromMarkdown(body));
  return blocks;
}

/** Only the parts of an mdast node this walk needs. */
interface Node {
  type: string;
  lang?: string | null | undefined;
  value?: string | undefined;
  children?: Node[] | undefined;
}

const HAS_CODE = /```|~~~|^ {4}|^\t/m;

/**
 * Whether a block is substantial enough to be worth opening.
 *
 * A one-line `npm install` fence is read where it sits; putting it in the
 * gallery would bury the things someone actually wants to find again.
 */
export function isArtifact(block: CodeBlock): boolean {
  const trimmed = block.code.trim();
  if (trimmed === '') return false;
  return trimmed.split('\n').length >= ARTIFACT_MIN_LINES || trimmed.length >= ARTIFACT_MIN_CHARS;
}

/**
 * A name for a block that has none.
 *
 * Code rarely announces its own title, but it very often opens with a comment
 * saying what it is — so a leading comment becomes the title, and everything
 * else falls back to naming the language. The fallback is deliberately plain
 * ("ini snippet") rather than a guess made from the first line of code: a
 * title of `model "$MODEL" \` is worse than no title at all, because it looks
 * like it means something.
 */
export function deriveTitle(language: string | null, code: string): string {
  const fromComment = leadingComment(code);
  if (fromComment !== null) return fromComment;

  if (language === 'html' || language === 'xml' || language === 'svg') {
    const titled = /<title[^>]*>([^<]{3,80})<\/title>/i.exec(code);
    const inner = titled?.[1]?.trim();
    if (inner !== undefined && inner !== '') return clean(inner) ?? `${language} snippet`;
  }

  return `${language ?? 'code'} snippet`;
}

const COMMENT_PATTERNS = [
  // Line comments: # ... | // ... | -- ... | ; ... | % ...
  /^[ \t]*(?:#+|\/\/+|--|;+|%)[ \t]*(.+)$/,
  // A whole-line block comment: /* ... */ or <!-- ... -->
  /^[ \t]*\/\*+[ \t]*(.*?)[ \t]*\*+\/[ \t]*$/,
  /^[ \t]*<!--[ \t]*(.*?)[ \t]*-->[ \t]*$/,
  // An opening block comment with its text on the same line: /* ... or /** ...
  /^[ \t]*\/\*+[ \t]*(.+)$/,
];

function leadingComment(code: string): string | null {
  const first = code.split('\n').find((line) => line.trim() !== '');
  if (first === undefined) return null;

  // A shebang names an interpreter, not the snippet.
  if (first.startsWith('#!')) return null;

  for (const pattern of COMMENT_PATTERNS) {
    const text = pattern.exec(first)?.[1];
    if (text === undefined) continue;
    const cleaned = clean(text);
    if (cleaned !== null) return cleaned;
  }
  return null;
}

/** Trims decoration and rejects anything too short or too long to be a name. */
function clean(text: string): string | null {
  const stripped = text
    // Control characters would corrupt the line the title is rendered on.
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    // Banner comments: ---- Section ----, ==== Section ====, #### Section ####
    .replace(/^[\s\-=*#_]+/, '')
    .replace(/[\s\-=*#_]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing colon reads as a label introducing the code, not a title.
    .replace(/:$/, '');

  if (stripped.length < TITLE_MIN_LENGTH) return null;
  return truncate(stripped, TITLE_MAX_LENGTH);
}

/** Cuts at a word boundary where there is one close to the limit. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `<messageId>#<ordinal>`, the address of an artifact within a conversation. */
export function artifactId(messageId: string, ordinal: number): string {
  return `${messageId}#${ordinal}`;
}

export function parseArtifactId(id: string): { messageId: string; ordinal: number } | null {
  const match = /^([0-9a-f-]{36})#(\d{1,4})$/.exec(id);
  const messageId = match?.[1];
  const ordinal = match?.[2];
  if (messageId === undefined || ordinal === undefined) return null;
  return { messageId, ordinal: Number(ordinal) };
}

const EXTENSIONS: Record<string, string> = {
  bash: 'sh',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  css: 'css',
  diff: 'diff',
  dockerfile: 'Dockerfile',
  go: 'go',
  html: 'html',
  ini: 'ini',
  java: 'java',
  javascript: 'js',
  js: 'js',
  json: 'json',
  jsx: 'jsx',
  kotlin: 'kt',
  markdown: 'md',
  md: 'md',
  php: 'php',
  python: 'py',
  py: 'py',
  ruby: 'rb',
  rust: 'rs',
  scss: 'scss',
  sh: 'sh',
  shell: 'sh',
  sql: 'sql',
  svg: 'svg',
  swift: 'swift',
  toml: 'toml',
  ts: 'ts',
  tsx: 'tsx',
  typescript: 'ts',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

/**
 * A filename to download a block as.
 *
 * The title is user- and model-supplied text on its way to a
 * `Content-Disposition` header and a filesystem, so everything outside a known
 * safe set is replaced rather than escaped — the same approach the conversation
 * export takes.
 */
export function artifactFilename(title: string, language: string | null): string {
  const base =
    title
      .replace(/[^\w .-]+/g, '_')
      .replace(/^[._]+/, '')
      .slice(0, 60)
      .trim() || 'artifact';
  const extension = language === null ? 'txt' : (EXTENSIONS[language] ?? 'txt');
  return `${base}.${extension}`;
}
