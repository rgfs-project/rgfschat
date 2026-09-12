import { useMemo, useState } from 'react';
import {
  KeyRound,
  LogOut,
  Moon,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Shield,
  Sun,
  Trash2,
} from 'lucide-react';
import type { UserDto } from '@shared/auth.ts';
import type { ConversationSummary } from './api.ts';

/**
 * Conversation navigation.
 *
 * The top bar, the new-chat action, the search field, and the account row are
 * all fixed; only the list between them scrolls. That split is what keeps the
 * account controls reachable in a long list.
 */

export interface SidebarProps {
  conversations: ConversationSummary[];
  /** The list has not arrived yet — distinct from having arrived empty. */
  loading?: boolean;
  currentId: string | null;
  user: UserDto;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onCollapse: () => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, currentTitle: string) => void;
  onDelete: (id: string) => void;
  onChangePassword: () => void;
  onOpenAdmin: () => void;
  onSignOut: () => void;
}

/** Groups by recency the way a reader thinks about it, not by exact date. */
function bucketOf(updatedAt: string, now: number): string {
  const age = now - Date.parse(updatedAt);
  if (Number.isNaN(age)) return 'Earlier';

  const day = 24 * 60 * 60 * 1000;
  if (age < day) return 'Today';
  if (age < 7 * day) return 'This week';
  if (age < 30 * day) return 'This month';
  return 'Earlier';
}

const BUCKET_ORDER = ['Today', 'This week', 'This month', 'Earlier'];

export function Sidebar({
  conversations,
  loading = false,
  currentId,
  user,
  theme,
  onToggleTheme,
  onCollapse,
  onCreate,
  onOpen,
  onRename,
  onDelete,
  onChangePassword,
  onOpenAdmin,
  onSignOut,
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching =
      needle === ''
        ? conversations
        : conversations.filter((c) => c.title.toLowerCase().includes(needle));

    const now = Date.now();
    const buckets = new Map<string, ConversationSummary[]>();
    for (const conversation of matching) {
      const bucket = bucketOf(conversation.updatedAt, now);
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), conversation]);
    }

    return BUCKET_ORDER.filter((name) => buckets.has(name)).map((name) => ({
      name,
      items: buckets.get(name) ?? [],
    }));
  }, [conversations, query]);

  return (
    <aside className="sidebar">
      {/*
        Wordmark and collapse control. The bar is the same height as the main
        header so the two dividers line up across the seam and read as one rule.
      */}
      <div className="sidebar__brand">
        <h1 className="brand">ChatUI</h1>
        <button
          type="button"
          className="icon-button"
          onClick={onCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          <PanelLeft size={18} />
        </button>
      </div>

      <div className="sidebar__actions">
        <button type="button" className="nav-button" onClick={onCreate}>
          <Plus size={18} />
          New chat
        </button>

        {/* Shown only to admins as a convenience; `requireAdmin` on the server
            is what actually protects these routes (INV-24). */}
        {user.role === 'admin' && (
          <button type="button" className="nav-button" onClick={onOpenAdmin}>
            <Shield size={18} />
            Admin
          </button>
        )}

        <label className="search">
          {/* 18, like the nav icons above it, so the two labels start on the
              same column. */}
          <Search size={18} />
          <span className="sr-only">Search chats</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
          />
        </label>
      </div>

      <nav className="sidebar__list" aria-label="Conversations">
        {loading && conversations.length === 0 && <p className="sidebar__empty muted">Loading…</p>}
        {!loading && conversations.length === 0 && (
          <p className="sidebar__empty muted">No conversations yet.</p>
        )}
        {conversations.length > 0 && grouped.length === 0 && (
          <p className="sidebar__empty muted">No matches.</p>
        )}

        {grouped.map((group) => (
          <div key={group.name} className="sidebar__group">
            <h2 className="sidebar__group-label">{group.name}</h2>

            {group.items.map((conversation) => (
              <div
                key={conversation.id}
                className={`conversation${conversation.id === currentId ? ' is-current' : ''}`}
              >
                <button
                  type="button"
                  className="conversation__open"
                  onClick={() => onOpen(conversation.id)}
                  aria-current={conversation.id === currentId}
                >
                  {conversation.malformed && (
                    <span className="conversation__warning" aria-hidden="true">
                      ⚠
                    </span>
                  )}
                  {conversation.title}
                </button>

                <span className="conversation__actions">
                  {!conversation.malformed && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Rename ${conversation.title}`}
                      title="Rename"
                      onClick={() => onRename(conversation.id, conversation.title)}
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete ${conversation.title}`}
                    title="Delete"
                    onClick={() => onDelete(conversation.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar__footer">
        <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
        <span className="sidebar__username">{user.username}</span>

        <button
          type="button"
          className="icon-button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title="Theme"
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onChangePassword}
          aria-label="Change password"
          title="Change password"
        >
          <KeyRound size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}
