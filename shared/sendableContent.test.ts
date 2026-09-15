import { describe, expect, it } from 'vitest';
import { hasSendableContent } from './conversation.ts';

/**
 * The one rule, in one place.
 *
 * Three things ask this question — the Send button, the request schema, and the
 * method that writes the message — and they used to answer it differently: the
 * button said "text or an attachment" while both of the others required text.
 * The gap between those two answers was a button that did nothing when clicked.
 */
describe('hasSendableContent', () => {
  it('accepts text on its own', () => {
    expect(hasSendableContent('hello', [])).toBe(true);
  });

  it('accepts an attachment on its own', () => {
    expect(hasSendableContent('', ['a-1'])).toBe(true);
  });

  it('accepts several attachments on their own', () => {
    expect(hasSendableContent('', ['a-1', 'a-2'])).toBe(true);
  });

  it('accepts text with an attachment', () => {
    expect(hasSendableContent('what is this?', ['a-1'])).toBe(true);
  });

  /* Whitespace is not text: a space bar pressed by accident is not a message. */
  it.each(['', ' ', '\n\n', '\t \r\n'])('refuses %j with nothing attached', (content) => {
    expect(hasSendableContent(content, [])).toBe(false);
  });

  it('accepts whitespace alongside an attachment', () => {
    expect(hasSendableContent('   ', ['a-1'])).toBe(true);
  });
});
