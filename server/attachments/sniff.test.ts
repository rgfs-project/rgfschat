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
    const wav = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE'), 0]);
    expect(sniff(wav, 'sound.webp').ok).toBe(false);
  });

  it('refuses binary that happens to be valid UTF-8', () => {
    /*
     * This is the WAV above, and it decodes cleanly — its length bytes are
     * zero, and NUL is valid UTF-8. Accepted as text it would be pasted into a
     * model's prompt, which is what makes "valid UTF-8" the wrong question.
     */
    const wav = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')]);
    const result = sniff(wav, 'sound.dat');

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
