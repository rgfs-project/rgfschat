import { FileText, Image as ImageIcon, X } from 'lucide-react';
import { formatSize } from '@shared/attachment.ts';
import { attachmentContentUrl } from './api.ts';
import type { PendingAttachment } from './useAttachments.ts';

/**
 * The files attached to the message being written.
 *
 * A chip per file, with its own progress and its own way out. Progress is drawn
 * as a fill behind the name rather than as a separate bar, so a chip occupies
 * the same space whether it is uploading or done and the strip does not resize
 * under the composer as each one finishes.
 */

export interface AttachmentChipsProps {
  items: PendingAttachment[];
  onRemove: (localId: string) => void;
}

export function AttachmentChips({
  items,
  onRemove,
}: AttachmentChipsProps): React.JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <ul className="chips" aria-label="Attached files">
      {items.map((item) => (
        <li
          key={item.localId}
          className={`chip chip--${item.status}`}
          // The fill is a background gradient stop, so an uploading chip and a
          // finished one are the same size and nothing shifts as it completes.
          style={
            item.status === 'uploading'
              ? { ['--chip-progress' as string]: `${Math.round(item.progress * 100)}%` }
              : undefined
          }
        >
          <span className="chip__icon" aria-hidden="true">
            {item.status === 'ready' && item.attachment.kind === 'image' ? (
              <ImageIcon size={13} />
            ) : (
              <FileText size={13} />
            )}
          </span>

          {item.status === 'ready' && item.attachment.kind === 'image' ? (
            <img
              className="chip__thumb"
              src={attachmentContentUrl(item.attachment.id)}
              alt=""
              width={20}
              height={20}
            />
          ) : null}

          <span className="chip__name">
            {item.status === 'ready' ? item.attachment.filename : item.filename}
          </span>

          <span className="chip__meta muted">
            {item.status === 'ready' && formatSize(item.attachment.size)}
            {item.status === 'uploading' && `${Math.round(item.progress * 100)}%`}
            {item.status === 'error' && item.message}
          </span>

          <button
            type="button"
            className="icon-button chip__remove"
            onClick={() => onRemove(item.localId)}
            aria-label={`Remove ${item.status === 'ready' ? item.attachment.filename : item.filename}`}
          >
            <X size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}
