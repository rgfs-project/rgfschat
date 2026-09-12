/**
 * Attachments, as both sides understand them.
 *
 * The wire shape and the rules that decide it live together because they are
 * one decision: what this application will accept. The server enforces all of
 * it — the client uses the same constants only to say no earlier and more
 * kindly, never as the check that matters.
 */

/**
 * The two things an attachment can be, which is a statement about what the
 * prompt assembler can do with it rather than about the file.
 *
 * `text` is inlined into the prompt as a fenced block. `image` and `audio` are
 * sent as content parts, and only to a model that reports the matching input
 * modality. There is no fourth kind because there is no fourth thing to do
 * with the bytes — video in particular is refused rather than stored, since
 * nothing downstream can read it.
 */
export type AttachmentKind = 'image' | 'audio' | 'text';

/**
 * Every media type that may be stored, and the kind each one becomes.
 *
 * An allowlist, not a denylist. The set is small and deliberate: four raster
 * image formats that browsers render natively and a handful of text types. SVG
 * is **absent on purpose** — it is a document that can carry script, and
 * "image" is exactly the word that makes people treat it as inert.
 */
export const ACCEPTED_MEDIA_TYPES = {
  // The four raster formats Gemma and Qwen both accept, and the same four the
  // Claude API takes. Verified against a live server for PNG.
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',

  // What llama.cpp's audio decoder (miniaudio) reads. The container is
  // detected from magic bytes upstream too — `input_audio.format` is
  // documented as ignored — so this list is about what we are willing to
  // store, and the bytes decide which one it is.
  'audio/wav': 'audio',
  'audio/mpeg': 'audio',
  'audio/flac': 'audio',

  'text/plain': 'text',
  'text/markdown': 'text',
  'text/csv': 'text',
  'application/json': 'text',
} as const satisfies Record<string, AttachmentKind>;

export type AcceptedMediaType = keyof typeof ACCEPTED_MEDIA_TYPES;

export function isAcceptedMediaType(value: string): value is AcceptedMediaType {
  return Object.hasOwn(ACCEPTED_MEDIA_TYPES, value);
}

export function kindOf(mediaType: AcceptedMediaType): AttachmentKind {
  return ACCEPTED_MEDIA_TYPES[mediaType];
}

/**
 * What a browser may be told to render in place (see INV-27).
 *
 * Images and audio, because both are decoded by a media pipeline rather than
 * interpreted as a document: neither can carry script, and a reader expects to
 * see a picture and to press play without downloading a file first. Everything
 * else is served as a download.
 */
export const INLINE_RENDERABLE: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'audio/wav',
  'audio/mpeg',
  'audio/flac',
];

/**
 * The input modality a kind needs from the model, or `null` when it needs none.
 *
 * Text is inlined into the prompt as characters, so every model can read it.
 * The other two are only sent to a model that reports the matching modality —
 * sending either to one that does not is a 500 from the provider.
 */
export const REQUIRED_MODALITY: Record<AttachmentKind, 'image' | 'audio' | null> = {
  image: 'image',
  audio: 'audio',
  text: null,
};

/**
 * At most ten per message, which is the format's limit rather than a policy.
 *
 * `formatVersion: 1` defines `attachments` as 1–10 UUIDs (contracts §3.4), and
 * the format is frozen. A configurable limit may be lower but can never be
 * higher, because a message with eleven could not be written down.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * What a response says about an attachment.
 *
 * `filename` is display metadata and nothing else — it never reaches a path
 * (INV-28), and the client must not treat it as an identifier.
 */
export interface AttachmentDto {
  id: string;
  filename: string;
  mediaType: AcceptedMediaType;
  kind: AttachmentKind;
  size: number;
  createdAt: string;
}

/**
 * A filename fit to show a reader.
 *
 * Not sanitisation for safety — nothing downstream trusts this string — but
 * for legibility: a name carrying control characters or line breaks would
 * disrupt the layout it is displayed in, and one carrying a path would invite
 * the reader to believe it means something. Directory separators become a
 * character that plainly does not.
 */
export function displayFilename(raw: string): string {
  const flattened = raw
    // eslint-disable-next-line no-control-regex -- removing them is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // U+2215 DIVISION SLASH: reads as a slash, is not one, and so cannot be
    // mistaken for a path by anything that later looks at this string.
    .replace(/[\\/]/g, '\u2215')
    .trim();
  return flattened === '' ? 'file' : flattened.slice(0, 200);
}

/** A size a person can read, for a chip or a file row. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}
