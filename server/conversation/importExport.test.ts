import { strFromU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convertConversation, memoryBody, readExport } from './importExport.ts';

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

/**
 * Recovering artifacts.
 *
 * The current export splits one artifact across a pair of blocks and joins
 * them on `file_path`; the older one carried the lot in a single block. Both
 * shapes are here because a reader's archive reaches back further than the
 * format does.
 */
describe('artifacts', () => {
  function chat(content: unknown[]) {
    return {
      uuid: '0b7e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
      name: 'Creating a test artifact',
      created_at: '2026-09-12T08:26:00.000Z',
      chat_messages: [
        {
          uuid: '01a094b9-1111-4222-8333-444455556666',
          sender: 'assistant',
          created_at: '2026-09-12T08:26:54.560Z',
          content,
        },
      ],
    };
  }

  const createFile = (path: string, text: string, description?: string) => ({
    type: 'tool_use',
    name: 'create_file',
    input: { path, file_text: text, ...(description === undefined ? {} : { description }) },
  });

  const presentFiles = (resources: unknown[]) => ({
    type: 'tool_result',
    name: 'present_files',
    content: resources,
  });

  const resource = (path: string, name: string, publishable = true) => ({
    type: 'local_resource',
    file_path: path,
    name,
    mime_type: 'text/html',
    artifact_publishable: publishable,
  });

  it('joins the payload to its presentation on the file path', () => {
    const { artifacts } = convertConversation(
      chat([
        createFile('/mnt/user-data/outputs/test.html', '<!DOCTYPE html>', 'A counter'),
        presentFiles([resource('/mnt/user-data/outputs/test.html', 'test-artifact')]),
      ]) as never
    );

    expect(artifacts).toEqual([
      {
        name: 'test-artifact',
        mediaType: 'text/html',
        content: '<!DOCTYPE html>',
        description: 'A counter',
        createdAt: '2026-09-12T08:26:54.560Z',
      },
    ]);
  });

  it('keeps a working file out of the list', () => {
    // The model writes scratch files too. `present_files` is the line between
    // one of those and an artifact.
    const { artifacts } = convertConversation(
      chat([createFile('/mnt/user-data/outputs/scratch.html', '<p>x</p>')]) as never
    );

    expect(artifacts).toEqual([]);
  });

  it('keeps a file presented without the publishable flag out of the list', () => {
    const { artifacts } = convertConversation(
      chat([
        createFile('/mnt/user-data/outputs/a.html', '<p>x</p>'),
        presentFiles([resource('/mnt/user-data/outputs/a.html', 'a', false)]),
      ]) as never
    );

    expect(artifacts).toEqual([]);
  });

  it('ignores a presentation with no payload to go with it', () => {
    const { artifacts } = convertConversation(
      chat([presentFiles([resource('/mnt/user-data/outputs/gone.html', 'gone')])]) as never
    );

    expect(artifacts).toEqual([]);
  });

  it('recovers every artifact from one presentation of many', () => {
    const { artifacts } = convertConversation(
      chat([
        createFile('/mnt/user-data/outputs/a.html', '<p>a</p>'),
        createFile('/mnt/user-data/outputs/b.py', 'print(1)'),
        presentFiles([
          resource('/mnt/user-data/outputs/a.html', 'a'),
          { ...resource('/mnt/user-data/outputs/b.py', 'b'), mime_type: 'text/x-python' },
        ]),
      ]) as never
    );

    expect(artifacts.map((a) => [a.name, a.mediaType])).toEqual([
      ['a', 'text/html'],
      ['b', 'text/x-python'],
    ]);
  });

  it('falls back to the path when the declared type is not one we can present', () => {
    const { artifacts } = convertConversation(
      chat([
        createFile('/mnt/user-data/outputs/script.py', 'print(1)'),
        presentFiles([
          {
            ...resource('/mnt/user-data/outputs/script.py', 'script'),
            mime_type: 'application/x-weird',
          },
        ]),
      ]) as never
    );

    expect(artifacts[0]?.mediaType).toBe('text/x-python');
  });

  it('reads the older single-block shape too', () => {
    const { artifacts } = convertConversation(
      chat([
        {
          type: 'tool_use',
          name: 'artifacts',
          input: {
            command: 'create',
            id: 'login-page',
            title: 'Login page',
            type: 'text/html',
            content: '<form></form>',
          },
        },
      ]) as never
    );

    expect(artifacts).toEqual([
      {
        name: 'Login page',
        mediaType: 'text/html',
        content: '<form></form>',
        createdAt: '2026-09-12T08:26:54.560Z',
      },
    ]);
  });

  it('takes the language from the older shape when its type is a code wrapper', () => {
    const { artifacts } = convertConversation(
      chat([
        {
          type: 'tool_use',
          name: 'artifacts',
          input: {
            command: 'create',
            title: 'run_agent',
            type: 'application/vnd.ant.code',
            language: 'python',
            content: 'print(1)',
          },
        },
      ]) as never
    );

    expect(artifacts[0]?.mediaType).toBe('text/x-python');
  });

  it('ignores an update, which has no guaranteed base in the archive', () => {
    const { artifacts } = convertConversation(
      chat([
        {
          type: 'tool_use',
          name: 'artifacts',
          input: { command: 'update', id: 'login-page', content: 'patch' },
        },
      ]) as never
    );

    expect(artifacts).toEqual([]);
  });

  it('stops counting a recovered artifact as a dropped tool block', () => {
    const { dropped, artifacts } = convertConversation(
      chat([
        createFile('/mnt/user-data/outputs/a.html', '<p>a</p>'),
        presentFiles([resource('/mnt/user-data/outputs/a.html', 'a')]),
        { type: 'tool_use', name: 'memory_write', input: {} },
      ]) as never
    );

    expect(artifacts).toHaveLength(1);
    // Only the memory write, which really is discarded.
    expect(dropped.toolBlocks).toBe(1);
  });
});

/** Guards the fixture helper itself, so a failure above is never the zip. */
it('builds readable fixtures', () => {
  const bytes = zip({ 'a.json': '{"ok":true}' });
  expect(strFromU8(bytes.slice(0, 2))).toBe('PK');
});
