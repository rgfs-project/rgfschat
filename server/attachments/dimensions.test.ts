import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { imageDimensions } from './dimensions.ts';

/**
 * Reading a declared size without decoding.
 *
 * The bomb cases are the point: a header claiming an enormous canvas, in a
 * file of a few dozen bytes. If these were decoded to be measured, measuring
 * them would be the attack.
 */

/** A real PNG of the given declared size, with a valid IHDR. */
function png(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
  };

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(8))),
    ])
  );
}

function gif(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(13);
  bytes.write('GIF89a', 0);
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return new Uint8Array(bytes);
}

/** A JPEG with `segments` filler segments before its SOF0. */
function jpeg(width: number, height: number, segments = 0): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  for (let i = 0; i < segments; i += 1) {
    const filler = Buffer.alloc(4 + 8);
    filler.writeUInt8(0xff, 0);
    filler.writeUInt8(0xe0, 1); // APP0
    filler.writeUInt16BE(10, 2); // length covers itself plus payload
    parts.push(filler);
  }

  const sof = Buffer.alloc(4 + 5);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1); // SOF0
  sof.writeUInt16BE(7, 2);
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof, Buffer.alloc(8));

  return new Uint8Array(Buffer.concat(parts));
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(40);
  bytes.write('RIFF', 0);
  bytes.write('WEBP', 8);
  bytes.write('VP8X', 12);
  // Canvas dimensions are stored minus one, 24-bit little-endian.
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return new Uint8Array(bytes);
}

describe('reading a header', () => {
  it('reads PNG', () => {
    expect(imageDimensions('image/png', png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('reads GIF', () => {
    expect(imageDimensions('image/gif', gif(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('reads JPEG', () => {
    expect(imageDimensions('image/jpeg', jpeg(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it('reads JPEG past the segments that precede its frame header', () => {
    // A real photo carries EXIF and quantisation tables first; a reader that
    // assumed a fixed offset would measure one of those instead.
    expect(imageDimensions('image/jpeg', jpeg(800, 600, 12))).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('reads extended WebP', () => {
    expect(imageDimensions('image/webp', webpVp8x(4000, 3000))).toEqual({
      width: 4000,
      height: 3000,
    });
  });
});

describe('the bomb cases', () => {
  it('reports the enormous size a small PNG declares', () => {
    const bomb = png(60_000, 60_000);

    // A few dozen bytes on disk, 3.6 gigapixels once decoded. The file is
    // small, so no size limit would ever fire on it.
    expect(bomb.byteLength).toBeLessThan(200);
    const dimensions = imageDimensions('image/png', bomb);
    expect(dimensions!.width * dimensions!.height).toBe(3_600_000_000);
  });

  it('reports a GIF at the largest size its header can express', () => {
    const dimensions = imageDimensions('image/gif', gif(65_535, 65_535));
    expect(dimensions).toEqual({ width: 65_535, height: 65_535 });
  });
});

describe('what cannot be read is not guessed at', () => {
  it.each([
    ['a truncated PNG', 'image/png', png(10, 10).slice(0, 20)],
    [
      'a PNG whose first chunk is not IHDR',
      'image/png',
      (() => {
        const bytes = png(10, 10);
        bytes[12] = 0x58;
        return bytes;
      })(),
    ],
    [
      'a JPEG with no frame header',
      'image/jpeg',
      new Uint8Array([0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ],
    ['a zero-sized PNG', 'image/png', png(0, 0)],
    ['an unknown media type', 'audio/wav', png(10, 10)],
  ])('returns null for %s', (_label, mediaType, bytes) => {
    // null means "unreadable", and the caller refuses on it — an image whose
    // cost cannot be bounded is not one to accept.
    expect(imageDimensions(mediaType, bytes)).toBeNull();
  });

  it('does not spin on a JPEG whose segment lengths never advance', () => {
    // A zero length would step the cursor backwards forever without the guard.
    const malformed = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, ...Array(64).fill(0)]);
    expect(imageDimensions('image/jpeg', malformed)).toBeNull();
  });
});
