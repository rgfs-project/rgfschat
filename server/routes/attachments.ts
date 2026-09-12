import { Router, type Request, type Response } from 'express';
import busboy from 'busboy';
import { INLINE_RENDERABLE } from '@shared/attachment.ts';
import { AppError } from '../errors/AppError.ts';
import { toAttachmentDto, type AttachmentStore } from '../attachments/store.ts';

/**
 * Uploading, fetching and discarding attachments.
 *
 * Identity comes from the session and nowhere else (INV-14), so every route
 * here acts on the caller's own storage and a cross-user id is simply not
 * found. There is no `userId` to send and no route that takes one.
 */

/**
 * The caller, from server-side state only (INV-14).
 *
 * `requireAuth` has already run, so an absent session here is a wiring mistake
 * rather than a signed-out visitor — which is why it is `internal` and not a
 * 401 the client could act on.
 */
function owner(req: Request): string {
  const userId = req.auth?.userId;
  if (userId === undefined) throw AppError.internal('Route reached without authentication');
  return userId;
}

/**
 * Reads the single file out of a multipart request.
 *
 * Busboy rather than a hand-written parser: the size limit has to abort
 * *mid-stream* (contracts §7 via the phase prompt), which means the parser has
 * to hand over a readable stream rather than a finished buffer, and multipart
 * framing is a poor thing to get subtly wrong by hand.
 *
 * Exactly one file. A request carrying several is refused rather than having
 * the extras silently dropped, because a client that sent two and got one back
 * has no way to tell which.
 */
function firstFile(req: Request): Promise<{ filename: string; stream: AsyncIterable<Uint8Array> }> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'];
    if (contentType === undefined || !contentType.toLowerCase().startsWith('multipart/form-data')) {
      reject(AppError.validation('Send the file as multipart/form-data.'));
      return;
    }

    let parser: ReturnType<typeof busboy>;
    try {
      parser = busboy({ headers: req.headers, limits: { files: 1, fields: 4 } });
    } catch {
      reject(AppError.validation('The upload could not be read.'));
      return;
    }

    let seen = false;

    parser.on('file', (_name, stream, info) => {
      if (seen) {
        stream.resume();
        return;
      }
      seen = true;
      resolve({ filename: info.filename ?? 'file', stream });
    });

    parser.on('filesLimit', () => {
      reject(AppError.validation('Send one file per request.'));
    });

    parser.on('close', () => {
      if (!seen) reject(AppError.validation('No file was included in the upload.'));
    });

    parser.on('error', () => {
      reject(AppError.validation('The upload could not be read.'));
    });

    req.pipe(parser);
  });
}

/**
 * The headers that keep stored bytes from ever executing (INV-27).
 *
 * Every one of these is load-bearing:
 *
 * - `Content-Type` is the **sniffed** type, never what the uploader claimed.
 * - `nosniff` stops a browser from second-guessing that type and deciding a
 *   text file is really HTML.
 * - `Content-Disposition: attachment` for everything except the four raster
 *   image formats, so text is downloaded rather than opened in place.
 * - A sandbox CSP with `default-src 'none'`, so that even if a document did
 *   somehow render, it could load and run nothing.
 * - `private`, because these are one person's files and no shared cache should
 *   keep a copy.
 */
function setContentHeaders(res: Response, mediaType: string, filename: string, size: number): void {
  const inline = INLINE_RENDERABLE.includes(mediaType);

  res.setHeader('Content-Type', mediaType);
  res.setHeader('Content-Length', String(size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('Content-Disposition', disposition(inline ? 'inline' : 'attachment', filename));
}

/**
 * A `Content-Disposition` whose filename cannot break out of its own header.
 *
 * The stored name has already had control characters removed, but quotes and
 * backslashes have not — and a quote in the quoted-string form would end it
 * early. The ASCII form is stripped to a safe subset and the real name is
 * carried in `filename*`, which is percent-encoded and cannot contain a
 * delimiter at all.
 */
function disposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\w.\- ]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function createAttachmentsRouter(store: AttachmentStore): Router {
  const router = Router();

  router.post('/attachments', (req, res, next) => {
    void (async () => {
      try {
        const userId = owner(req);
        const { filename, stream } = await firstFile(req);
        const { meta } = await store.create(userId, filename, stream);
        res.status(201).json(toAttachmentDto(meta));
      } catch (error) {
        /*
         * The request body may still be arriving when this fails. Left
         * unread, the socket stalls until the client gives up — so what is
         * left is drained and thrown away before the error is sent.
         */
        req.unpipe();
        req.resume();
        next(error);
      }
    })();
  });

  router.get('/attachments/:id', (req, res, next) => {
    void (async () => {
      try {
        const meta = await store.read(owner(req), req.params.id);
        res.json(toAttachmentDto(meta));
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get('/attachments/:id/content', (req, res, next) => {
    void (async () => {
      try {
        const userId = owner(req);
        const meta = await store.read(userId, req.params.id);

        setContentHeaders(res, meta.mediaType, meta.filename, meta.size);
        res.sendFile(store.blobPath(userId, meta.id), (error) => {
          if (error !== undefined && error !== null && !res.headersSent) next(error);
        });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.delete('/attachments/:id', (req, res, next) => {
    void (async () => {
      try {
        await store.delete(owner(req), req.params.id);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
