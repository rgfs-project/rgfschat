import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Code2, X } from 'lucide-react';
import type { ArtifactSummary } from '@shared/artifact.ts';
import { useArtifacts } from './queries.ts';
import { useFocusTrap } from './useFocusTrap.ts';

/**
 * Every code block the reader has, in one place.
 *
 * The point of this screen is recall: people remember writing something down
 * far better than they remember which conversation they wrote it in. So the
 * rows lead with the artifact's own name and carry the conversation as the
 * subtitle, rather than the other way round — the conversation is the thing
 * being searched *for*, not the thing being listed.
 *
 * Portalled and modal like the search palette, and for the same reasons: it has
 * to escape the sidebar's scroll container, and it is the only thing in use
 * while it is open.
 */

export interface ArtifactGalleryProps {
  onOpen: (artifact: ArtifactSummary) => void;
  onClose: () => void;
}

/** Grouped the way the sidebar groups conversations: by how long ago. */
function monthDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ArtifactGallery({ onOpen, onClose }: ArtifactGalleryProps): React.JSX.Element {
  const artifacts = useArtifacts(true);
  const trap = useFocusTrap<HTMLDivElement>({ onEscape: onClose });

  // Newest first. The server already orders by conversation, but a conversation
  // holds several artifacts and the reader thinks in "the one I made last".
  const rows = useMemo(
    () => [...(artifacts.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [artifacts.data]
  );

  return createPortal(
    <div className="modal" role="presentation" onPointerDown={onClose}>
      <div
        className="gallery"
        ref={trap}
        role="dialog"
        aria-modal="true"
        aria-label="Artifacts"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="gallery__head">
          <h2 className="gallery__title">Artifacts</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close artifacts"
          >
            <X size={18} />
          </button>
        </div>

        <div className="gallery__list">
          {artifacts.isPending && <p className="gallery__empty muted">Loading…</p>}
          {artifacts.isError && (
            <p className="gallery__empty muted">The artifact list could not be loaded.</p>
          )}
          {!artifacts.isPending && !artifacts.isError && rows.length === 0 && (
            <p className="gallery__empty muted">
              No artifacts yet. Code blocks in a conversation show up here.
            </p>
          )}

          {rows.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              className="gallery__row"
              onClick={() => onOpen(artifact)}
            >
              <span className="gallery__icon" aria-hidden="true">
                <Code2 size={16} />
              </span>
              <span className="gallery__text">
                <span className="gallery__name">{artifact.title}</span>
                <span className="gallery__from">{artifact.conversationTitle}</span>
              </span>
              <span className="gallery__date">{monthDay(artifact.updatedAt)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
