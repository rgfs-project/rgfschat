import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, type Conversation, type Message } from '@shared/conversation.ts';
import { assemblePrompt, estimateTokens } from './prompt.ts';

function conversation(messages: Message[]): Conversation {
  return {
    formatVersion: FORMAT_VERSION,
    title: 'x',
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    messages,
  };
}

const sys = (body: string): Message => ({ type: 'system', id: randomUUID(), body });
const user = (body: string): Message => ({ type: 'user', id: randomUUID(), body });
const asst = (body: string, reasoning?: string): Message => ({
  type: 'assistant',
  id: randomUUID(),
  status: 'complete',
  ...(reasoning !== undefined ? { reasoning } : {}),
  body,
});

const ROOMY = { contextTokens: 100_000, maxOutputTokens: 1_000 };

describe('assemblePrompt', () => {
  it('puts every system message first, in file order', () => {
    const { messages } = assemblePrompt(
      conversation([sys('one'), user('q'), sys('two'), asst('a')]),
      ROOMY
    );

    expect(messages.slice(0, 2)).toEqual([
      { role: 'system', content: 'one' },
      { role: 'system', content: 'two' },
    ]);
    expect(messages.slice(2)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  it('never sends reasoning back to the model', () => {
    const { messages } = assemblePrompt(
      conversation([user('q'), asst('answer', 'secret chain of thought')]),
      ROOMY
    );

    expect(JSON.stringify(messages)).not.toContain('secret chain of thought');
    expect(messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'answer' },
    ]);
  });

  it('skips assistant messages with an empty body', () => {
    // A failed generation writes one; replaying it would teach the model silence.
    const { messages } = assemblePrompt(conversation([user('q'), asst(''), user('q2')]), ROOMY);

    expect(messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('drops the oldest non-system messages, whole, until it fits', () => {
    const messages = [
      sys('keep me'),
      user('oldest'),
      asst('old answer'),
      user('middle'),
      asst('mid answer'),
      user('newest'),
    ];
    // Input budget of 20 tokens: system ("keep me") costs 7 and the newest
    // message 6, leaving too little for the next turn back, which costs 8.
    const budget = { contextTokens: 30, maxOutputTokens: 10 };

    const result = assemblePrompt(conversation(messages), budget);

    expect(result.messages[0]).toEqual({ role: 'system', content: 'keep me' });
    expect(result.messages.at(-1)).toEqual({ role: 'user', content: 'newest' });
    expect(result.dropped).toBeGreaterThan(0);
    // Whole messages only — nothing is truncated mid-content.
    for (const message of result.messages) {
      expect(messages.some((m) => m.body === message.content)).toBe(true);
    }
  });

  it('never drops the newest user message', () => {
    const long = 'x'.repeat(2_000);
    const result = assemblePrompt(conversation([user(long), asst(long), user('the newest one')]), {
      contextTokens: estimateTokens('the newest one') + 60,
      maxOutputTokens: 10,
    });

    expect(result.messages).toEqual([{ role: 'user', content: 'the newest one' }]);
    expect(result.dropped).toBe(2);
  });

  it('raises CONTEXT_TOO_LARGE when system plus the newest message alone do not fit', () => {
    const huge = 'x'.repeat(50_000);

    expect(() =>
      assemblePrompt(conversation([sys('rules'), user(huge)]), {
        contextTokens: 1_000,
        maxOutputTokens: 100,
      })
    ).toThrow(expect.objectContaining({ code: 'CONTEXT_TOO_LARGE' }));
  });

  it('raises CONTEXT_TOO_LARGE when the output reservation consumes the whole context', () => {
    expect(() =>
      assemblePrompt(conversation([user('hi')]), { contextTokens: 100, maxOutputTokens: 100 })
    ).toThrow(expect.objectContaining({ code: 'CONTEXT_TOO_LARGE' }));
  });

  it('handles a conversation with no messages', () => {
    expect(assemblePrompt(conversation([]), ROOMY).messages).toEqual([]);
  });
});

describe('estimateTokens', () => {
  it('is conservative: at least one token per three bytes', () => {
    expect(estimateTokens('abc')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens('x'.repeat(300))).toBeGreaterThanOrEqual(100);
  });

  it('counts bytes, not characters, so multi-byte text is not under-counted', () => {
    // A 3-byte character must not be billed as one byte.
    expect(estimateTokens('€')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens('€€€')).toBeGreaterThanOrEqual(3);
  });
});
