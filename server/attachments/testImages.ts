import { deflateSync } from 'node:zlib';

/**
 * Real image bytes, for tests.
 *
 * Named like `auth/testClient.ts` and used only from tests. It exists because
 * the fixtures it replaces were eight magic bytes and some filler — enough to
 * satisfy a sniffer that only reads a signature, and not enough to satisfy
 * anything that reads the header properly. When the dimension check arrived,
 * twelve tests failed at once, all of them for the same reason and none of
 * them because the code was wrong.
 *
 * A fixture that is not a real example of the thing stops testing the thing.
 */

/** A valid PNG declaring `width` x `height`, with a correct IHDR. */
export function pngBytes(width = 8, height = 8): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour

  // The CRC is left zero: nothing in this application verifies it, and a real
  // one would need a table here purely to satisfy a check nobody makes.
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

/** A tiny WAV, for the audio paths. */
export function wavBytes(samples = 8): Uint8Array {
  const data = Buffer.alloc(samples * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16_000, 24);
  head.writeUInt32LE(32_000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([head, data]));
}
