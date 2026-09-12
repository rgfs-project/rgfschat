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
 * `text` is inlined into the prompt as a fenced block. `image` is sent as a
 * content part, and only to a model that can see. There is no third kind,
 * because there is no third thing to do with the bytes.
 */
export type AttachmentKind = 'image' | 'text';

/**
 * Every media type that may be stored, and the kind each one becomes.
 *
 * An allowlist, not a denylist. The set is small and deliberate: four raster
 * image formats that browsers render natively and a handful of text types. SVG
 * is **absent on purpose** — it is a document that can carry script, and
 * "image" is exactly the word that makes people treat it as inert.
 */
export const ACCEPTED_MEDIA_TYPES = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
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

/** The four types a browser may be told to render in place (see INV-27). */
export const INLINE_RENDERABLE: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

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
