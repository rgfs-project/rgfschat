import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Copy, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { Message as MessageModel, MessageStatus } from '@shared/conversation.ts';
import { artifactId, extractCodeBlocks } from '@shared/artifact.ts';
import { ArtifactOpenContext, type OpenArtifact } from './artifactContext.ts';
import { Markdown } from './Markdown.tsx';
import { MessageAttachments } from './MessageAttachments.tsx';
import { formatRelativeTime } from './relativeTime.ts';

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
  /** Opens one of this message's code blocks in the artifact panel. */
  onOpenArtifact?: (artifactId: string) => void;
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
  onOpenArtifact,
}: MessageProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [copied, setCopied] = useState(false);

  /*
   * Resolves a rendered block back to its address within this message.
   *
   * The renderer knows the text of the block it drew but not its position, and
   * this is the only place that has both: the body it was drawn from, and the
   * id of the message it belongs to.
   */
  const openArtifact = useMemo<OpenArtifact>(() => {
    if (onOpenArtifact === undefined) return null;
    return (code: string) => {
      const block = extractCodeBlocks(message.body).find((candidate) => candidate.code === code);
      if (block === undefined) return;
      onOpenArtifact(artifactId(message.id, block.ordinal));
    };
  }, [onOpenArtifact, message.body, message.id]);

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
  const createdAt = message.type === 'system' ? undefined : message.createdAt;

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

      {/* The bubble is the user's turn alone: what they said and what they
          carried with it. The controls below sit outside it, on the page. */}
      {message.type === 'user' ? (
        <div className="msg__bubble">
          <MessageAttachments ids={message.attachments ?? []} />
          <div className="msg__body">
            <ArtifactOpenContext.Provider value={openArtifact}>
              <Markdown>{message.body}</Markdown>
            </ArtifactOpenContext.Provider>
          </div>
        </div>
      ) : (
        <div className="msg__body">
          {message.body === '' && statusLabel !== undefined ? (
            <p className="muted msg__empty">No output was produced.</p>
          ) : (
            <ArtifactOpenContext.Provider value={openArtifact}>
              <Markdown>{message.body}</Markdown>
            </ArtifactOpenContext.Provider>
          )}
        </div>
      )}

      {statusLabel !== undefined && <p className="msg__status">{statusLabel}</p>}

      {!busy && (
        <div className="msg__actions">
          {/* Absent on a message from before this existed (formatVersion 1)
              rather than showing a fabricated or misleading time. */}
          {createdAt !== undefined && (
            <span className="msg__time">{formatRelativeTime(createdAt)}</span>
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
              <Pencil size={15} />
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
              <RefreshCw size={15} />
            </button>
          )}

          {/* On both sides: wanting a copy of what you asked is as ordinary as
              wanting a copy of the answer. */}
          <button
            type="button"
            className="icon-button"
            aria-label={copied ? 'Copied' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy'}
            onClick={copy}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>

          <button
            type="button"
            className="icon-button"
            aria-label="Delete message"
            title="Delete this message and its reply"
            onClick={() => onDelete(message.id)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      )}
    </article>
  );
}

/** How close to the bottom of the reasoning box still counts as following it. */
const REASONING_PIN_PX = 32;

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
  const reasoningRef = useRef<HTMLDivElement | null>(null);

  /*
   * The thinking scrolls itself.
   *
   * The box is a fixed height with its own scrollbar, so without this the
   * working-out piles up below the fold and the visible part is whatever the
   * model thought first — the least interesting end of it. The transcript
   * itself deliberately holds still during a reply, which makes this the only
   * thing that moves.
   *
   * Only while it is already at the bottom: scrolling up to reread a step is a
   * thing to do while the rest is still arriving, and being yanked back down on
   * the next token would make it impossible.
   */
  useLayoutEffect(() => {
    const box = reasoningRef.current;
    if (box === null) return;

    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (distance > REASONING_PIN_PX) return;

    box.scrollTop = box.scrollHeight;
  }, [reasoning]);

  return (
    <article className="msg msg--assistant msg--streaming">
      {reasoning !== '' && (
        <details className="reasoning">
          <summary>
            <ChevronRight size={14} className="reasoning__chevron" />
            Reasoning
          </summary>
          <div className="reasoning__body" ref={reasoningRef}>
            {reasoning}
          </div>
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
