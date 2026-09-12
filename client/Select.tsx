import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

/**
 * A dropdown that the application actually controls.
 *
 * A native `<select>` renders its option list with the platform's own widget.
 * On this build of Chrome that widget ignores `color-scheme` entirely — the
 * root, the element and its computed style all said `dark`, and the popup still
 * came up white with a blue highlight over a black dialog. Nothing in CSS
 * reaches it, so the list has to be ours.
 *
 * Portalled to `document.body` for the same reason the model menu is: it must
 * escape the overflow and stacking context of the scrolling pane it opens in.
 */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Required: these sit in rows where the visible text is the row's label. */
  label: string;
  disabled?: boolean;
}

/** Room the list keeps between itself and the window's edge. */
const EDGE_MARGIN_PX = 8;

export function Select({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: SelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(
    null
  );
  /** Which option the keyboard is on, independent of what is selected. */
  const [active, setActive] = useState(0);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((option) => option.value === value) ?? null;

  const reposition = useCallback((): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;

    const rect = trigger.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();

    /*
     * Clamped to the window, like the popup menu is. The list is at least as
     * wide as its trigger and often wider — an option can be a whole sentence
     * — so a trigger near the right-hand edge of a panel put the end of every
     * label past the edge of the screen.
     */
    const width = menu === undefined ? rect.width : Math.max(rect.width, menu.width);
    const left = Math.max(
      EDGE_MARGIN_PX,
      Math.min(rect.left, window.innerWidth - width - EDGE_MARGIN_PX)
    );

    setPosition({ left, top: rect.bottom + 4, width: rect.width });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value)
      )
    );
  }, [open, reposition, options, value]);

  // The trigger moves when anything under it scrolls, and fixed coordinates
  // have to follow or the menu detaches from its control.
  useEffect(() => {
    if (!open) return;

    const update = (): void => reposition();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = (next: string): void => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  /** Arrow keys move, Enter commits, Escape abandons — as a native list does. */
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, options.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[active];
      if (option !== undefined) choose(option.value);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="select"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
      >
        <span className="select__value">{selected?.label ?? ''}</span>
        <ChevronDown size={15} className="select__chevron" />
      </button>

      {open &&
        position !== null &&
        createPortal(
          <div
            ref={menuRef}
            className="select__menu"
            role="listbox"
            aria-label={label}
            style={{ left: position.left, top: position.top, minWidth: position.width }}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`select__option${index === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option.value)}
              >
                <span className="select__option-label">{option.label}</span>
                {option.value === value && <Check size={15} />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
