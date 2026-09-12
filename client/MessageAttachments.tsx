import { useQuery } from '@tanstack/react-query';
import { FileText, ImageOff } from 'lucide-react';
import { formatSize } from '@shared/attachment.ts';
import { ApiError, attachmentContentUrl, getAttachment } from './api.ts';

/**
 * What a message carried, shown under it.
 *
 * Images are thumbnails that open full size; text is a row with its name and
 * its size. Each is fetched by id rather than being carried in the conversation
 * payload — the conversation is the Markdown, and the Markdown holds ids.
 *
 * An attachment that is gone renders a placeholder rather than disappearing or
 * failing. A file can be deleted out from under a message, and the message
 * itself is still a true record of what was said; showing nothing would make
 * the transcript quietly wrong instead of visibly incomplete (contracts §7).
 */

export interface MessageAttachmentsProps {
  ids: readonly string[];
}

export function MessageAttachments({ ids }: MessageAttachmentsProps): React.JSX.Element | null {
  if (ids.length === 0) return null;

  return (
    <ul className="attachments" aria-label="Attachments">
      {ids.map((id) => (
        <AttachmentItem key={id} id={id} />
      ))}
    </ul>
  );
}

function AttachmentItem({ id }: { id: string }): React.JSX.Element {
  const attachment = useQuery({
    queryKey: ['attachment', id],
    queryFn: () => getAttachment(id),
    // Immutable once written: the bytes and the metadata never change, so this
    // is fetched once and kept rather than revalidated on every mount.
    staleTime: Infinity,
    retry: (count, error) =>
      // A missing attachment is an answer, not a failure to get one.
      !(error instanceof ApiError && error.code === 'NOT_FOUND') && count < 2,
  });

  if (attachment.isPending) {
    return <li className="attachment attachment--loading muted">Loading…</li>;
  }

  if (attachment.isError || attachment.data === undefined) {
    return (
      <li className="attachment attachment--missing">
        <ImageOff size={14} aria-hidden="true" />
        <span className="muted">This attachment is no longer available.</span>
      </li>
    );
  }

  const { filename, kind, size } = attachment.data;
  const href = attachmentContentUrl(id);

  if (kind === 'audio') {
    return (
      <li className="attachment attachment--audio">
        {/* The browser's own player. The bytes are served with the sniffed
            type, `nosniff`, and a sandbox CSP, so playing them in place is
            safe — and a clip you must download first is a clip nobody hears. */}
        <audio controls preload="metadata" src={href} aria-label={filename} />
        <span className="attachment__name muted">{filename}</span>
      </li>
    );
  }

  if (kind === 'image') {
    return (
      <li className="attachment attachment--image">
        {/* Opens the bytes directly. They are served sandboxed, with the
            sniffed type and `nosniff`, so a new tab is safe (INV-27). */}
        <a href={href} target="_blank" rel="noreferrer noopener">
          <img src={href} alt={filename} loading="lazy" />
        </a>
      </li>
    );
  }

  return (
    <li className="attachment attachment--file">
      <FileText size={14} aria-hidden="true" />
      <a href={href} download={filename}>
        {filename}
      </a>
      <span className="muted">{formatSize(size)}</span>
    </li>
  );
}
