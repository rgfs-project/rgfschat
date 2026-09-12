import { describe, expect, it } from 'vitest';
import { sniff } from './sniff.ts';

/**
 * The sniffer, against files that lie about themselves.
 *
 * Every case here is a file whose name or declared type disagrees with its
 * bytes, because agreement is the uninteresting case: the reason this module
 * exists is that neither of those two is evidence.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new Uint8Array([...Buffer.from('GIF89a'), 0, 0]);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), 0]);
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

describe('images are identified by signature', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
  ])('recognises %s', (mediaType, bytes) => {
    expect(sniff(bytes, 'whatever.bin')).toEqual({ ok: true, mediaType });
  });

  it('INV-27: a spoofed extension cannot make text into an image', () => {
    // Named and typed as a PNG by the uploader; it is a shell script.
    const result = sniff(utf8('#!/bin/sh\nrm -rf /\n'), 'photo.png');

    expect(result.ok).toBe(true);
    // Stored as text, so it is served as a download and never rendered.
    expect(result).toEqual({ ok: true, mediaType: 'text/plain' });
  });

  it('INV-27: a spoofed extension cannot make an image into text', () => {
    // Real PNG bytes named `.txt`. The bytes win, so it is served as an image
    // rather than as text a reader might open expecting to read it.
    expect(sniff(PNG, 'notes.txt')).toEqual({ ok: true, mediaType: 'image/png' });
  });

  it('does not mistake another RIFF container for WebP', () => {
    // RIFF is a container, not a format. Named `.webp` and holding WAVE, it is
    // audio — the form type at byte 8 decides, not the four bytes at the front.
    const wav = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE'), 0]);
    expect(sniff(wav, 'sound.webp')).toEqual({ ok: true, mediaType: 'audio/wav' });
  });

  it('refuses binary that happens to be valid UTF-8', () => {
    /*
     * Valid UTF-8 — NUL is a legal code point — and not any format this
     * application recognises. Accepted as text it would be inlined into a
     * model's prompt, which is what makes "valid UTF-8" the wrong question to
     * have asked.
     */
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x00, 0x41, 0x42]);
    const result = sniff(binary, 'sound.dat');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not text/i);
  });

  it('does not accept a truncated signature', () => {
    expect(sniff(PNG.subarray(0, 4), 'tiny.png').ok).toBe(false);
  });
});

describe('markup is refused however it is labelled', () => {
  it.each([
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['svg behind an xml declaration', '<?xml version="1.0"?>\n<svg><script/></svg>'],
    ['svg behind whitespace', '\n\n   <svg onload="alert(1)"/>'],
    ['html', '<!DOCTYPE html><html><body><script>alert(1)</script>'],
    ['bare html', '<html><img src=x onerror=alert(1)>'],
    ['comment-led html', '<!-- hi --><html>'],
  ])('rejects %s', (_label, content) => {
    const result = sniff(utf8(content), 'image.svg');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SVG|Markup/i);
  });

  it('rejects markup even when named as a plain text file', () => {
    expect(sniff(utf8('<svg/>'), 'harmless.txt').ok).toBe(false);
  });

  it('does not reject Markdown that merely contains a tag later on', () => {
    const document = '# Title\n\nSome prose, and then <svg/> mentioned in passing.\n';
    expect(sniff(utf8(document), 'notes.md')).toEqual({ ok: true, mediaType: 'text/markdown' });
  });
});

describe('text must be valid UTF-8', () => {
  it('rejects a lone continuation byte', () => {
    expect(sniff(new Uint8Array([0x80]), 'notes.txt').ok).toBe(false);
  });

  it('rejects a truncated multi-byte sequence', () => {
    // The first two bytes of a three-byte character, and then nothing.
    expect(sniff(new Uint8Array([0xe2, 0x82]), 'notes.txt').ok).toBe(false);
  });

  it('rejects a surrogate half encoded as UTF-8', () => {
    expect(sniff(new Uint8Array([0xed, 0xa0, 0x80]), 'notes.txt').ok).toBe(false);
  });

  it('accepts text well outside ASCII', () => {
    expect(sniff(utf8('café — 日本語 — 🙂'), 'notes.txt')).toEqual({
      ok: true,
      mediaType: 'text/plain',
    });
  });

  it('accepts a byte-order mark', () => {
    expect(sniff(utf8('﻿# Title'), 'notes.md')).toEqual({
      ok: true,
      mediaType: 'text/markdown',
    });
  });

  it('accepts an empty file as text', () => {
    expect(sniff(new Uint8Array(0), 'empty.txt')).toEqual({ ok: true, mediaType: 'text/plain' });
  });
});

describe('the extension chooses only between text types', () => {
  it.each([
    ['notes.md', 'text/markdown'],
    ['notes.markdown', 'text/markdown'],
    ['rows.csv', 'text/csv'],
    ['data.json', 'application/json'],
    ['README', 'text/plain'],
    ['script.ts', 'text/plain'],
    ['NOTES.MD', 'text/markdown'],
  ])('%s becomes %s', (filename, mediaType) => {
    expect(sniff(utf8('content'), filename)).toEqual({ ok: true, mediaType });
  });

  it('an unknown extension is still stored, as plain text', () => {
    expect(sniff(utf8('x = 1'), 'config.toml')).toEqual({ ok: true, mediaType: 'text/plain' });
  });
});

describe('audio is identified by signature', () => {
  /** A minimal but real WAV header: RIFF … WAVE … fmt. */
  const WAV = new Uint8Array([
    ...Buffer.from('RIFF'),
    0x24,
    0x00,
    0x00,
    0x00,
    ...Buffer.from('WAVE'),
    ...Buffer.from('fmt '),
  ]);
  const FLAC = new Uint8Array([...Buffer.from('fLaC'), 0, 0, 0, 34]);
  const MP3_TAGGED = new Uint8Array([...Buffer.from('ID3'), 0x04, 0x00, 0x00]);
  // A bare MPEG-1 Layer III frame header: sync, version 3, layer 1.
  const MP3_BARE = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);

  it.each([
    ['audio/wav', WAV],
    ['audio/flac', FLAC],
    ['audio/mpeg', MP3_TAGGED],
    ['audio/mpeg', MP3_BARE],
  ])('recognises %s', (mediaType, bytes) => {
    expect(sniff(bytes, 'clip.bin')).toEqual({ ok: true, mediaType });
  });

  it('tells WAV apart from WebP, which shares the RIFF container', () => {
    expect(sniff(WAV, 'x.webp')).toEqual({ ok: true, mediaType: 'audio/wav' });
    expect(sniff(WEBP, 'x.wav')).toEqual({ ok: true, mediaType: 'image/webp' });
  });

  it('does not treat an arbitrary 0xFF byte pair as MP3', () => {
    // Sync bits set but a reserved version and layer: not a frame header.
    expect(sniff(new Uint8Array([0xff, 0xe9, 0x00, 0x00]), 'x.mp3').ok).toBe(false);
  });
});

describe('containers nothing here can read are refused by name', () => {
  const iso = (brand: string): Uint8Array =>
    new Uint8Array([0, 0, 0, 0x20, ...Buffer.from('ftyp'), ...Buffer.from(brand)]);

  it.each([
    ['an MP4', iso('isom'), /video/i],
    ['a QuickTime movie', iso('qt  '), /video/i],
    ['an M4A, which is audio in a container the decoder cannot open', iso('M4A '), /video/i],
    ['a WebM', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]), /video/i],
    [
      'an AVI',
      new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('AVI ')]),
      /video/i,
    ],
    ['a PDF', new Uint8Array(Buffer.from('%PDF-1.7\n')), /pdf/i],
    ['a zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), /archive/i],
  ])('refuses %s', (_label, bytes, reason) => {
    const result = sniff(bytes, 'file.mp4');

    expect(result.ok).toBe(false);
    // Named, not merely "unsupported": the reason is what tells the reader
    // this is a file nothing here could have read, rather than a mistake.
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it('says what can be attached instead', () => {
    const result = sniff(iso('isom'), 'clip.mp4');
    if (!result.ok) expect(result.reason).toMatch(/images, audio and text/i);
  });
});
