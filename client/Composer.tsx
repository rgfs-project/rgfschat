import { hasSendableContent } from '@shared/conversation';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Plus, Square } from 'lucide-react';
import type { ProviderModelGroup } from './api.ts';
import { AttachmentChips } from './AttachmentChips.tsx';
import { ModelPicker, type ModelSelection } from './ModelPicker.tsx';
import type { AttachmentTray } from './useAttachments.ts';

/**
 * The message composer.
 *
 * Enter sends and Shift+Enter inserts a newline. While a generation is running
 * in this conversation the field is disabled and the send button becomes stop,
 * which mirrors the server's one-generation-per-conversation rule rather than
 * letting the user queue a request that would be rejected with
 * `GENERATION_IN_PROGRESS`.
 */

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  groups: ProviderModelGroup[];
  selection: ModelSelection | null;
  onSelectModel: (selection: ModelSelection) => void;
  /** The files waiting to go with this message. Absent where none may be. */
  attachments?: AttachmentTray;
  /**
   * Whether the chosen model can read images.
   *
   * Only used to warn: the server refuses the request outright, and a client
   * that quietly declined to send would be hiding a decision it does not own.
   */
  modelHasVision?: boolean;
}

/**
 * How tall the field may grow before it scrolls itself.
 *
 * Past this the composer would be eating the transcript, which is the thing
 * being written *about*. Deliberately a pixel count rather than a row count:
 * rows assume a line height the font may not have, and the measurement below
 * is of the text that is actually there.
 */
const MAX_HEIGHT_PX = 200;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled,
  attachments,
  modelHasVision = true,
  groups,
  selection,
  onSelectModel,
}: ComposerProps): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  /**
   * Grows with its content up to a cap, after which the field scrolls.
   *
   * Measured rather than counted: the height is whatever the text actually
   * occupies, which is the only thing that is right for a pasted paragraph, a
   * font that loaded late, or a window the reader has just narrowed. Collapsing
   * to `auto` first is what lets it shrink again — `scrollHeight` of a box
   * already tall enough reports the box, not the text.
   */
  const measure = useCallback((): void => {
    const element = textarea.current;
    if (element === null) return;

    element.style.height = 'auto';
    const next = Math.min(element.scrollHeight, MAX_HEIGHT_PX);
    element.style.height = `${next}px`;
    // Only the capped field scrolls, so a field with room to grow cannot be
    // left with a scroll position of its own.
    element.style.overflowY = element.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, []);

  // In a layout effect so the height is right before the frame is painted: in
  // a passive one the reader sees one frame of the wrong size on every keystroke
  // that wraps a line.
  useLayoutEffect(measure, [measure, value]);

  /*
   * The same measurement for everything that changes the width rather than the
   * text: the window resizing, the sidebar opening, an attachment chip
   * appearing above the field, the keyboard coming up on a phone. All of them
   * re-wrap the text, and none of them change `value`.
   */
  useLayoutEffect(() => {
    const element = textarea.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  /*
   * And once more when the webfont arrives.
   *
   * The first measurement is taken in the fallback font, which is a different
   * size; without this the field keeps that height until the next keystroke.
   */
  useLayoutEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
    };
  }, [measure]);

  const placeholder = selection === null ? 'Message…' : `Message ${selection.modelId}`;

  const canAttach = attachments !== undefined && !disabled;
  const hasImage =
    attachments?.items.some(
      (item) => item.status === 'ready' && item.attachment.kind === 'image'
    ) ?? false;

  /** Files from a drop, a paste, or the file dialog all arrive here. */
  const accept = (list: FileList | null): void => {
    if (!canAttach || list === null || list.length === 0) return;
    attachments.add([...list]);
  };

  return (
    <form
      className={`composer${dragging ? ' is-dropping' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
      /*
       * Drag-and-drop on the whole composer rather than on a target inside it.
       * A small drop zone is a thing to aim at; the composer is already where
       * the reader is looking, and `dragover` must be cancelled or the browser
       * navigates to the file instead.
       */
      onDragOver={(event) => {
        if (!canAttach) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Only when the pointer leaves the form itself, not on every crossing
        // of a child's boundary — otherwise the highlight flickers.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        if (!canAttach) return;
        event.preventDefault();
        setDragging(false);
        accept(event.dataTransfer.files);
      }}
    >
      {attachments !== undefined && (
        <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
      )}

      {hasImage && !modelHasVision && (
        <p className="composer__warning" role="status">
          This model cannot read images. Choose one that can, or remove the image.
        </p>
      )}
      <textarea
        ref={textarea}
        className="composer__input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          // A composition (IME) Enter is confirming a candidate, not sending.
          if (event.nativeEvent.isComposing) return;

          event.preventDefault();
          onSend();
        }}
        onPaste={(event) => {
          // Only when the clipboard actually carries files. A normal text
          // paste must fall through to the textarea untouched.
          const files = [...event.clipboardData.files];
          if (!canAttach || files.length === 0) return;
          event.preventDefault();
          attachments.add(files);
        }}
        placeholder={placeholder}
        disabled={busy || disabled}
        rows={1}
        aria-label="Message"
      />

      <div className="composer__bar">
        {attachments !== undefined && (
          <>
            <input
              ref={filePicker}
              type="file"
              multiple
              className="visually-hidden"
              onChange={(event) => {
                accept(event.target.files);
                // Cleared so choosing the same file twice in a row still fires
                // a change event the second time.
                event.target.value = '';
              }}
              tabIndex={-1}
              aria-hidden="true"
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => filePicker.current?.click()}
              disabled={!canAttach || busy || attachments.remaining === 0}
              aria-label="Attach files"
              title={attachments.remaining === 0 ? 'Attachment limit reached' : 'Attach files'}
            >
              <Plus size={18} />
            </button>
          </>
        )}

        <ModelPicker groups={groups} value={selection} onChange={onSelectModel} disabled={busy} />

        {busy ? (
          <button
            type="button"
            className="composer__send composer__send--stop"
            onClick={onStop}
            aria-label="Stop generating"
            title="Stop"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            type="submit"
            className="composer__send"
            disabled={
              disabled ||
              selection === null ||
              // Something must be said or attached, and nothing may still be
              // uploading — sending mid-upload would send a message referring
              // to a file the server has not finished receiving.
              !hasSendableContent(value, attachments?.readyIds ?? []) ||
              (attachments?.busy ?? false)
            }
            aria-label="Send message"
            title="Send"
          >
            <ArrowUp size={16} />
          </button>
        )}
      </div>
    </form>
  );
}
