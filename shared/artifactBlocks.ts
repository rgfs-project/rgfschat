import {
  ARTIFACT_FALLBACK_MEDIA_TYPE,
  artifactMediaTypeFor,
  displayArtifactName,
  type ArtifactMediaType,
} from './artifact.ts';

/**
 * The output format a model uses to say "this is a file", and the reader for it.
 *
 * ## The format
 *
 * A fenced code block whose info string carries a `file=` attribute:
 *
 * ```text
 * ```html file="dashboard.html"
 * <!doctype html>
 * …
 * ```
 * ```
 *
 * The language word before it is optional and is only a highlighting hint; the
 * `file="…"` attribute is the whole of the claim. Single quotes work too, and
 * the attribute may come before the language.
 *
 * ## Why an attribute rather than a heuristic
 *
 * The alternative — treating any ```` ```html ```` block, or any filename
 * mentioned near one, as a file — cannot be made correct. A reply that explains
 * how `config.yaml` works, or shows three lines of a file it is talking about,
 * would litter the reader's artifact list with things nobody asked to keep, and
 * there is no wording that reliably separates "here is the file" from "here is
 * some of the file". So the model says which blocks are files, explicitly, and
 * everything else is prose and ordinary code blocks — which is also why the
 * transcript is unchanged by any of this: the block is still a code block, and
 * still rendered as one.
 *
 * ## Why not a tool call
 *
 * Memory changes are proposed through tools because they need the reader's
 * consent before anything is written. An artifact needs no consent — it is the
 * reply, kept — and routing it through a tool call would take the file *out* of
 * the transcript, leaving the reader a link where the answer should be.
 */

/** One file a completed reply presented. */
export interface FileBlock {
  /** Exactly as written, case preserved. Sanitised for display, never a path. */
  name: string;
  content: string;
  mediaType: ArtifactMediaType;
  /** The highlighting hint from the fence, when there was one. */
  language: string | undefined;
}

/**
 * The extensions a reply may present as a file.
 *
 * The same set `artifactMediaTypeFor` knows, and deliberately not "anything
 * with a dot in it": an extension this application cannot type is one it would
 * store as plain text under a name that promises otherwise. `artifactMediaTypeFor`
 * keeps its plain-text fallback for imports, where the archive has already
 * decided something is an artifact and the only question left is how to show
 * it — here the question is whether to keep it at all.
 */
export const CAPTURED_EXTENSIONS = [
  'html',
  'htm',
  'md',
  'markdown',
  'css',
  'csv',
  'js',
  'jsx',
  'mjs',
  'json',
  'svg',
  'py',
  'ts',
  'tsx',
  'sql',
  'yaml',
  'yml',
] as const;

const captured = new Set<string>(CAPTURED_EXTENSIONS);

/** The extension of a name, lowercased for matching only. */
export function extensionOf(name: string): string | undefined {
  return /\.([A-Za-z0-9]+)\s*$/.exec(name)?.[1]?.toLowerCase();
}

/**
 * Whether a presented name is one this application will keep.
 *
 * Case-insensitive, because `REPORT.MD` and `report.md` are the same kind of
 * file and a model will write either.
 */
export function isCapturedFileName(name: string): boolean {
  const extension = extensionOf(name);
  return extension !== undefined && captured.has(extension);
}

/**
 * The `file="…"` attribute of an info string, or `null` for an ordinary fence.
 *
 * Anchored to the whole attribute, so `file` appearing in a language name or in
 * a word like `profile=` cannot be mistaken for one.
 */
function fileAttributeOf(info: string): string | null {
  const match = /(?:^|\s)file\s*=\s*("([^"]*)"|'([^']*)')/.exec(info);
  if (match === null) return null;
  return match[2] ?? match[3] ?? null;
}

/** The language hint: the first bare word of the info string, if any. */
function languageOf(info: string): string | undefined {
  const first = info.trim().split(/\s+/)[0];
  if (first === undefined || first === '' || first.includes('=')) return undefined;
  return first.toLowerCase();
}

/**
 * Every file block in one assistant reply, in the order they appear.
 *
 * Fence-aware rather than regex-over-the-whole-string: a file block whose
 * content is itself Markdown can contain ``` lines, and a closing fence is only
 * a closing fence when it is at least as long as the one that opened it and
 * made of the same character. Getting that wrong would truncate exactly the
 * documents most likely to be presented as files.
 *
 * Only complete blocks count. A reply cut off mid-file — a cancelled run, a
 * stream that stopped — has an opening fence and no closing one, and yields
 * nothing: half a file is not a file.
 */
export function fileBlocksIn(body: string): FileBlock[] {
  const lines = body.split('\n');
  const blocks: FileBlock[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    // Up to three leading spaces, as CommonMark allows.
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) continue;

    const fence = open[1] as string;
    const info = open[2] ?? '';
    // A backtick fence's info string may not contain a backtick.
    if (fence.startsWith('`') && info.includes('`')) continue;

    const closer = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (closer.test(lines[j] as string)) {
        end = j;
        break;
      }
    }

    // Unclosed: the reply stops inside it, so there is no block here and
    // nothing after it can be one either.
    if (end === -1) break;

    const name = fileAttributeOf(info);
    if (name !== null) {
      const trimmed = name.trim();
      if (isCapturedFileName(trimmed)) {
        blocks.push({
          name: displayArtifactName(trimmed),
          content: lines.slice(i + 1, end).join('\n'),
          mediaType: artifactMediaTypeFor(trimmed),
          language: languageOf(info),
        });
      }
    }

    // Skip past the block, so a fence inside one is never read as opening
    // another.
    i = end;
  }

  return blocks;
}

/**
 * What the model is told about the format.
 *
 * Kept beside the parser so the instruction and the thing that reads it cannot
 * drift apart: a prompt that documents a syntax nothing parses is worse than no
 * prompt at all.
 */
export const FILE_BLOCK_INSTRUCTION =
  'When you produce a complete file the user will want to keep — a document, a ' +
  'script, a stylesheet, a data file — write it as a fenced code block whose info ' +
  'string names it, like ```html file="dashboard.html". The file is saved under that ' +
  'name once your reply finishes, and the block stays in the conversation as usual. ' +
  `Only these extensions are saved: ${CAPTURED_EXTENSIONS.join(', ')}. ` +
  'Use it only for the complete contents of a file you are presenting: an excerpt, ' +
  'an example, or a file you are merely discussing is an ordinary code block with no ' +
  'file attribute.';

/** Only used when a name somehow reaches the store untyped. */
export const FILE_BLOCK_FALLBACK_MEDIA_TYPE = ARTIFACT_FALLBACK_MEDIA_TYPE;
