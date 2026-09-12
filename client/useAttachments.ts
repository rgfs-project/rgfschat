import { useCallback, useRef, useState } from 'react';
import { MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentDto } from '@shared/attachment.ts';
import { ApiError, deleteAttachment, uploadAttachment } from './api.ts';

/**
 * The files waiting to be sent with the next message.
 *
 * Uploads start the moment a file is chosen rather than when the message is
 * sent. By the time a reader finishes typing, a 9 MB image is already on the
 * server — and the failures that matter (wrong type, too large, out of quota)
 * are reported while there is still something obvious to do about them, rather
 * than at the end of composing a message.
 *
 * The cost is that an abandoned draft leaves uploads nobody referenced. That is
 * exactly what the server's pending state and its TTL sweep are for.
 */

/** One entry in the tray: uploading, ready, or refused. */
export type PendingAttachment =
  | { status: 'uploading'; localId: string; filename: string; size: number; progress: number }
  | { status: 'ready'; localId: string; attachment: AttachmentDto }
  | { status: 'error'; localId: string; filename: string; message: string };

export interface AttachmentTray {
  items: PendingAttachment[];
  /** Ids to send with the message — only the ones that actually uploaded. */
  readyIds: string[];
  /** Whether anything is still in flight, so sending can wait for it. */
  busy: boolean;
  add: (files: readonly File[]) => void;
  remove: (localId: string) => void;
  /** Forgets everything, after a successful send. */
  clear: () => void;
  /** How many more may be added, given what is already here. */
  remaining: number;
}

export function useAttachments(): AttachmentTray {
  const [items, setItems] = useState<PendingAttachment[]>([]);

  /**
   * In-flight uploads, so removing a chip actually stops the transfer rather
   * than only hiding it. Without this, cancelling a large upload would leave it
   * running to completion and land in the reader's quota anyway.
   */
  const controllers = useRef(new Map<string, AbortController>());

  const replace = useCallback((localId: string, next: PendingAttachment) => {
    setItems((current) => current.map((item) => (item.localId === localId ? next : item)));
  }, []);

  const add = useCallback(
    (files: readonly File[]) => {
      setItems((current) => {
        const room = MAX_ATTACHMENTS_PER_MESSAGE - current.length;
        const accepted = files.slice(0, Math.max(0, room));

        const started = accepted.map((file): PendingAttachment => {
          const localId = crypto.randomUUID();
          const controller = new AbortController();
          controllers.current.set(localId, controller);

          void uploadAttachment(file, {
            signal: controller.signal,
            onProgress: (progress) => {
              setItems((now) =>
                now.map((item) =>
                  item.localId === localId && item.status === 'uploading'
                    ? { ...item, progress }
                    : item
                )
              );
            },
          })
            .then((attachment) => {
              controllers.current.delete(localId);
              replace(localId, { status: 'ready', localId, attachment });
            })
            .catch((error: unknown) => {
              controllers.current.delete(localId);
              // A cancelled upload has already been removed from the tray;
              // reporting it would put a chip back that the reader dismissed.
              if (controller.signal.aborted) return;
              replace(localId, {
                status: 'error',
                localId,
                filename: file.name,
                message:
                  error instanceof ApiError ? error.message : 'The file could not be uploaded.',
              });
            });

          return {
            status: 'uploading',
            localId,
            filename: file.name,
            size: file.size,
            progress: 0,
          };
        });

        // Anything past the limit is refused visibly rather than dropped: a
        // file that silently did not attach is worse than one that says so.
        const refused = files.slice(accepted.length).map((file): PendingAttachment => ({
          status: 'error',
          localId: crypto.randomUUID(),
          filename: file.name,
          message: `A message may carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`,
        }));

        return [...current, ...started, ...refused];
      });
    },
    [replace]
  );

  const remove = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
    controllers.current.delete(localId);

    setItems((current) => {
      const target = current.find((item) => item.localId === localId);
      // Already on the server, so tell the server. A failure here is not worth
      // reporting: the attachment is pending and the sweep will collect it.
      if (target?.status === 'ready') {
        void deleteAttachment(target.attachment.id).catch(() => undefined);
      }
      return current.filter((item) => item.localId !== localId);
    });
  }, []);

  const clear = useCallback(() => {
    controllers.current.clear();
    setItems([]);
  }, []);

  return {
    items,
    readyIds: items.flatMap((item) => (item.status === 'ready' ? [item.attachment.id] : [])),
    busy: items.some((item) => item.status === 'uploading'),
    add,
    remove,
    clear,
    remaining: Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - items.length),
  };
}
