import { useState } from 'react';
import { Check, ChevronRight, Copy, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { Message as MessageModel, MessageStatus } from '@shared/conversation.ts';
import { Markdown } from './Markdown.tsx';

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
  const [copied, setCopied] = useState(false);

  /** Copies the message as it was written, not as it was rendered. */
  const copy = (): void => {
    void navigator.clipboard
      .writeText(message.body)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  const status = message.type === 'assistant' ? message.status : undefined;
  const statusLabel = status === undefined ? undefined : STATUS_LABEL[status];
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

      {statusLabel !== undefined && <p className="msg__status">{statusLabel}</p>}

      {!busy && (
        <div className="msg__actions">
          {/* On both sides: wanting a copy of what you asked is as ordinary as
              wanting a copy of the answer. */}
          <button
            type="button"
            className="icon-button"
            aria-label={copied ? 'Copied' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy'}
            onClick={copy}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>

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
              <Pencil size={14} />
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
              <RefreshCw size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Delete message"
            title="Delete this message and its reply"
            onClick={() => onDelete(message.id)}
          >
            <Trash2 size={14} />
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
