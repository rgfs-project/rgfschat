import { useState } from 'react';
import { ChevronRight, Pencil, RefreshCw, Trash2, Check, X } from 'lucide-react';
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
  onEdit: (messageId: string, body: string) => void;
  onDelete: (messageId: string) => void;
  onRegenerate: () => void;
}

export function Message({
  message,
  isLast,
  busy,
  onEdit,
  onDelete,
  onRegenerate,
}: MessageProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);

  const status = message.type === 'assistant' ? message.status : undefined;
  const statusLabel = status === undefined ? undefined : STATUS_LABEL[status];
  const reasoning = message.type === 'assistant' ? message.reasoning : undefined;

  const save = (): void => {
    const next = draft.trim();
    if (next === '') return;
    onEdit(message.id, next);
    setEditing(false);
  };

  if (editing) {
    return (
      <article className={`msg msg--${message.type} msg--editing`}>
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
        <div className="msg__edit-actions">
          <button type="button" className="icon-button" onClick={save} aria-label="Save edit">
            <Check size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setEditing(false)}
            aria-label="Cancel edit"
          >
            <X size={16} />
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className={`msg msg--${message.type}`} data-status={status}>
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
