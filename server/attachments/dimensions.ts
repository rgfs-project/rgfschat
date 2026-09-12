/**
 * An image's dimensions, read from its header without decoding it.
 *
 * This is the defence against a decompression bomb: a 100 kB PNG can declare
 * 60 000 × 60 000 pixels and expand to fourteen gigabytes in whatever decodes
 * it — the provider, a browser showing a thumbnail, or anything else that
 * trusts a file because it arrived. The size limit does not help, because the
 * file really is small; the *declared* dimensions are what must be checked.
 *
 * Headers only. Reading the first few bytes of a structure is the whole point:
 * decoding the image to find out how big it is would be performing the attack
 * in order to detect it.
 */

export interface Dimensions {
  width: number;
  height: number;
}

/** Big-endian, the byte order every one of these formats uses except GIF. */
function be32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

function be16(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function le16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function le24(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

/** PNG: the IHDR chunk is mandatory and is always first, at offset 16. */
function png(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24) return null;
  // The chunk type at offset 12 must actually be IHDR, or this is not the
  // structure being assumed.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  return { width: be32(bytes, 16), height: be32(bytes, 20) };
}

/** GIF: a fixed logical-screen header, little-endian, right after the magic. */
function gif(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 10) return null;
  return { width: le16(bytes, 6), height: le16(bytes, 8) };
}

/**
 * JPEG: walk the marker segments until a start-of-frame.
 *
 * There is no fixed offset — a file may carry any number of EXIF, comment and
 * quantisation segments first — so the segments are stepped through by their
 * declared lengths. The walk is bounded by the buffer and by a segment count,
 * because a malformed length is itself a way to make a reader spin.
 */
function jpeg(bytes: Uint8Array): Dimensions | null {
  let at = 2; // past the SOI marker
  let segments = 0;

  while (at + 9 < bytes.length && segments < 1_000) {
    segments += 1;
    if (bytes[at] !== 0xff) return null;

    const marker = bytes[at + 1]!;

    // Standalone markers carry no length and cannot be stepped over by one.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }

    // SOF0-SOF15, excluding the four that are not frame headers.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      // length(2) precision(1) height(2) width(2)
      return { height: be16(bytes, at + 5), width: be16(bytes, at + 7) };
    }

    const length = be16(bytes, at + 2);
    if (length < 2) return null;
    at += 2 + length;
  }

  return null;
}

/**
 * WebP: three sub-formats in one RIFF container, each storing size differently.
 *
 * Lossy (`VP8 `), lossless (`VP8L`) and extended (`VP8X`). All three are here
 * because a checker that understood only one would let the other two through
 * unmeasured, which is the same as not checking.
 */
function webp(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 30) return null;

  const fourcc = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);

  if (fourcc === 'VP8 ') {
    // 14-bit dimensions, little-endian, after a 3-byte start code.
    return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
  }

  if (fourcc === 'VP8L') {
    // 14 bits each, packed across four bytes after the 1-byte signature.
    const packed = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    };
  }

  if (fourcc === 'VP8X') {
    // Canvas size minus one, 24-bit little-endian each.
    return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
  }

  return null;
}

/**
 * Reads the declared dimensions, or `null` when they cannot be determined.
 *
 * `null` means "unreadable", not "fine". The caller decides what to do with
 * that — and the caller here refuses, because an image whose header cannot be
 * parsed is one whose cost cannot be bounded.
 */
export function imageDimensions(mediaType: string, bytes: Uint8Array): Dimensions | null {
  const found =
    mediaType === 'image/png'
      ? png(bytes)
      : mediaType === 'image/gif'
        ? gif(bytes)
        : mediaType === 'image/jpeg'
          ? jpeg(bytes)
          : mediaType === 'image/webp'
            ? webp(bytes)
            : null;

  if (found === null) return null;
  // A zero or absurd dimension is a malformed header, not a real image.
  if (found.width <= 0 || found.height <= 0) return null;
  if (!Number.isSafeInteger(found.width) || !Number.isSafeInteger(found.height)) return null;
  return found;
}
