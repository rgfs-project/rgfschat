import { useState } from 'react';
import { Check, ChevronRight, Copy, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { Message as MessageModel, MessageStatus } from '@shared/conversation.ts';
import { Markdown } from './Markdown.tsx';
import { failureMessage } from './failureMessage.ts';
import { useCopy } from './useCopy.ts';
import { exactTime, relativeTime } from './relativeTime.ts';
import { MessageAttachments } from './MessageAttachments.tsx';

/**
 * One turn in the transcript.
 *
 * User messages are right-aligned bubbles; assistant messages run full width
 * with no container, so a long answer reads as a document rather than as a
 * speech bubble.
 */

/** Only non-successful outcomes are worth surfacing; `complete` is the norm. */
const STATUS_LABEL: Partial<Record<MessageStatus, string>> = {
  cancelled: 'Stopped',
  failed: 'Failed',
  timed_out: 'Timed out',
  interrupted: 'Interrupted — the server restarted mid-reply',
};

export interface MessageProps {
  message: MessageModel;
  isLast: boolean;
  busy: boolean;
  /**
   * Whether editing this message can re-ask it.
   *
   * Only the last question can: asking it again means replacing the answer
   * below it, and for an earlier turn everything after would have to go with
   * it. So an earlier message is saved and left alone.
   */
  canResend: boolean;
  /** Arrived at from search: marked briefly so the eye can find it. */
  highlighted?: boolean;
  onEdit: (messageId: string, body: string, resend: boolean) => void;
  onDelete: (messageId: string) => void;
  onRegenerate: () => void;
}

export function Message({
  message,
  isLast,
  busy,
  canResend,
  highlighted = false,
  onEdit,
  onDelete,
  onRegenerate,
}: MessageProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const { copied, copy } = useCopy();

  /*
   * Computed as the row renders rather than kept ticking on a timer.
   *
   * A timer would have to re-render every message in the transcript once a
   * minute to keep "4 minutes ago" honest, and the row it would be correcting
   * is only on screen while the pointer is on the message — by which time any
   * of the things a reader does (send, scroll into a new query, switch chats)
   * has re-rendered it anyway. The `title` carries the exact time for when the
   * relative one is not precise enough to settle a question.
   */
  const sentAt = message.type === 'system' ? undefined : message.time;
  const sentLabel = relativeTime(sentAt);

  const status = message.type === 'assistant' ? message.status : undefined;
  const statusLabel = status === undefined ? undefined : STATUS_LABEL[status];
  /*
   * The outcome, and under it what went wrong.
   *
   * The label alone says a reply did not finish; the reason says whether that
   * is worth retrying. A reply stored before the reason was recorded, or one
   * whose failure the server could not classify, keeps the label on its own
   * rather than gaining a sentence that explains nothing.
   */
  const reason =
    message.type === 'assistant' && message.error !== undefined
      ? failureMessage(message.error)
      : undefined;
  const reasoning = message.type === 'assistant' ? message.reasoning : undefined;

  const save = (): void => {
    const next = draft.trim();
    if (next === '') return;
    onEdit(message.id, next, canResend);
    setEditing(false);
  };

  if (editing) {
    return (
      <article className={`msg msg--${message.type} msg--editing`} data-message-id={message.id}>
        <textarea
          className="msg__editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false);
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
          }}
          rows={4}
          autoFocus
        />
        {/* Named rather than iconned: these two decide what happens to the
            message, and a tick and a cross beside a half-written edit do not
            say which. Cancel leads, as it does in the dialogs. */}
        <div className="msg__edit-actions">
          <button type="button" className="linkish" onClick={() => setEditing(false)}>
            Cancel
          </button>
          {/* Changing a question and leaving the old answer under it is rarely
              what was meant, so on the last turn the edit is sent rather than
              filed. */}
          <button type="button" className="button-primary" onClick={save}>
            {canResend ? 'Send' : 'Save'}
          </button>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`msg msg--${message.type}${highlighted ? ' is-found' : ''}`}
      data-message-id={message.id}
      data-status={status}
    >
      {reasoning !== undefined && reasoning !== '' && (
        // Collapsed by default: it is working-out, not the answer.
        <details className="reasoning">
          <summary>
            <ChevronRight size={14} className="reasoning__chevron" />
            Reasoning
          </summary>
          <div className="reasoning__body">{reasoning}</div>
        </details>
      )}

      <div className="msg__body">
        {message.body === '' && statusLabel !== undefined ? (
          <p className="muted msg__empty">No output was produced.</p>
        ) : (
          <Markdown>{message.body}</Markdown>
        )}
      </div>

      {message.type === 'user' && <MessageAttachments ids={message.attachments ?? []} />}

      {statusLabel !== undefined && (
        <p className="msg__status">
          {statusLabel}
          {reason !== undefined && <span className="msg__reason">{reason}</span>}
        </p>
      )}

      {!busy && (
        <div className="msg__actions">
          {/* Leads the row: it says something about the message, where the rest
              of the row acts on it, and a reader following the column of times
              down a conversation should not have to find them at a different
              offset under every message. */}
          {sentAt !== undefined && sentLabel !== undefined && (
            <time className="msg__time" dateTime={sentAt} title={exactTime(sentAt)}>
              {sentLabel}
            </time>
          )}

          {message.type === 'user' && (
            <button
              type="button"
              className="icon-button"
              aria-label="Edit message"
              title="Edit"
              onClick={() => {
                setDraft(message.body);
                setEditing(true);
              }}
            >
              <Pencil size={16} />
            </button>
          )}
          {message.type === 'assistant' && isLast && (
            <button
              type="button"
              className="icon-button"
              aria-label="Regenerate response"
              title="Regenerate"
              onClick={onRegenerate}
            >
              <RefreshCw size={16} />
            </button>
          )}

          {/* On both sides: wanting a copy of what you asked is as ordinary as
              wanting a copy of the answer. It sits second on both, so the one
              control that differs between a question and an answer is the one
              in the position that differs — and copy and delete stay where the
              hand left them when the eye moves down the transcript. */}
          <button
            type="button"
            className="icon-button"
            aria-label={copied ? 'Copied' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy'}
            onClick={() => copy(message.body)}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Delete message"
            title="Delete this message and its reply"
            onClick={() => onDelete(message.id)}
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </article>
  );
}

/** The assistant turn currently streaming, before it becomes a stored message. */
export function StreamingMessage({
  content,
  reasoning,
  state,
}: {
  content: string;
  reasoning: string;
  state: string;
}): React.JSX.Element {
  return (
    <article className="msg msg--assistant msg--streaming">
      {reasoning !== '' && (
        <details className="reasoning" open>
          <summary>
            <ChevronRight size={14} className="reasoning__chevron" />
            Reasoning
          </summary>
          <div className="reasoning__body">{reasoning}</div>
        </details>
      )}

      <div className="msg__body">
        {content === '' ? (
          // Nothing has arrived yet; a spinner would imply more than we know.
          <span className="thinking" aria-label={`Assistant is ${state}`}>
            <span />
            <span />
            <span />
          </span>
        ) : (
          <>
            <Markdown>{content}</Markdown>
            <span className="cursor" aria-hidden="true" />
          </>
        )}
      </div>
    </article>
  );
}
