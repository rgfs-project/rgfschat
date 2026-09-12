import { useMemo, useRef, useState } from 'react';
import {
  ChevronUp,
  Download,
  LogOut,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings as SettingsIcon,
  Shield,
  Sun,
  Trash2,
} from 'lucide-react';
import { Menu } from './Menu.tsx';
import { useFocusTrap } from './useFocusTrap.ts';
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
  /** Opens the search palette; the sidebar itself no longer filters. */
  onSearch: () => void;
  onRename: (id: string, currentTitle: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onDownload: (id: string, title: string) => void;
  onSettings: () => void;
  onOpenAdmin: () => void;
  onSignOut: () => void;
  /**
   * Open as a drawer over the page rather than standing beside it.
   *
   * Only then is it a dialog: it covers what it is in front of, so focus has to
   * be held inside it and Escape has to dismiss it. As a column on a wide window
   * it is just another region of the page and trapping focus in it would be a
   * bug, not a feature.
   */
  modal?: boolean;
}

/**
 * Groups by recency the way a reader thinks about it, not by exact date.
 *
 * Measured from the start of today rather than from the current moment, so a
 * conversation from this morning is under Today at 11pm — with a rolling
 * 24-hour window it would have moved to Yesterday while the day was still on.
 */
function bucketOf(updatedAt: string, startOfToday: number): string {
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return 'Older';

  const day = 24 * 60 * 60 * 1000;
  if (at >= startOfToday) return 'Today';
  if (at >= startOfToday - day) return 'Yesterday';
  if (at >= startOfToday - 7 * day) return 'Previous 7 days';
  if (at >= startOfToday - 30 * day) return 'Previous 30 days';
  return 'Older';
}

const BUCKET_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];
const PINNED = 'Pinned';

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
  onSearch,
  onRename,
  onDelete,
  onPin,
  onDownload,
  onSettings,
  onOpenAdmin,
  onSignOut,
  modal = false,
}: SidebarProps): React.JSX.Element {
  const trap = useFocusTrap<HTMLElement>({ active: modal, onEscape: onCollapse });

  const grouped = useMemo(() => {
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const buckets = new Map<string, ConversationSummary[]>();

    for (const conversation of conversations) {
      // Pinned is a group, not a badge: the point of pinning is that the
      // conversation stops moving as its date changes.
      const bucket =
        conversation.pinned === true ? PINNED : bucketOf(conversation.updatedAt, startOfToday);
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), conversation]);
    }

    return [PINNED, ...BUCKET_ORDER]
      .filter((name) => buckets.has(name))
      .map((name) => ({ name, items: buckets.get(name) ?? [] }));
  }, [conversations]);

  return (
    <aside
      className="sidebar"
      ref={trap}
      /*
       * A drawer announces itself as a dialog; a column is just a landmark.
       * Marking it a dialog on a wide window would tell a screen-reader user
       * that something had opened over the page when nothing had.
       */
      {...(modal
        ? ({ role: 'dialog', 'aria-modal': true, 'aria-label': 'Navigation' } as const)
        : {})}
    >
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
          <Plus size={15} />
          New chat
        </button>

        {/* Shown only to admins as a convenience; `requireAdmin` on the server
            is what actually protects these routes (INV-24). */}
        {user.role === 'admin' && (
          <button type="button" className="nav-button" onClick={onOpenAdmin}>
            <Shield size={15} />
            Admin
          </button>
        )}

        {/* A button, not a field. What it opens searches message bodies on the
            server, which a box sitting in the sidebar cannot do; keeping the
            shape of a field here would promise the wrong thing — and it is one
            of the three ways out of this pane, so it looks like the other two. */}
        <button type="button" className="nav-button" onClick={onSearch}>
          <Search size={15} />
          Search
        </button>
      </div>

      <nav className="sidebar__list" aria-label="Conversations">
        {loading && conversations.length === 0 && <p className="sidebar__empty muted">Loading…</p>}
        {!loading && conversations.length === 0 && (
          <p className="sidebar__empty muted">No conversations yet.</p>
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

                <ConversationMenu
                  conversation={conversation}
                  onRename={onRename}
                  onDelete={onDelete}
                  onPin={onPin}
                  onDownload={onDownload}
                />
              </div>
            ))}
          </div>
        ))}
      </nav>

      <AccountMenu
        user={user}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onSettings={onSettings}
        onSignOut={onSignOut}
      />
    </aside>
  );
}

/**
 * A conversation's own actions, behind one control.
 *
 * They were two icons that appeared on hover, which is two hit targets in a
 * 28px strip at the end of a row and no room for a third. One control opens a
 * list with room for names, and the row keeps its title.
 */
function ConversationMenu({
  conversation,
  onRename,
  onDelete,
  onPin,
  onDownload,
}: {
  conversation: ConversationSummary;
  onRename: (id: string, currentTitle: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onDownload: (id: string, title: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const pinned = conversation.pinned === true;

  // A malformed conversation can be pinned and deleted but not read, so the two
  // actions that need to read it are not offered.
  const items = [
    {
      label: pinned ? 'Unpin' : 'Pin',
      icon: pinned ? <PinOff size={15} /> : <Pin size={15} />,
      onSelect: () => onPin(conversation.id, !pinned),
    },
    ...(conversation.malformed
      ? []
      : [
          {
            label: 'Rename',
            icon: <Pencil size={15} />,
            onSelect: () => onRename(conversation.id, conversation.title),
          },
          {
            label: 'Download',
            icon: <Download size={15} />,
            onSelect: () => onDownload(conversation.id, conversation.title),
          },
        ]),
    {
      label: 'Delete',
      icon: <Trash2 size={15} />,
      destructive: true,
      onSelect: () => onDelete(conversation.id),
    },
  ];

  return (
    <span className={`conversation__actions${open ? ' is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label={`Actions for ${conversation.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={16} />
      </button>

      {open && triggerRef.current !== null && (
        <Menu
          anchor={triggerRef.current}
          items={items}
          align="start"
          label={`Actions for ${conversation.title}`}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

/**
 * The account row, and everything that belongs to the person rather than to a
 * conversation.
 *
 * Three unlabelled icons sat here, which is three guesses at what they do in
 * the corner of the window a reader looks at least. One row with a name on it
 * opens a list where each is written out.
 */
function AccountMenu({
  user,
  theme,
  onToggleTheme,
  onSettings,
  onSignOut,
}: {
  user: UserDto;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onSettings: () => void;
  onSignOut: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="sidebar__footer">
      <button
        ref={triggerRef}
        type="button"
        className="account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
        <span className="sidebar__username">{user.username}</span>
        <ChevronUp size={16} className={`account__chevron${open ? ' is-open' : ''}`} />
      </button>

      {open && triggerRef.current !== null && (
        <Menu
          anchor={triggerRef.current}
          // It sits on the bottom edge of the window; down is never where it
          // goes.
          prefer="up"
          matchWidth
          items={[
            {
              label: 'Settings',
              icon: <SettingsIcon size={15} />,
              onSelect: onSettings,
            },
            {
              label: theme === 'dark' ? 'Light mode' : 'Dark mode',
              icon: theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />,
              onSelect: onToggleTheme,
            },
            {
              label: 'Sign out',
              icon: <LogOut size={15} />,
              separated: true,
              onSelect: onSignOut,
            },
          ]}
          label="Account"
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
