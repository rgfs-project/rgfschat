import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A modal dialog, rendered through a portal.
 *
 * This replaces `window.confirm` and `window.prompt`. Those are never clipped,
 * so they satisfied the letter of the layout rule, but they are not overlays
 * this application controls: they cannot be styled, they block the event loop,
 * and under automation they have to be intercepted with a driver-level dialog
 * handler rather than driven like the rest of the UI.
 *
 * Portalled to `document.body` for the same reason the model menu is — it must
 * escape every ancestor's `overflow` and stacking context.
 */

export interface DialogProps {
  title: string;
  /** Explanatory text below the title. */
  body?: string;
  /**
   * When present the dialog prompts for text, seeded with this value, and
   * passes it to `onConfirm`. When absent it is a plain confirmation.
   */
  defaultValue?: string;
  /** Label for the field, when prompting. */
  fieldLabel?: string;
  confirmLabel: string;
  /** Marks an action that destroys data, so it reads differently. */
  destructive?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function Dialog({
  title,
  body,
  defaultValue,
  fieldLabel,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: DialogProps): React.JSX.Element {
  const isPrompt = defaultValue !== undefined;
  const [value, setValue] = useState(defaultValue ?? '');
  const titleId = useId();
  const cardRef = useRef<HTMLFormElement | null>(null);

  // Escape closes from anywhere, including while the field has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  /*
   * Focus moves into the dialog on open. Without this, focus stays on the
   * button that opened it — behind the backdrop — so Tab walks the page
   * underneath and a screen reader never announces that a dialog appeared.
   */
  useEffect(() => {
    const card = cardRef.current;
    if (card === null) return;

    const target =
      card.querySelector<HTMLElement>('input') ??
      card.querySelector<HTMLElement>('button[type="submit"]');
    target?.focus();
  }, []);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const trimmed = value.trim();
    // A prompt that has been emptied has nothing to apply.
    if (isPrompt && trimmed === '') return;
    onConfirm(trimmed);
  };

  return createPortal(
    <div
      className="modal"
      // A click that both starts and ends on the backdrop is a dismissal; one
      // that merely ends there (a drag out of the field) is not.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        ref={cardRef}
        className="modal__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
      >
        <h2 id={titleId}>{title}</h2>
        {body !== undefined && <p className="muted small">{body}</p>}

        {isPrompt && (
          <label className="field">
            <span>{fieldLabel ?? 'Name'}</span>
            <input value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
        )}

        <div className="modal__actions">
          <button type="button" className="linkish" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className={destructive ? 'button-destructive' : undefined}
            disabled={isPrompt && value.trim() === ''}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
