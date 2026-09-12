import { ACCEPTED_MEDIA_TYPES, type AcceptedMediaType } from '@shared/attachment.ts';

/**
 * What a file actually is, decided from its bytes.
 *
 * The uploader's `Content-Type` and the filename's extension are **hints and
 * nothing more**. Both are attacker-controlled in the case that matters: an
 * HTML document named `photo.png` and sent as `image/png` is the whole attack,
 * and the only thing that catches it is reading the first few bytes.
 *
 * The result of this function decides two later things — the `Content-Type`
 * the bytes are served with, and whether they may be rendered in place — so a
 * type this module cannot positively identify is refused rather than guessed
 * at (INV-27).
 */

const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  bytes.length >= at + text.length &&
  [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));

/** Every signature that identifies an accepted image, longest-first. */
const IMAGE_SIGNATURES: { type: AcceptedMediaType; test: (bytes: Uint8Array) => boolean }[] = [
  {
    type: 'image/png',
    // The 8-byte PNG signature. The CR/LF pair in it is deliberate in the
    // format: it detects transfer over a channel that mangled line endings.
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    type: 'image/jpeg',
    // SOI marker. JPEG has no fixed header beyond it, so this is the whole
    // test — anything further would be re-implementing a decoder.
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'image/webp',
    // RIFF container whose form type is WEBP: bytes 0-3 "RIFF", 8-11 "WEBP".
    // Checking only "RIFF" would also match WAV and AVI.
    test: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  {
    type: 'image/gif',
    // "GIF87a" or "GIF89a".
    test: (b) =>
      b.length >= 6 &&
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) &&
      b[5] === 0x61,
  },
];

/**
 * The audio containers llama.cpp can decode.
 *
 * Its decoder is miniaudio, which reads WAV, MP3 and FLAC and detects the
 * container from its magic bytes — the `format` field on an `input_audio`
 * content part is documented as ignored. So the bytes decide here too, for the
 * same reason they decide for images.
 */
const AUDIO_SIGNATURES: { type: AcceptedMediaType; test: (bytes: Uint8Array) => boolean }[] = [
  {
    type: 'audio/wav',
    // RIFF container whose form type is WAVE — the same shape as WebP, which
    // is why both check bytes 8-11 rather than only the `RIFF` at the front.
    test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE'),
  },
  {
    type: 'audio/flac',
    test: (b) => ascii(b, 0, 'fLaC'),
  },
  {
    type: 'audio/mpeg',
    /*
     * Either an ID3 tag or a bare frame header. MP3 has no container, so a
     * file with tags stripped begins directly with a frame: 11 set bits of
     * sync, then a version and layer that are not the reserved values. The
     * reserved checks matter — without them every 0xFF 0xE_ byte pair in an
     * arbitrary file would look like MP3.
     */
    test: (b) => {
      if (ascii(b, 0, 'ID3')) return true;
      if (b.length < 2) return false;
      const [first, second] = [b[0]!, b[1]!];
      if (first !== 0xff || (second & 0xe0) !== 0xe0) return false;
      const version = (second >> 3) & 0b11;
      const layer = (second >> 1) & 0b11;
      return version !== 0b01 && layer !== 0b00;
    },
  },
];

/**
 * Containers this application recognises and deliberately will not store.
 *
 * Refused *by name* rather than falling through to "unsupported", because the
 * reason matters to the person who tried: a video is not a file we failed to
 * recognise, it is one no model here can read. Storing it would mean keeping
 * bytes that could never be sent anywhere — a download service, not an
 * attachment.
 */
const REFUSED_CONTAINERS: { label: string; test: (bytes: Uint8Array) => boolean }[] = [
  // ISO base media: MP4, M4A, MOV, 3GP — `ftyp` at offset 4.
  { label: 'Video', test: (b) => ascii(b, 4, 'ftyp') },
  // Matroska and WebM.
  {
    label: 'Video',
    test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  },
  { label: 'Video', test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'AVI ') },
  // Archives and documents, which have their own import path or none at all.
  { label: 'PDF', test: (b) => ascii(b, 0, '%PDF-') },
  { label: 'Archive', test: (b) => ascii(b, 0, 'PK') && (b[2] === 0x03 || b[2] === 0x05) },
];

/**
 * Markup that must never be stored as text, however it is labelled.
 *
 * A stored `.md` file is not dangerous on its own — it is served with
 * `Content-Disposition: attachment` and a sandbox CSP, and rendered as
 * Markdown rather than HTML. This is defence in depth: the cost of refusing a
 * file that opens with `<svg` or `<!doctype html` is near zero, and it removes
 * a whole class of "but what if the headers are wrong one day".
 *
 * SVG is the specific reason. It is an image to everyone who talks about it
 * and a scriptable document to a browser, and the contract rejects it by name.
 */
const MARKUP_PREFIXES = ['<?xml', '<svg', '<!doctype html', '<html', '<!--'];

function looksLikeMarkup(text: string): boolean {
  const start = text.slice(0, 512).trimStart().toLowerCase();
  return MARKUP_PREFIXES.some((prefix) => start.startsWith(prefix));
}

/**
 * Whether the bytes are valid UTF-8.
 *
 * `TextDecoder` with `fatal` is the whole implementation: it is the platform's
 * own validator, and a hand-written one would be a second opinion about a
 * question that has exactly one right answer. A BOM is tolerated — it is valid
 * UTF-8 and common on Windows — and stripped for the markup check only, never
 * from what is stored.
 */
function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The extension's opinion, used only to choose *between* text types.
 *
 * All of these are UTF-8 text and indistinguishable by content — a `.csv` and
 * a `.md` differ only in how a reader means them — so the name is the sole
 * available signal. It can never promote bytes to an image or rescue a file
 * that failed validation; the worst a wrong extension does is label a text
 * file as a different text type.
 */
const TEXT_EXTENSIONS: Record<string, AcceptedMediaType> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};

function textTypeFor(filename: string): AcceptedMediaType {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'text/plain';
  const extension = filename.slice(dot + 1).toLowerCase();
  return TEXT_EXTENSIONS[extension] ?? 'text/plain';
}

export type SniffResult =
  { ok: true; mediaType: AcceptedMediaType } | { ok: false; reason: string };

/**
 * Identifies content, or refuses it.
 *
 * Images are decided first and by signature alone. Only if nothing matches is
 * the content considered as text, and only then does the filename get a say —
 * so an `.png` extension can never make a text file into an image, and a
 * `Content-Type` of `image/png` can never make one either. Neither is an
 * argument this function accepts.
 */
export function sniff(bytes: Uint8Array, filename: string): SniffResult {
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.test(bytes)) return { ok: true, mediaType: signature.type };
  }

  /*
   * Audio before the refusals, because one container appears in both lists:
   * an `.m4a` is ISO base media like an MP4 and would be caught as video. It
   * is refused on purpose — the decoder upstream reads WAV, MP3 and FLAC, and
   * accepting a container it cannot open would store audio that never plays.
   */
  for (const signature of AUDIO_SIGNATURES) {
    if (signature.test(bytes)) return { ok: true, mediaType: signature.type };
  }

  for (const container of REFUSED_CONTAINERS) {
    if (container.test(bytes)) {
      return {
        ok: false,
        reason: `${container.label} files cannot be attached. Images, audio and text files can.`,
      };
    }
  }

  if (!isValidUtf8(bytes)) {
    return {
      ok: false,
      reason: 'The file is neither a supported image nor valid UTF-8 text.',
    };
  }

  /*
   * Valid UTF-8 is not the same as text.
   *
   * Plenty of binary decodes cleanly — a WAV file is `RIFF`, four length
   * bytes, `WAVE`, and those length bytes are frequently zero, which is valid
   * UTF-8 and would have been stored as `text/plain`. That matters more than
   * it sounds: a text attachment is *inlined into the prompt*, so a file
   * accepted as text is a file whose bytes are pasted into a model's input.
   *
   * A NUL byte is the classic and sufficient tell. No real text file contains
   * one, and every format that does is binary.
   */
  if (bytes.includes(0)) {
    return {
      ok: false,
      reason: 'The file is not a supported image, and contains data that is not text.',
    };
  }

  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, 512));
  if (looksLikeMarkup(text)) {
    return {
      ok: false,
      reason: 'Markup files, including SVG and HTML, are not accepted.',
    };
  }

  const mediaType = textTypeFor(filename);
  // Belt and braces: the table above is the authority on what may be stored,
  // and this asserts the two never drift apart.
  if (!Object.hasOwn(ACCEPTED_MEDIA_TYPES, mediaType)) {
    return { ok: false, reason: 'Unsupported file type.' };
  }
  return { ok: true, mediaType };
}
