import { strFromU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { memoryBody, readExport } from './importExport.ts';

/**
 * Reading a Claude data export.
 *
 * The fixtures here are the shapes a real export actually uses, kept small.
 */

function zip(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, body]) => [name, encoder.encode(body)]))
  );
}

describe('memoryBody', () => {
  /*
   * Every memory is prepended to the system prompt of every generation, so the
   * export's own indexing metadata is context spent on another application's
   * filing system. On a short note it is most of the bytes.
   */
  it('drops the export front matter and keeps the note', () => {
    const content = [
      '---',
      'name: hazel',
      "description: User's dog",
      'sources: [chat]',
      'aliases: []',
      '---',
      '',
      '- [stated] user has a dog named Hazel',
      '',
    ].join('\n');

    expect(memoryBody(content)).toBe('- [stated] user has a dog named Hazel');
    expect(memoryBody(content).length).toBeLessThan(content.length / 2);
  });

  it('leaves a note that merely contains a rule alone', () => {
    const content = 'Some prose\n\n---\n\nmore prose';
    expect(memoryBody(content)).toBe(content);
  });

  it('leaves an unterminated fence alone rather than eating the file', () => {
    const content = '---\nname: broken\n\nstill the note';
    expect(memoryBody(content)).toBe(content);
  });

  it('keeps the original when the note is nothing but front matter', () => {
    // The store refuses an empty memory, so having something beats having none.
    const content = '---\nname: empty\n---\n';
    expect(memoryBody(content)).toBe(content.trim());
  });

  it('handles CRLF, which a zip round-trip can introduce', () => {
    const content = '---\r\nname: x\r\n---\r\n\r\n- [stated] a fact\r\n';
    expect(memoryBody(content)).toBe('- [stated] a fact');
  });
});

describe('readExport', () => {
  it('carries each memory path, body and timestamp', () => {
    const memories = JSON.stringify({
      memory_files: [
        {
          path: '/people/hazel.md',
          content: '---\nname: hazel\n---\n\n- [stated] a dog named Hazel\n',
          updated_at: '2026-09-13T05:26:32.417968+00:00',
        },
      ],
      account_uuid: '919b2657-be72-47eb-b704-8bd035b8133c',
    });

    const found = readExport(zip({ 'memories/919b2657.json': memories }));

    expect(found.memories).toHaveLength(1);
    expect(found.memories[0]?.path).toBe('/people/hazel.md');
    expect(found.memories[0]?.updated_at).toBe('2026-09-13T05:26:32.417968+00:00');
  });

  it('reads a memories file with no timestamps at all', () => {
    const memories = JSON.stringify({
      memory_files: [{ path: '/topics/food.md', content: 'crepes' }],
    });

    const found = readExport(zip({ 'memories.json': memories }));

    expect(found.memories[0]?.updated_at).toBeUndefined();
  });

  it('ignores the archives that carry nothing importable', () => {
    // light_metadata and feedback are part of every export and hold neither.
    const found = readExport(
      zip({
        'users.json': JSON.stringify([{ uuid: 'u', email_address: 'a@b.c' }]),
        'login_history.json': JSON.stringify([{ at: '2026-01-01' }]),
      })
    );

    expect(found).toEqual({ conversations: [], memories: [] });
  });

  it('reads bare JSON as readily as a zip', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ memory_files: [{ path: '/a.md', content: 'x' }] })
    );

    expect(readExport(bytes).memories).toHaveLength(1);
  });

  it('survives a member that is not JSON at all', () => {
    const found = readExport(
      zip({
        'notes.txt': 'not json',
        'memories.json': JSON.stringify({ memory_files: [{ path: '/a.md', content: 'x' }] }),
      })
    );

    expect(found.memories).toHaveLength(1);
  });
});

/** Guards the fixture helper itself, so a failure above is never the zip. */
it('builds readable fixtures', () => {
  const bytes = zip({ 'a.json': '{"ok":true}' });
  expect(strFromU8(bytes.slice(0, 2))).toBe('PK');
});
