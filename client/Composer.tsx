import { useEffect, useRef } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import type { ProviderModelGroup } from './api.ts';
import { ModelPicker, type ModelSelection } from './ModelPicker.tsx';

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
}

const MAX_ROWS_HEIGHT_PX = 200;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled,
  groups,
  selection,
  onSelectModel,
}: ComposerProps): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  // Grows with its content up to a cap, after which the field scrolls rather
  // than pushing the transcript out of the way.
  useEffect(() => {
    const element = textarea.current;
    if (element === null) return;

    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_ROWS_HEIGHT_PX)}px`;
  }, [value]);

  const placeholder = selection === null ? 'Message…' : `Message ${selection.modelId}`;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
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
        placeholder={placeholder}
        disabled={busy || disabled}
        rows={1}
        aria-label="Message"
      />

      <div className="composer__bar">
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
            disabled={disabled || value.trim() === '' || selection === null}
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
