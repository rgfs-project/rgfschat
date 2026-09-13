import { Router, type Request } from 'express';
import { AppError } from '../errors/AppError.ts';
import { toArtifactDto, type ArtifactStore } from '../storage/artifacts.ts';

/**
 * Reading and discarding artifacts.
 *
 * There is no upload route, and that is deliberate. An artifact is something a
 * generation produced or an import recovered — never something a browser hands
 * over. Accepting one from the client would be accepting arbitrary HTML into a
 * store whose whole point is that its contents are not arbitrary.
 *
 * Identity comes from the session and nowhere else (INV-14): every route acts
 * on the caller's own storage, and a cross-user id is simply not found.
 */

function owner(req: Request): string {
  const userId = req.auth?.userId;
  if (userId === undefined) throw AppError.internal('Route reached without authentication');
  return userId;
}

export function artifactRoutes(artifacts: ArtifactStore): Router {
  const router = Router();

  router.get('/artifacts', async (req, res) => {
    const list = await artifacts.list(owner(req));
    res.json({ artifacts: list.map(toArtifactDto) });
  });

  router.get('/artifacts/:id', async (req, res) => {
    const meta = await artifacts.read(owner(req), req.params.id ?? '');
    res.json(toArtifactDto(meta));
  });

  /**
   * The source, as text, and only ever as text.
   *
   * An artifact is usually HTML, and HTML served from this origin with its own
   * media type is a scriptable document inside the reader's session. So the
   * stored type is deliberately *not* used here: the bytes go out as
   * `text/plain`, under the same sandbox the attachment route uses, with
   * `nosniff` so the browser cannot decide to disagree. The type that matters
   * is on the metadata, where it drives how the panel presents the source.
   *
   * Rendering an artifact rather than reading it needs an isolated origin and
   * a frame that cannot reach this one. That is a separate thing to build, and
   * it does not begin by loosening this.
   */
  router.get('/artifacts/:id/source', async (req, res) => {
    const userId = owner(req);
    const meta = await artifacts.read(userId, req.params.id ?? '');
    const content = await artifacts.content(userId, meta.id);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.send(content);
  });

  router.delete('/artifacts/:id', async (req, res) => {
    const removed = await artifacts.remove(owner(req), req.params.id ?? '');
    if (!removed) throw AppError.notFound('Artifact not found.');
    res.status(204).end();
  });

  return router;
}
