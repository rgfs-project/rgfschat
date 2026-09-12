import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A popup menu anchored to whatever opened it.
 *
 * Portalled to `document.body`, for the reason every overlay here is: the
 * sidebar is a scroll container with its own stacking context, and a menu laid
 * out inside it is clipped by the row it belongs to.
 *
 * It places itself against the trigger's box and flips when there is no room —
 * the account row sits at the bottom of the window, so its menu opens upwards,
 * while a conversation's menu opens down unless it is near the foot of the
 * list. The caller says which edge to prefer; the menu decides what fits.
 */

export interface MenuItem {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  /** Separated from what comes before it, and read as a warning. */
  destructive?: boolean;
  /** Separated from what comes before it, without the warning. */
  separated?: boolean;
}

export interface MenuProps {
  anchor: HTMLElement;
  items: MenuItem[];
  /** Which way to open when there is room for either. */
  prefer?: 'down' | 'up';
  /** Which edge of the anchor the menu lines up with. */
  align?: 'start' | 'end';
  /**
   * Takes the anchor's width instead of its own.
   *
   * For a menu whose trigger is a full-width row: sized to its contents it
   * stops short of the row it belongs to, which reads as a second, narrower
   * thing rather than as that row opening.
   */
  matchWidth?: boolean;
  label: string;
  onClose: () => void;
}

/** Room the menu needs below the anchor before it gives up and opens upwards. */
const FLIP_MARGIN_PX = 8;

export function Menu({
  anchor,
  items,
  prefer = 'down',
  align = 'start',
  matchWidth = false,
  label,
  onClose,
}: MenuProps): React.JSX.Element {
  const [position, setPosition] = useState<{ left: number; top: number; width?: number } | null>(
    null
  );
  const [active, setActive] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const place = useCallback((): void => {
    const menu = menuRef.current;
    if (menu === null) return;

    const trigger = anchor.getBoundingClientRect();
    const box = menu.getBoundingClientRect();

    const below = window.innerHeight - trigger.bottom;
    const openDown =
      prefer === 'down'
        ? below >= box.height + FLIP_MARGIN_PX || trigger.top < box.height
        : trigger.top < box.height + FLIP_MARGIN_PX;

    const top = openDown ? trigger.bottom + 4 : trigger.top - box.height - 4;
    const left = align === 'start' ? trigger.left : trigger.right - box.width;

    // Never off the edge, whatever the anchor is doing.
    setPosition({
      top: Math.max(
        FLIP_MARGIN_PX,
        Math.min(top, window.innerHeight - box.height - FLIP_MARGIN_PX)
      ),
      left: Math.max(
        FLIP_MARGIN_PX,
        Math.min(left, window.innerWidth - box.width - FLIP_MARGIN_PX)
      ),
      ...(matchWidth ? { width: trigger.width } : {}),
    });
  }, [anchor, prefer, align, matchWidth]);

  // Measured after the first paint, because where it goes depends on how big it
  // turned out to be.
  useLayoutEffect(place, [place]);

  useEffect(() => {
    const update = (): void => place();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [place]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (anchor.contains(target)) return;
      onClose();
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [anchor, onClose]);

  useEffect(() => {
    menuRef.current?.querySelector('button')?.focus();
  }, []);

  const choose = (item: MenuItem): void => {
    // Closed first: several of these open a dialog, and two overlays arriving
    // together leaves the menu floating over the thing it just opened.
    onClose();
    item.onSelect();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      anchor.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, items.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const item = items[active];
      if (item !== undefined) choose(item);
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="menu"
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={
        position === null
          ? // Laid out off-screen for the first paint so it can be measured
            // without being seen in the wrong place.
            { visibility: 'hidden', top: 0, left: 0 }
          : {
              top: position.top,
              left: position.left,
              ...(position.width === undefined ? {} : { width: position.width }),
            }
      }
    >
      {items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`menu__item${item.destructive === true ? ' is-destructive' : ''}${
            item.separated === true ? ' is-separated' : ''
          }${index === active ? ' is-active' : ''}`}
          onMouseEnter={() => setActive(index)}
          onClick={() => choose(item)}
        >
          <span className="menu__icon">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
