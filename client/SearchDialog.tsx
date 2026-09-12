import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, Search, X } from 'lucide-react';
import type { ConversationSummary } from './api.ts';
import { useSearch } from './queries.ts';

/**
 * Search, as a palette rather than a filter.
 *
 * The field in the sidebar only ever narrowed the list of titles, which is the
 * one thing a title already tells you. What people actually look for is
 * something they remember *saying*, so this searches message bodies on the
 * server and opens the conversation at the line that matched.
 *
 * Portalled and overlaid for the usual reason: it must escape the sidebar's
 * scroll container, and it is the only thing being used while it is open.
 */

/** Long enough to feel immediate, long enough to not search every keystroke. */
const DEBOUNCE_MS = 180;

export interface SearchDialogProps {
  /** Offered before anything is typed, so the palette opens useful. */
  recent: ConversationSummary[];
  onOpen: (conversationId: string, messageId?: string) => void;
  onClose: () => void;
}

/** One row of the list, flattened so the keyboard can walk it as one sequence. */
interface Row {
  key: string;
  conversationId: string;
  messageId?: string;
  title: string;
  snippet?: string;
  from?: string;
}

export function SearchDialog({ recent, onOpen, onClose }: SearchDialogProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);

  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const search = useSearch(debounced);
  const searching = debounced !== '';

  const rows = useMemo<Row[]>(() => {
    if (!searching) {
      return recent.slice(0, 8).map((conversation) => ({
        key: conversation.id,
        conversationId: conversation.id,
        title: conversation.title,
      }));
    }

    return (search.data ?? []).flatMap((result) => {
      // The conversation itself, when its title is what matched: opening it at
      // the top is the right answer, and there may be no message hit at all.
      const head: Row[] = result.titleMatch
        ? [{ key: result.id, conversationId: result.id, title: result.title }]
        : [];

      return [
        ...head,
        ...result.hits.map((hit) => ({
          key: `${result.id}:${hit.messageId}`,
          conversationId: result.id,
          messageId: hit.messageId,
          title: result.title,
          snippet: hit.snippet,
          from: hit.type === 'user' ? 'You' : 'Reply',
        })),
      ];
    });
  }, [searching, recent, search.data]);

  // A new result set invalidates wherever the cursor was sitting.
  useEffect(() => setActive(0), [rows.length, debounced]);

  const choose = (row: Row): void => {
    onOpen(row.conversationId, row.messageId);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, rows.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[active];
      if (row !== undefined) choose(row);
    }
  };

  // Keeps the keyboard cursor in view when it walks past the visible rows.
  useEffect(() => {
    listRef.current?.querySelector('.palette__row.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return createPortal(
    <div className="modal" role="presentation" onPointerDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search conversations"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette__field">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations and messages"
            aria-label="Search conversations and messages"
            autoFocus
          />
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close search">
            <X size={18} />
          </button>
        </div>

        <div className="palette__list" ref={listRef}>
          <p className="palette__label">{searching ? 'Results' : 'Recent'}</p>

          {searching && search.isPending && <p className="palette__empty muted">Searching…</p>}
          {searching && search.isError && (
            <p className="palette__empty muted">The search could not be run.</p>
          )}
          {!search.isPending && !search.isError && rows.length === 0 && (
            <p className="palette__empty muted">
              {searching ? 'Nothing matched.' : 'No conversations yet.'}
            </p>
          )}

          {rows.map((row, index) => (
            <button
              key={row.key}
              type="button"
              className={`palette__row${index === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(row)}
            >
              <MessageSquare size={16} className="palette__icon" />
              <span className="palette__text">
                <span className="palette__title">{row.title}</span>
                {row.snippet !== undefined && (
                  <span className="palette__snippet">
                    <span className="palette__from">{row.from}</span>
                    {row.snippet}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
