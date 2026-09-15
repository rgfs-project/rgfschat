import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Code2, FileText, Image, Table2, Trash2, X } from 'lucide-react';
import { ARTIFACT_LANGUAGE, type ArtifactDto, type ArtifactMediaType } from '@shared/artifact';
import { useArtifacts, useDeleteArtifact } from './queries.ts';
import { relativeTime } from './relativeTime.ts';

/**
 * Everything this reader has made, in one list.
 *
 * Artifacts outlive the conversations that produced them, so they need a way
 * in that does not go through a conversation: the file you want is usually the
 * one you remember making, not the one you remember discussing.
 *
 * Overlaid and portalled for the same reason search is — it must escape the
 * sidebar's scroll container, and it is the only thing being used while open.
 */

export interface ArtifactsDialogProps {
  onOpen: (artifact: ArtifactDto) => void;
  onClose: () => void;
}

/**
 * The mark on a row.
 *
 * Grouped by what the file *is* rather than one icon per media type: a reader
 * scanning the list is telling a page from a script from a picture, and twelve
 * distinct glyphs would be twelve things to learn for a distinction nobody is
 * making.
 */
function iconFor(mediaType: ArtifactMediaType) {
  if (mediaType === 'image/svg+xml') return Image;
  if (mediaType === 'text/csv') return Table2;
  if (mediaType === 'text/markdown' || mediaType === 'text/plain') return FileText;
  return Code2;
}

export function ArtifactsDialog({ onOpen, onClose }: ArtifactsDialogProps): React.JSX.Element {
  const artifacts = useArtifacts();
  const remove = useDeleteArtifact();
  const [active, setActive] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const rows = artifacts.data ?? [];

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      // A pending confirmation is the thing Escape cancels first.
      if (confirming !== null) setConfirming(null);
      else onClose();
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
      if (row !== undefined) onOpen(row);
    }
  };

  useEffect(() => {
    listRef.current?.querySelector('.palette__row.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return createPortal(
    <div className="modal" role="presentation" onPointerDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Artifacts"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette__field palette__field--plain">
          <h2 className="palette__heading">Artifacts</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close artifacts"
            autoFocus
          >
            <X size={18} />
          </button>
        </div>

        <div className="palette__list" ref={listRef}>
          {artifacts.isPending && <p className="palette__empty muted">Loading…</p>}
          {artifacts.isError && (
            <p className="palette__empty muted">Your artifacts could not be loaded.</p>
          )}
          {!artifacts.isPending && !artifacts.isError && rows.length === 0 && (
            <p className="palette__empty muted">
              Nothing here yet. Artifacts arrive with an imported export.
            </p>
          )}

          {rows.map((artifact, index) => {
            const Icon = iconFor(artifact.mediaType);
            const pending = confirming === artifact.id;

            return (
              <div
                key={artifact.id}
                className={`palette__row artifact-row${index === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
              >
                <button
                  type="button"
                  className="artifact-row__open"
                  onClick={() => onOpen(artifact)}
                >
                  <span className="artifact-row__icon" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <span className="palette__text">
                    <span className="palette__title">{artifact.name}</span>
                    <span className="palette__snippet">
                      {ARTIFACT_LANGUAGE[artifact.mediaType]}
                      {artifact.description !== undefined && ` · ${artifact.description}`}
                    </span>
                  </span>
                  <span className="artifact-row__when">
                    {relativeTime(artifact.createdAt) ?? ''}
                  </span>
                </button>

                {/* Confirmation in place rather than a second dialog over this
                    one: the row being destroyed stays visible, which is the
                    thing a confirmation is actually for. */}
                {pending ? (
                  <span className="artifact-row__confirm">
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => setConfirming(null)}
                      disabled={remove.isPending}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="linkish is-destructive"
                      disabled={remove.isPending}
                      onClick={() => {
                        remove.mutate(artifact.id, { onSettled: () => setConfirming(null) });
                      }}
                    >
                      Delete
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setConfirming(artifact.id)}
                    aria-label={`Delete ${artifact.name}`}
                    title="Delete"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}
