import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  AssistantMessage,
  Message as MessageModel,
  MessageStatus,
  UserMessage,
} from '@shared/conversation.ts';
import { Message, StreamingMessage } from './Message.tsx';

/**
 * Message rendering: terminal statuses, reasoning, and the per-message actions.
 *
 * The statuses matter because they are the only signal that an answer is
 * *incomplete*. A cancelled or interrupted reply looks exactly like a short
 * one if the label is missing, and the user has no way to tell that the text
 * in front of them stops early.
 */

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    type: 'assistant',
    id: 'a1',
    body: 'The answer.',
    status: 'complete',
    ...overrides,
  };
}

function userMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return { type: 'user', id: 'u1', body: 'The question.', ...overrides };
}

function renderMessage(message: MessageModel, props: Partial<Parameters<typeof Message>[0]> = {}) {
  const handlers = {
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onRegenerate: vi.fn(),
  };
  const view = render(
    <Message message={message} isLast busy={false} canResend={false} {...handlers} {...props} />
  );
  return { ...handlers, view };
}

describe('Message', () => {
  describe('assistant status', () => {
    it.each<[MessageStatus, string]>([
      ['cancelled', 'Stopped'],
      ['failed', 'Failed'],
      ['timed_out', 'Timed out'],
      ['interrupted', 'Interrupted — the server restarted mid-reply'],
    ])('labels %s', (status, label) => {
      renderMessage(assistant({ status }));
      expect(screen.getByText(label)).toBeTruthy();
    });

    it('adds no label to a complete reply', () => {
      const { view } = renderMessage(assistant({ status: 'complete' }));
      expect(view.container.querySelector('.msg__status')).toBeNull();
    });

    it('says so when a failed generation produced nothing at all', () => {
      renderMessage(assistant({ body: '', status: 'failed' }));

      expect(screen.getByText('No output was produced.')).toBeTruthy();
      expect(screen.getByText('Failed')).toBeTruthy();
    });
  });

  describe('reasoning', () => {
    it('is collapsed by default', () => {
      const { view } = renderMessage(assistant({ reasoning: 'step one' }));
      const details = view.container.querySelector('details');

      expect(details).not.toBeNull();
      expect(details?.open).toBe(false);
    });

    it('is absent when the model returned none', () => {
      const { view } = renderMessage(assistant());
      expect(view.container.querySelector('details')).toBeNull();
    });
  });

  describe('actions', () => {
    it('offers edit on a user message but not regenerate', () => {
      renderMessage(userMessage());

      expect(screen.getByRole('button', { name: 'Edit message' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Regenerate response' })).toBeNull();
    });

    it('offers regenerate on the last assistant message only', () => {
      renderMessage(assistant(), { isLast: true });
      expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeTruthy();

      cleanupAndRender(assistant(), false);
      expect(screen.queryByRole('button', { name: 'Regenerate response' })).toBeNull();
    });

    it('shows when the message was sent, with the exact time to hand', () => {
      const time = new Date(Date.now() - 4 * 60_000).toISOString();
      renderMessage(userMessage({ time }));

      const stamp = screen.getByText('4 minutes ago');
      expect(stamp.getAttribute('datetime')).toBe(time);
      // The relative form is for the glance; the title answers the follow-up.
      expect(stamp.getAttribute('title')).toMatch(/\d{4}/);
    });

    it('shows no time for a message stored before times were recorded', () => {
      renderMessage(userMessage());

      expect(document.querySelector('.msg__time')).toBeNull();
    });

    it('hides the time along with the actions while a generation is running', () => {
      renderMessage(userMessage({ time: new Date().toISOString() }), { busy: true });

      expect(document.querySelector('.msg__time')).toBeNull();
    });

    it('hides every action while a generation is running', () => {
      renderMessage(userMessage(), { busy: true });

      expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
    });

    it('reports the edited body', async () => {
      const userEvt = userEvent.setup();
      const { onEdit } = renderMessage(userMessage());

      await userEvt.click(screen.getByRole('button', { name: 'Edit message' }));
      const editor = screen.getByRole('textbox');
      await userEvt.clear(editor);
      await userEvt.type(editor, 'A better question.');
      await userEvt.click(screen.getByRole('button', { name: 'Save' }));

      expect(onEdit).toHaveBeenCalledWith('u1', 'A better question.', false);
    });

    /**
     * The point of the feature: a rewritten question is asked again rather
     * than filed above an answer to the question it replaced.
     */
    it('sends the edit when it is the last question asked', async () => {
      const userEvt = userEvent.setup();
      const { onEdit } = renderMessage(userMessage(), { canResend: true });

      await userEvt.click(screen.getByRole('button', { name: 'Edit message' }));
      const editor = screen.getByRole('textbox');
      await userEvt.clear(editor);
      await userEvt.type(editor, 'A better question.');
      await userEvt.click(screen.getByRole('button', { name: 'Send' }));

      expect(onEdit).toHaveBeenCalledWith('u1', 'A better question.', true);
    });

    it('offers only to save an edit to an earlier question', async () => {
      const userEvt = userEvent.setup();
      renderMessage(userMessage(), { canResend: false });

      await userEvt.click(screen.getByRole('button', { name: 'Edit message' }));

      expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    });

    it('discards an edit on cancel', async () => {
      const userEvt = userEvent.setup();
      const { onEdit } = renderMessage(userMessage());

      await userEvt.click(screen.getByRole('button', { name: 'Edit message' }));
      await userEvt.type(screen.getByRole('textbox'), ' extra');
      await userEvt.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onEdit).not.toHaveBeenCalled();
      expect(screen.getByText('The question.')).toBeTruthy();
    });

    it('refuses to save an edit that empties the message', async () => {
      const userEvt = userEvent.setup();
      const { onEdit } = renderMessage(userMessage());

      await userEvt.click(screen.getByRole('button', { name: 'Edit message' }));
      await userEvt.clear(screen.getByRole('textbox'));
      await userEvt.click(screen.getByRole('button', { name: 'Save' }));

      expect(onEdit).not.toHaveBeenCalled();
    });
  });
});

/** Re-renders into a clean DOM so two states can be compared in one test. */
function cleanupAndRender(message: MessageModel, isLast: boolean): void {
  document.body.innerHTML = '';
  render(
    <Message
      message={message}
      isLast={isLast}
      busy={false}
      canResend={false}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onRegenerate={vi.fn()}
    />
  );
}

describe('StreamingMessage', () => {
  it('shows a waiting indicator before the first token', () => {
    render(<StreamingMessage content="" reasoning="" state="pending" />);
    expect(screen.getByLabelText('Assistant is pending')).toBeTruthy();
  });

  it('swaps the indicator for the text once tokens arrive', () => {
    const { container } = render(
      <StreamingMessage content="Partial answer" reasoning="" state="streaming" />
    );

    expect(container.querySelector('.thinking')).toBeNull();
    expect(screen.getByText('Partial answer')).toBeTruthy();
  });

  it('marks the live edge with a cursor while streaming', () => {
    const { container } = render(
      <StreamingMessage content="Partial" reasoning="" state="streaming" />
    );
    expect(container.querySelector('.cursor')).not.toBeNull();
  });

  /** Open while streaming: it is the only thing to look at before text starts. */
  it('expands reasoning while it is being produced', () => {
    const { container } = render(
      <StreamingMessage content="" reasoning="thinking out loud" state="streaming" />
    );
    expect(container.querySelector('details')?.open).toBe(true);
  });

  it('renders streamed markdown, not raw text', () => {
    const { container } = render(
      <StreamingMessage content="**bold**" reasoning="" state="streaming" />
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });
});
