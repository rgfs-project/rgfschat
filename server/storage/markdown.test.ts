import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '@shared/conversation.ts';
import { deriveTitle } from '@shared/conversation.ts';
import { parseConversation, serializeConversation } from './markdown.ts';

const ID_A = '0b7e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const ID_B = '9d44c0de-1111-4222-8333-444455556666';
const ID_C = '6f1c2222-3333-4444-8555-666677778888';

function conversation(messages: Message[], overrides: Partial<Conversation> = {}): Conversation {
  return {
    formatVersion: 1,
    title: 'Trip planning',
    createdAt: '2026-09-11T17:03:12.000Z',
    updatedAt: '2026-09-11T17:05:40.512Z',
    messages,
    ...overrides,
  };
}

/** Parses and fails the test loudly if the input was malformed. */
function parseOk(text: string): Conversation {
  const result = parseConversation(text);
  if (!result.ok)
    throw new Error(`expected ok, got malformed: ${result.reason} (line ${result.line})`);
  return result.conversation;
}

function expectMalformed(text: string): { reason: string; line: number } {
  const result = parseConversation(text);
  if (result.ok) throw new Error('expected malformed, got ok');
  return { reason: result.reason, line: result.line };
}

const FRONT = [
  '---',
  'formatVersion: 1',
  'title: "Trip planning"',
  'createdAt: "2026-09-11T17:03:12.000Z"',
  'updatedAt: "2026-09-11T17:05:40.512Z"',
  '---',
  '',
].join('\n');

describe('front matter', () => {
  it('parses a zero-message conversation', () => {
    const parsed = parseOk(FRONT);

    expect(parsed.messages).toEqual([]);
    expect(parsed.title).toBe('Trip planning');
  });

  it('rejects a missing key', () => {
    const text = [
      '---',
      'formatVersion: 1',
      'title: "x"',
      'createdAt: "2026-09-11T17:03:12.000Z"',
      '---',
      '',
    ].join('\n');

    expect(expectMalformed(text).reason).toMatch(/exactly four keys/);
  });

  it('rejects an extra key', () => {
    const text = FRONT.replace('updatedAt:', 'extra: 1\nupdatedAt:');

    expect(expectMalformed(text).reason).toMatch(/exactly four keys/);
  });

  it('rejects reordered keys', () => {
    const text = [
      '---',
      'title: "x"',
      'formatVersion: 1',
      'createdAt: "2026-09-11T17:03:12.000Z"',
      'updatedAt: "2026-09-11T17:05:40.512Z"',
      '---',
      '',
    ].join('\n');

    expect(expectMalformed(text).reason).toMatch(/must be "formatVersion"/);
  });

  it('rejects any formatVersion other than the integer 1 — there is no implicit migration', () => {
    expect(expectMalformed(FRONT.replace('formatVersion: 1', 'formatVersion: 2')).reason).toMatch(
      /formatVersion/
    );
    expect(expectMalformed(FRONT.replace('formatVersion: 1', 'formatVersion: "1"')).reason).toMatch(
      /formatVersion/
    );
  });

  it('rejects an invalid title or timestamp', () => {
    expect(expectMalformed(FRONT.replace('"Trip planning"', '""')).reason).toMatch(/title/);
    expect(
      expectMalformed(FRONT.replace('"Trip planning"', `"${'x'.repeat(201)}"`)).reason
    ).toMatch(/title/);
    expect(expectMalformed(FRONT.replace('2026-09-11T17:03:12.000Z', '2026-09-11')).reason).toMatch(
      /createdAt/
    );
    expect(
      expectMalformed(FRONT.replace('2026-09-11T17:05:40.512Z', '2026-13-99T99:99:99.999Z')).reason
    ).toMatch(/updatedAt/);
  });

  it('requires the front matter to be first', () => {
    expect(expectMalformed(`stray\n${FRONT}`).reason).toMatch(/begin with/);
  });

  it('accepts a BOM and drops it, and accepts CRLF', () => {
    expect(parseOk(`\uFEFF${FRONT}`).title).toBe('Trip planning');
    expect(parseOk(FRONT.replace(/\n/g, '\r\n')).title).toBe('Trip planning');
  });

  it('treats a lone CR inside a line as content, but CRLF as a line ending', () => {
    const withLoneCr = `${FRONT}<!-- cc:user id=${ID_A} -->\na\rb\n`;
    expect(parseOk(withLoneCr).messages[0]?.body).toBe('a\rb');

    // The same bytes with the CR at end-of-line are a CRLF and collapse to LF,
    // so a body cannot end a line with CR. This is a property of the format,
    // not a parser bug.
    const withCrlf = `${FRONT}<!-- cc:user id=${ID_A} -->\na\r\nb\n`;
    expect(parseOk(withCrlf).messages[0]?.body).toBe('a\nb');
  });
});

describe('delimiter grammar', () => {
  const withBlock = (delimiter: string, body = 'hello'): string =>
    `${FRONT}${delimiter}\n${body}\n`;

  it('accepts attributes in any order and tolerates extra whitespace', () => {
    const parsed = parseOk(
      withBlock(`  <!--\tcc:assistant   status=complete   id=${ID_A}  model="m"  -->  `)
    );

    expect(parsed.messages[0]).toEqual({
      type: 'assistant',
      id: ID_A,
      status: 'complete',
      model: 'm',
      body: 'hello',
    });
  });

  it.each([
    ['unknown type', `<!-- cc:robot id=${ID_A} -->`, /unknown block type/],
    ['unknown attribute', `<!-- cc:user id=${ID_A} colour=red -->`, /unknown attribute/],
    ['duplicate attribute', `<!-- cc:user id=${ID_A} id=${ID_B} -->`, /duplicate attribute/],
    ['attribute not allowed on type', `<!-- cc:user id=${ID_A} status=complete -->`, /not allowed/],
    ['missing required id', `<!-- cc:user -->`, /requires attribute "id"/],
    ['missing required status', `<!-- cc:assistant id=${ID_A} -->`, /requires attribute "status"/],
    ['non-canonical id', `<!-- cc:user id=NOT-A-UUID -->`, /canonical/],
    ['uppercase id', `<!-- cc:user id=${ID_A.toUpperCase()} -->`, /canonical/],
    ['invalid status', `<!-- cc:assistant id=${ID_A} status=done -->`, /invalid status/],
    ['missing close', `<!-- cc:user id=${ID_A}`, /missing "-->"/],
    ['trailing junk', `<!-- cc:user id=${ID_A} --> junk`, /trailing characters/],
    [
      'no whitespace before attribute',
      `<!-- cc:userid=${ID_A} -->`,
      /unknown block type|whitespace/,
    ],
    ['empty value', `<!-- cc:user id= -->`, /empty attribute value/],
    [
      'unterminated quote',
      `<!-- cc:assistant id=${ID_A} status=complete model="m -->`,
      /unterminated/,
    ],
  ])('rejects %s', (_label, delimiter, pattern) => {
    expect(expectMalformed(withBlock(delimiter)).reason).toMatch(pattern);
  });

  it('rejects a delimiter-like line that does not parse, anywhere in the file', () => {
    const text = `${FRONT}<!-- cc:user id=${ID_A} -->\nhello\n<!--   cc:bogus -->\n`;

    expect(expectMalformed(text).reason).toMatch(/unknown block type/);
  });

  it('rejects duplicate ids', () => {
    const text = `${FRONT}<!-- cc:user id=${ID_A} -->\na\n\n<!-- cc:user id=${ID_A} -->\nb\n`;

    expect(expectMalformed(text).reason).toMatch(/duplicate id/);
  });

  it('validates attachments: 1-10 canonical uuids', () => {
    const ok = parseOk(`${FRONT}<!-- cc:user id=${ID_A} attachments="${ID_B},${ID_C}" -->\nx\n`);
    expect((ok.messages[0] as { attachments?: string[] }).attachments).toEqual([ID_B, ID_C]);

    expect(
      expectMalformed(`${FRONT}<!-- cc:user id=${ID_A} attachments="" -->\nx\n`).reason
    ).toMatch(/attachments/);
    expect(
      expectMalformed(`${FRONT}<!-- cc:user id=${ID_A} attachments="${ID_B}, ${ID_C}" -->\nx\n`)
        .reason
    ).toMatch(/attachments/);

    const eleven = Array.from({ length: 11 }, () => ID_B).join(',');
    expect(
      expectMalformed(`${FRONT}<!-- cc:user id=${ID_A} attachments="${eleven}" -->\nx\n`).reason
    ).toMatch(/1-10/);
  });
});

describe('reasoning adjacency', () => {
  it('folds a reasoning block into the assistant block that follows it', () => {
    const text = `${FRONT}<!-- cc:reasoning id=${ID_B} -->\nthinking\n\n<!-- cc:assistant id=${ID_B} status=complete -->\nanswer\n`;

    expect(parseOk(text).messages[0]).toEqual({
      type: 'assistant',
      id: ID_B,
      status: 'complete',
      reasoning: 'thinking',
      body: 'answer',
    });
  });

  it('rejects reasoning not followed by an assistant block', () => {
    const text = `${FRONT}<!-- cc:reasoning id=${ID_B} -->\nthinking\n\n<!-- cc:user id=${ID_A} -->\nhi\n`;

    expect(expectMalformed(text).reason).toMatch(/immediately followed/);
  });

  it('rejects reasoning followed by an assistant with a different id', () => {
    const text = `${FRONT}<!-- cc:reasoning id=${ID_B} -->\nt\n\n<!-- cc:assistant id=${ID_A} status=complete -->\na\n`;

    expect(expectMalformed(text).reason).toMatch(/immediately followed/);
  });

  it('rejects reasoning at end of file', () => {
    expect(expectMalformed(`${FRONT}<!-- cc:reasoning id=${ID_B} -->\nt\n`).reason).toMatch(
      /must be followed/
    );
  });

  it('rejects two reasoning blocks in a row', () => {
    const text = `${FRONT}<!-- cc:reasoning id=${ID_B} -->\na\n\n<!-- cc:reasoning id=${ID_B} -->\nb\n\n<!-- cc:assistant id=${ID_B} status=complete -->\nc\n`;

    expect(expectMalformed(text).reason).toMatch(/must be followed/);
  });
});

describe('bodies and escaping', () => {
  it('strips leading and trailing blank lines but preserves interior bytes', () => {
    const text = `${FRONT}<!-- cc:user id=${ID_A} -->\n\n\n  a  \n\n\tb\t\n\n\n`;

    expect(parseOk(text).messages[0]?.body).toBe('  a  \n\n\tb\t');
  });

  it('rejects content before the first delimiter but allows blank lines', () => {
    expect(expectMalformed(`${FRONT}stray text\n`).reason).toMatch(/content before/);
    expect(parseOk(`${FRONT}\n\n<!-- cc:user id=${ID_A} -->\nx\n`).messages).toHaveLength(1);
  });

  it('escapes a delimiter-like content line so it cannot be mistaken for a delimiter', () => {
    const body = `<!-- cc:user id=${ID_A} -->`;
    const text = serializeConversation(conversation([{ type: 'user', id: ID_A, body }]));

    expect(text).toContain(`\\<!-- cc:user id=${ID_A} -->`);
    expect(parseOk(text).messages).toHaveLength(1);
    expect(parseOk(text).messages[0]?.body).toBe(body);
  });

  it('round-trips a body that already starts with backslashes', () => {
    for (const prefix of ['\\', '\\\\', '\\\\\\']) {
      const body = `${prefix}<!-- cc:user id=${ID_A} -->`;
      const text = serializeConversation(conversation([{ type: 'user', id: ID_A, body }]));

      expect(parseOk(text).messages[0]?.body).toBe(body);
    }
  });

  it('never lets a quoted attribute value contain "-->"', () => {
    const text = serializeConversation(
      conversation([
        { type: 'assistant', id: ID_A, status: 'complete', model: 'a --> b & <c>', body: 'x' },
      ])
    );

    const delimiter = text.split('\n').find((l) => l.includes('cc:assistant')) as string;
    expect(delimiter.indexOf('-->')).toBe(delimiter.length - 3);
    expect(delimiter).toContain('\\u003c');
    expect(delimiter).toContain('\\u0026');
    expect(parseOk(text).messages[0]).toMatchObject({ model: 'a --> b & <c>' });
  });
});

describe('serializer shape', () => {
  it('emits attributes in canonical order with single spaces', () => {
    const text = serializeConversation(
      conversation([
        {
          type: 'assistant',
          id: ID_A,
          status: 'complete',
          provider: 'local',
          model: 'm',
          body: 'x',
        },
      ])
    );

    expect(text).toContain(
      `<!-- cc:assistant id=${ID_A} status=complete provider="local" model="m" -->`
    );
  });

  it('ends a zero-message file in exactly one newline', () => {
    const text = serializeConversation(conversation([]));

    expect(text.endsWith('---\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('separates blocks with a blank line and ends in exactly one newline', () => {
    const text = serializeConversation(
      conversation([
        { type: 'system', id: ID_C, body: 'sys' },
        { type: 'user', id: ID_A, body: 'hi' },
      ])
    );

    expect(text).toContain('sys\n\n<!-- cc:user');
    expect(text.endsWith('hi\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('is pure — same input, same output', () => {
    const model = conversation([{ type: 'user', id: ID_A, body: 'hi' }]);

    expect(serializeConversation(model)).toBe(serializeConversation(model));
  });
});

// ---------------------------------------------------------------------------
// Property-based round trip (contracts §3.6)
// ---------------------------------------------------------------------------

/** Body lines chosen to hit the escaping and whitespace rules hard. */
const bodyLine = fc.oneof(
  fc.string(),
  fc.constant(''),
  fc.constant('   '),
  fc.constant('\t'),
  fc.constant(`<!-- cc:user id=${ID_A} -->`),
  fc.constant('\\<!-- cc:assistant id=x -->'),
  fc.constant('\\\\\\<!--\tcc:reasoning -->'),
  fc.constant('  <!--   cc:system  -->'),
  fc.constant('not a delimiter <!-- cc:user -->'),
  fc.constant('\r'),
  fc.constant('--->'),
  fc.constant('---')
);

const bodyArb = fc.array(bodyLine, { maxLength: 6 }).map((parts) => {
  // Leading and trailing blank lines are not significant (§3.5), so a canonical
  // model never carries them. The trim must run on the *joined* text, because a
  // generated part may itself span several lines — trimming the array instead
  // lets a whitespace-only final line survive, which the parser then strips,
  // failing the deep-equal for a reason that is the generator's fault, not the
  // parser's.
  const lines = parts.join('\n').split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] as string).trim() === '') start += 1;
  while (end > start && (lines[end - 1] as string).trim() === '') end -= 1;

  // A CR immediately before a newline is not a "lone CR" — together they are a
  // CRLF, which §3.2 requires the parser to normalise to LF. A body ending a
  // line with CR therefore cannot round-trip and is outside the representable
  // domain, so the generator must not produce one. A lone CR *within* a line
  // does round-trip and is covered by an example-based test below.
  return lines
    .slice(start, end)
    .join('\n')
    .replace(/\r(?=\n)/g, '')
    .replace(/\r$/, '');
});

const uuidArb = fc.uuid({ version: 4 }).map((u) => u.toLowerCase());

const messageArb = (id: string): fc.Arbitrary<Message> =>
  fc.oneof(
    bodyArb.map((body): Message => ({ type: 'system', id, body })),
    fc
      .record({
        body: bodyArb,
        attachments: fc.option(fc.array(uuidArb, { minLength: 1, maxLength: 10 }), {
          nil: undefined,
        }),
      })
      .map(({ body, attachments }): Message => ({
        type: 'user',
        id,
        ...(attachments !== undefined ? { attachments } : {}),
        body,
      })),
    fc
      .record({
        body: bodyArb,
        status: fc.constantFrom(
          'complete',
          'cancelled',
          'failed',
          'timed_out',
          'interrupted' as const
        ),
        provider: fc.option(fc.string(), { nil: undefined }),
        model: fc.option(fc.string(), { nil: undefined }),
        reasoning: fc.option(bodyArb, { nil: undefined }),
      })
      .map(({ body, status, provider, model, reasoning }): Message => ({
        type: 'assistant',
        id,
        status,
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        body,
      }))
  );

const conversationArb: fc.Arbitrary<Conversation> = fc
  .record({
    title: fc.string({ minLength: 1, maxLength: 200 }).filter((t) => !/[\r\n]/.test(t)),
    ids: fc.uniqueArray(uuidArb, { maxLength: 5 }),
  })
  .chain(({ title, ids }) =>
    fc.tuple(...ids.map((id) => messageArb(id))).map((messages) => ({
      formatVersion: 1 as const,
      title,
      createdAt: '2026-09-11T17:03:12.000Z',
      updatedAt: '2026-09-11T17:05:40.512Z',
      messages,
    }))
  );

describe('INV-09: formatVersion 1 round-trips exactly', () => {
  it('parse(serialize(x)) deep-equals x', () => {
    fc.assert(
      fc.property(conversationArb, (model) => {
        const result = parseConversation(serializeConversation(model));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.conversation).toEqual(model);
      }),
      { numRuns: 500 }
    );
  });

  it('serialize(parse(serialize(x))) === serialize(x)', () => {
    fc.assert(
      fc.property(conversationArb, (model) => {
        const once = serializeConversation(model);
        const result = parseConversation(once);
        expect(result.ok).toBe(true);
        if (result.ok) expect(serializeConversation(result.conversation)).toBe(once);
      }),
      { numRuns: 500 }
    );
  });

  it('every serialized file ends in exactly one newline', () => {
    fc.assert(
      fc.property(conversationArb, (model) => {
        const text = serializeConversation(model);
        expect(text.endsWith('\n')).toBe(true);
        expect(text.endsWith('\n\n')).toBe(false);
      }),
      { numRuns: 200 }
    );
  });
});

describe('deriveTitle', () => {
  it('truncates to 60 characters at a word boundary', () => {
    expect(deriveTitle('short question')).toBe('short question');
    expect(deriveTitle('  collapses   whitespace  ')).toBe('collapses whitespace');

    const long = 'word '.repeat(40);
    const title = deriveTitle(long);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('word')).toBe(true);
  });

  it('hard-cuts a single word longer than the limit', () => {
    expect(deriveTitle('x'.repeat(100))).toHaveLength(60);
  });
});
