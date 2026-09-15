import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronUp, Search } from 'lucide-react';
import type { ProviderModelGroup } from './api.ts';

/**
 * Model selector.
 *
 * Rendered through a portal to `document.body` and positioned with fixed
 * coordinates. The composer is a rounded, overflow-clipped box near the bottom
 * of the viewport, so a menu rendered inside it would be cut off at its edge —
 * portalling puts the menu outside every ancestor's overflow and stacking
 * context, which is the only reliable fix.
 */

/** The resting width of `.model-menu`, and the gap it keeps from every edge. */
const MENU_WIDTH = 356;
const MARGIN = 8;

/**
 * A real phone, not a narrow window — the same test the stylesheets make, for
 * the same reason: a desktop window dragged narrow keeps the desktop layout.
 */
const phoneQuery = (): MediaQueryList =>
  window.matchMedia('(max-width: 767px) and (hover: none) and (pointer: coarse)');

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export interface ModelPickerProps {
  groups: ProviderModelGroup[];
  value: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  disabled?: boolean;
}

interface Option extends ModelSelection {
  label: string;
  providerName: string;
  modalities: string[];
  loaded: boolean;
  stale: boolean;
  unavailable: boolean;
}

function flatten(groups: ProviderModelGroup[]): Option[] {
  return groups.flatMap((group) =>
    group.models.map((model) => ({
      providerId: group.providerId,
      modelId: model.id,
      label: model.id,
      providerName: group.providerName,
      // Only the modalities beyond text are worth showing; everything takes text.
      modalities: model.inputModalities.filter((m) => m !== 'text'),
      loaded: model.loaded,
      stale: group.stale,
      unavailable: group.status === 'unavailable',
    }))
  );
}

export function ModelPicker({
  groups,
  value,
  onChange,
  disabled = false,
}: ModelPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<{ left: number; bottom: number; width: number } | null>(
    null
  );

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const options = useMemo(() => flatten(groups), [groups]);
  const selected = useMemo(
    () =>
      options.find(
        (option) => option.providerId === value?.providerId && option.modelId === value?.modelId
      ) ?? null,
    [options, value]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        option.providerName.toLowerCase().includes(needle)
    );
  }, [options, query]);

  /**
   * Anchors the menu above the control it belongs to, in viewport coordinates.
   *
   * On a phone that control is the composer rather than the trigger inside it:
   * anchored to the trigger, a 356px menu opening from a control two thirds of
   * the way along a 375px screen ran off the right-hand edge, and what was left
   * on screen was a panel with two of its corners missing. Spanning the
   * composer gives it the width it has to fit in and puts its edges on the
   * edges of the box it opens from — one card above another rather than a panel
   * at an angle to everything under it.
   */
  const reposition = useCallback((): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;

    const viewport = window.innerWidth;
    const anchor = (phoneQuery().matches ? trigger.closest('.composer') : null) ?? trigger;
    const rect = anchor.getBoundingClientRect();

    const width = anchor === trigger ? Math.min(MENU_WIDTH, viewport - MARGIN * 2) : rect.width;
    // Clamped either way: the anchored case can still be pushed off the right
    // by a narrow window, which is what left the corners cut off.
    const left = Math.min(Math.max(rect.left, MARGIN), viewport - width - MARGIN);

    setPosition({ left, bottom: window.innerHeight - rect.top + MARGIN, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  // Scrolling or resizing moves the trigger, so fixed coordinates must follow.
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
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = (option: Option): void => {
    onChange({ providerId: option.providerId, modelId: option.modelId });
    setOpen(false);
    setQuery('');
  };

  /** Providers are only named when there is more than one to distinguish. */
  const showProviderNames = groups.length > 1;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="model-trigger"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{selected?.label ?? 'Select a model'}</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open &&
        position !== null &&
        createPortal(
          <div
            ref={menuRef}
            className="model-menu"
            role="listbox"
            aria-label="Models"
            style={{ left: position.left, bottom: position.bottom, width: position.width }}
          >
            <div className="model-menu__search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search a model"
                aria-label="Search a model"
                autoFocus
              />
            </div>

            <div className="model-menu__list">
              {filtered.length === 0 && (
                <p className="model-menu__empty muted">
                  {options.length === 0 ? 'No models configured yet.' : 'No models match that.'}
                </p>
              )}

              {filtered.map((option) => {
                const isSelected =
                  option.providerId === value?.providerId && option.modelId === value?.modelId;

                return (
                  <button
                    key={`${option.providerId}/${option.modelId}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className="model-option"
                    onClick={() => choose(option)}
                  >
                    <span className="model-option__name">{option.label}</span>

                    {option.modalities.length > 0 && (
                      <span className="model-option__tags">{option.modalities.join(' · ')}</span>
                    )}
                    {showProviderNames && (
                      <span className="model-option__provider">{option.providerName}</span>
                    )}
                    {option.unavailable && <span className="model-option__tags">unavailable</span>}
                    {!option.unavailable && option.stale && (
                      <span className="model-option__tags">stale</span>
                    )}

                    {isSelected && <Check size={16} className="model-option__check" />}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
