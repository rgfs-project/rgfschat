import { render, screen } from '@testing-library/react';
import type { AttachmentTray } from './useAttachments.ts';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerProps } from './Composer.tsx';

/**
 * Composer keyboard and generation state.
 *
 * Enter/Shift+Enter is the single most exercised interaction in the app, and
 * the busy rules mirror the server's one-generation-per-conversation rule —
 * the UI must not let a user queue a request the server would reject with
 * `GENERATION_IN_PROGRESS`.
 */

const GROUPS = [
  {
    providerId: 'p1',
    providerName: 'Local',
    status: 'ready' as const,
    stale: false,
    models: [{ id: 'model-a', loaded: true, inputModalities: ['text'] }],
  },
];

function setup(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = {
    value: '',
    onChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    busy: false,
    disabled: false,
    groups: GROUPS,
    selection: { providerId: 'p1', modelId: 'model-a' },
    onSelectModel: vi.fn(),
    ...overrides,
  };

  const view = render(<Composer {...props} />);
  return {
    props,
    view,
    textarea: screen.getByLabelText<HTMLTextAreaElement>('Message'),
  };
}

/** jest-dom is not installed, so disabled state is read off the element. */
function sendButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' });
}

describe('Composer', () => {
  describe('keyboard', () => {
    it('sends on Enter', async () => {
      const user = userEvent.setup();
      const { props, textarea } = setup({ value: 'hello' });

      await user.click(textarea);
      await user.keyboard('{Enter}');

      expect(props.onSend).toHaveBeenCalledTimes(1);
    });

    it('does not send on Shift+Enter', async () => {
      const user = userEvent.setup();
      const { props, textarea } = setup({ value: 'hello' });

      await user.click(textarea);
      await user.keyboard('{Shift>}{Enter}{/Shift}');

      expect(props.onSend).not.toHaveBeenCalled();
    });

    it('lets Shift+Enter reach the field as a newline', async () => {
      const user = userEvent.setup();
      const { props, textarea } = setup({ value: 'hello' });

      await user.click(textarea);
      await user.keyboard('{Shift>}{Enter}{/Shift}');

      // Not preventDefault-ed, so the change handler still sees the newline.
      expect(props.onChange).toHaveBeenCalledWith('hello\n');
    });

    /**
     * While an IME candidate window is open, Enter confirms the candidate. If
     * that counted as send, typing in Japanese or Chinese would fire a message
     * on the first character committed.
     */
    it('does not send an Enter that is confirming an IME composition', () => {
      const { props, textarea } = setup({ value: 'にほん' });

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'isComposing', { value: true });
      textarea.dispatchEvent(event);

      expect(props.onSend).not.toHaveBeenCalled();
    });
  });

  describe('send button', () => {
    it('is disabled for an empty message', () => {
      setup({ value: '   ' });
      expect(sendButton().disabled).toBe(true);
    });

    it('is disabled when no model is selected', () => {
      setup({ value: 'hello', selection: null });
      expect(sendButton().disabled).toBe(true);
    });

    it('is enabled with text and a model', () => {
      setup({ value: 'hello' });
      expect(sendButton().disabled).toBe(false);
    });
  });

  describe('while a generation is running', () => {
    it('replaces send with stop', () => {
      setup({ value: '', busy: true });

      expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Stop generating' })).toBeTruthy();
    });

    it('calls onStop when stop is pressed', async () => {
      const user = userEvent.setup();
      const { props } = setup({ busy: true });

      await user.click(screen.getByRole('button', { name: 'Stop generating' }));

      expect(props.onStop).toHaveBeenCalledTimes(1);
      expect(props.onSend).not.toHaveBeenCalled();
    });

    it('disables the field', () => {
      const { textarea } = setup({ busy: true });
      expect(textarea.disabled).toBe(true);
    });
  });

  it('is unusable when the open conversation cannot be read', () => {
    const { textarea } = setup({ disabled: true });
    expect(textarea.disabled).toBe(true);
  });

  it('invites a message even before a model resolves', () => {
    const { textarea } = setup({ selection: null });
    expect(textarea.getAttribute('placeholder')).toBe('Message…');
  });

  it('names the target model in the placeholder', () => {
    const { textarea } = setup();
    expect(textarea.getAttribute('placeholder')).toBe('Message model-a');
  });
});

/**
 * A picture is a message.
 *
 * Send is enabled by "text *or* an attachment" — it always was, which is how a
 * reader came to click an enabled button that did nothing: everything behind it
 * required text. These pin the button's half of the rule to the same predicate
 * the route and the service now use.
 */
describe('sending an attachment with nothing typed', () => {
  const tray = (overrides: Partial<AttachmentTray> = {}): AttachmentTray => ({
    items: [],
    readyIds: [],
    busy: false,
    add: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    remaining: 10,
    ...overrides,
  });

  it('enables send for a ready attachment and no text', () => {
    setup({ value: '', attachments: tray({ readyIds: ['a-1'] }) });

    expect(sendButton().disabled).toBe(false);
  });

  it('enables send for whitespace and a ready attachment', () => {
    setup({ value: '   \n ', attachments: tray({ readyIds: ['a-1'] }) });

    expect(sendButton().disabled).toBe(false);
  });

  it('keeps send disabled while the upload is still going', () => {
    setup({
      value: '',
      attachments: tray({
        readyIds: [],
        busy: true,
        items: [
          { status: 'uploading', localId: 'l-1', filename: 'a.png', size: 10, progress: 0.5 },
        ],
      }),
    });

    expect(sendButton().disabled).toBe(true);
  });

  /* A failed upload contributes no id, so there is nothing to send. */
  it('keeps send disabled when the only attachment failed', () => {
    setup({
      value: '',
      attachments: tray({
        readyIds: [],
        items: [{ status: 'error', localId: 'l-1', filename: 'a.png', message: 'too big' }],
      }),
    });

    expect(sendButton().disabled).toBe(true);
  });

  it('keeps send disabled while a second upload is in flight, text or not', () => {
    setup({ value: 'what is this?', attachments: tray({ readyIds: ['a-1'], busy: true }) });

    expect(sendButton().disabled).toBe(true);
  });

  it('still refuses an empty message with nothing attached', () => {
    setup({ value: '  ', attachments: tray() });

    expect(sendButton().disabled).toBe(true);
  });
});

/**
 * How tall the field is.
 *
 * Measured from the text rather than counted in rows: a row count assumes a
 * line height the font may not have, and says nothing about a pasted
 * paragraph, a window that has just narrowed, or a webfont that arrived after
 * the first paint. jsdom lays nothing out, so `scrollHeight` — the one thing
 * the measurement reads — is supplied here, and what is asserted is what the
 * component does with it.
 */
describe('growing with what is typed', () => {
  const LINE = 28;
  let content = LINE;
  let observers: (() => void)[] = [];
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    content = LINE;
    observers = [];
    original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this instanceof HTMLTextAreaElement ? content : 0;
      },
    });

    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      }
    );
  });

  afterEach(() => {
    if (original !== undefined) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
    }
    vi.unstubAllGlobals();
  });

  const heightOf = (textarea: HTMLTextAreaElement): number =>
    Number.parseFloat(textarea.style.height);

  it('rests at one line when there is nothing in it', () => {
    const { textarea } = setup({ value: '' });

    expect(heightOf(textarea)).toBe(LINE);
    // Nothing to scroll, so nothing scrolls.
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('is the same height for a single line of text', () => {
    const { textarea } = setup({ value: 'hello' });

    expect(heightOf(textarea)).toBe(LINE);
  });

  it('grows as the text wraps onto more lines', () => {
    content = LINE * 3;
    const { textarea } = setup({ value: 'a\nb\nc' });

    expect(heightOf(textarea)).toBe(LINE * 3);
  });

  it('grows for pasted multiline text, not only for typing', () => {
    content = LINE * 6;
    const { textarea } = setup({ value: 'pasted\nover\nsix\nlines\nof\ntext' });

    expect(heightOf(textarea)).toBe(LINE * 6);
  });

  it('stops at its maximum and scrolls inside itself', () => {
    content = 900;
    const { textarea } = setup({ value: 'a very long draft' });

    expect(heightOf(textarea)).toBe(200);
    expect(textarea.style.overflowY).toBe('auto');
  });

  it('shrinks again when the text is deleted', () => {
    content = LINE * 4;
    const { view, props, textarea } = setup({ value: 'four\nlines\nof\ntext' });
    expect(heightOf(textarea)).toBe(LINE * 4);

    content = LINE;
    view.rerender(<Composer {...props} value="" />);

    expect(heightOf(textarea)).toBe(LINE);
    expect(textarea.style.overflowY).toBe('hidden');
  });

  /* Sending empties the field, which is the same path as deleting it all. */
  it('returns to its resting height after a send', async () => {
    const user = userEvent.setup();
    content = LINE * 5;
    const { view, props, textarea } = setup({ value: 'a draft\nover\nseveral\nlines\nhere' });

    await user.click(textarea);
    content = LINE;
    await user.keyboard('{Enter}');
    expect(props.onSend).toHaveBeenCalled();

    // The shell clears the draft when the send is accepted.
    view.rerender(<Composer {...props} value="" />);
    expect(heightOf(textarea)).toBe(LINE);
  });

  /*
   * A width change re-wraps the text without changing it: the window resizing,
   * the sidebar opening, an attachment chip appearing above the field, a phone
   * keyboard coming up. None of them touch `value`, so the observer is the only
   * thing that hears about them.
   */
  it('re-measures when its box changes size but its text does not', () => {
    const { textarea } = setup({ value: 'a line that will wrap when narrowed' });
    expect(heightOf(textarea)).toBe(LINE);

    content = LINE * 2;
    for (const notify of observers) notify();

    expect(heightOf(textarea)).toBe(LINE * 2);
  });

  it('keeps the attachment controls and send button in the same row as it grows', () => {
    content = LINE * 5;
    const { view } = setup({
      value: 'tall',
      attachments: {
        items: [],
        readyIds: [],
        busy: false,
        add: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn(),
        remaining: 10,
      },
    });

    const bar = view.container.querySelector('.composer__bar');
    expect(bar?.querySelector('[aria-label="Attach files"]')).not.toBeNull();
    expect(bar?.querySelector('[aria-label="Send message"]')).not.toBeNull();
  });
});
