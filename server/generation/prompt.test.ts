import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '@shared/conversation.ts';
import { assemblePrompt, estimateTokens } from './prompt.ts';

function conversation(messages: Message[]): Conversation {
  return {
    formatVersion: 1,
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

/**
 * An image's weight against the budget.
 *
 * These are the arithmetic behind a real failure: a large screenshot was
 * charged a flat 1,200 tokens however big it was, so a prompt the budget
 * passed was one the provider could not fit, and the reply died part-way with
 * no reason attached to it.
 */
describe('image cost', () => {
  const IMAGE_ID = '11111111-2222-4333-8444-555555555555';

  function withImage(pixels: number | undefined) {
    const message: Message = {
      type: 'user',
      id: randomUUID(),
      attachments: [IMAGE_ID],
      body: 'what is in this?',
    };
    return {
      conversation: conversation([message]),
      attachments: new Map([
        [
          IMAGE_ID,
          {
            id: IMAGE_ID,
            filename: 'shot.png',
            kind: 'image' as const,
            mediaType: 'image/png',
            content: 'data:image/png;base64,AAAA',
            truncated: false,
            ...(pixels === undefined ? {} : { pixels }),
          },
        ],
      ]),
      modalities: ['image'],
    };
  }

  /** The estimate for one image, isolated from the message's own overhead. */
  function imageCost(pixels: number | undefined): number {
    const { conversation: convo, attachments, modalities } = withImage(pixels);
    const withIt = assemblePrompt(convo, { ...ROOMY, attachments, modalities });
    const withoutIt = assemblePrompt(convo, { ...ROOMY, attachments, modalities: [] });
    return withIt.estimatedTokens - withoutIt.estimatedTokens;
  }

  it('charges a small image the floor rather than a fraction of a token', () => {
    // 256x256 is 65,536 pixels — about 21 tokens by area alone.
    expect(imageCost(256 * 256)).toBe(1_200);
  });

  it('charges a large image by its area', () => {
    // A 5120x2880 capture: 14.7 MP, which is far more than the old flat figure.
    expect(imageCost(5120 * 2880)).toBe(Math.ceil((5120 * 2880) / 3136));
    expect(imageCost(5120 * 2880)).toBeGreaterThan(4_000);
  });

  it('scales with area, so a bigger picture never costs less', () => {
    expect(imageCost(3840 * 2160)).toBeGreaterThan(imageCost(1920 * 1080));
  });

  it('falls back to the floor when the header could not be read', () => {
    expect(imageCost(undefined)).toBe(1_200);
  });

  it('refuses a picture too large for the context instead of letting the provider fail', () => {
    const { conversation: convo, attachments, modalities } = withImage(10_000 * 10_000);

    // 100 MP is ~31,900 tokens. Against an 8k context it cannot be sent, and
    // saying so here is what stops it being a reply that dies part-way.
    expect(() =>
      assemblePrompt(convo, {
        contextTokens: 8_192,
        maxOutputTokens: 2_048,
        attachments,
        modalities,
      })
    ).toThrowError(/too large/i);
  });
});
