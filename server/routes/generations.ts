import { Router, type Request } from 'express';
import { z } from 'zod';
import type { GenerationAcceptedDto, GenerationEvent } from '@shared/generation.ts';
import { hasSendableContent, isCanonicalUuid } from '@shared/conversation.ts';
import { AppError } from '../errors/AppError.ts';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@shared/attachment.ts';
import type { GenerationManager } from '../generation/manager.ts';
import type { GenerationService } from '../generation/service.ts';
import { validateBody } from '../http/validate.ts';
import type { ProviderHub } from '../provider/hub.ts';
import type { SettingsStore } from '../admin/settings.ts';

/** Heartbeat interval. Contracts §5 require at least one every 15 s. */
const SSE_HEARTBEAT_MS = 10_000;

// From Phase 3 the client sends only the new user message; the server assembles
// history from canonical storage (contracts §4).
// A model is identified by the pair (providerId, modelId); ids are opaque and
// never parsed, and the pair is validated server-side (INV-18).
const createGenerationSchema = z
  .strictObject({
    conversationId: z.string().min(1).max(200),
    /**
     * Ids of attachments already uploaded and not yet part of any message.
     *
     * The format allows at most ten (contracts §3.4) and is frozen, so this is
     * the ceiling rather than a policy — a message with eleven could not be
     * written down.
     */
    attachmentIds: z.array(z.string().min(1).max(200)).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    providerId: z.string().min(1).max(64),
    model: z.string().min(1).max(200),
    /**
     * What the reader typed, which may be nothing at all.
     *
     * Empty is allowed only alongside an attachment — see the refinement below.
     * A picture is a message, and requiring a word beside it meant typing
     * something meaningless that was then shown under the image and used as the
     * conversation's title.
     */
    content: z.string().max(200_000),
    /**
     * The reader's IANA zone, for the clock placeholders in a system prompt.
     *
     * Optional: an older client does not send one, and a generation is not worth
     * refusing over a cosmetic detail. Bounded and re-checked against `Intl`
     * downstream — this is a browser-supplied string, so the length cap here is
     * the first bound and not the only one.
     */
    timeZone: z.string().min(1).max(64).optional(),
  })
  /*
   * The one rule the composer enables Send on, enforced here as well.
   *
   * At the schema boundary rather than inside the handler so a request that
   * carries neither is refused before anything is resolved or written, and so
   * the refusal is the canonical validation error rather than something the
   * service invents further in.
   */
  .refine((body) => hasSendableContent(body.content, body.attachmentIds ?? []), {
    message: 'A message must have text or at least one attachment.',
    path: ['content'],
  });

/** Re-runs the last turn; no new user message is added. */
const regenerateSchema = z.strictObject({
  conversationId: z.string().min(1).max(200),
  providerId: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  timeZone: z.string().min(1).max(64).optional(),
});

export interface GenerationRoutesOptions {
  manager: GenerationManager;
  hub: ProviderHub;
  service: GenerationService;
  /** Absent in tests that do not exercise model visibility. */
  settings?: SettingsStore;
}

/** Identity comes only from the session (INV-14). */
function ownerOf(req: Request): string {
  const userId = req.auth?.userId;
  if (userId === undefined) throw AppError.internal('Route reached without authentication');
  return userId;
}

export function generationRouter({
  manager,
  hub,
  service,
  settings,
}: GenerationRoutesOptions): Router {
  const router = Router();

  /**
   * Whether this caller may use a model.
   *
   * Hiding is a visibility rule layered *on top of* validation, never instead
   * of it: a hidden pair is still checked against the catalogue first, so
   * nothing here weakens INV-18. Administrators are exempt, so an instance
   * cannot hide every model and leave itself unable to test one.
   */
  function hiddenFor(req: Request, providerId: string, modelId: string): boolean {
    if (settings === undefined) return false;
    if (req.auth?.role === 'admin') return false;
    return settings.isHidden(providerId, modelId);
  }

  /** Non-sensitive: never carries baseUrl or apiKey (INV-25). */
  router.get('/providers', async (_req, res) => {
    res.json({ providers: await hub.listProviders() });
  });

  /** Grouped by provider, with stale/unavailable flags for the UI. */
  router.get('/models', async (req, res) => {
    const groups = await hub.listModels();
    const visible = groups.map((group) => ({
      ...group,
      models: group.models.filter((model) => !hiddenFor(req, group.providerId, model.id)),
    }));

    /*
     * The administrator's chosen default travels with the list rather than
     * living in a separate admin-only endpoint: every user needs it to pick a
     * model, and it is not sensitive. A default that has since been hidden or
     * removed is dropped here, so a client is never handed a pair it would be
     * refused for using.
     */
    const configured = settings?.resolved().defaultModel ?? null;
    const stillUsable =
      configured !== null &&
      visible.some(
        (group) =>
          group.providerId === configured.providerId &&
          group.models.some((model) => model.id === configured.modelId)
      );

    res.json({ providers: visible, defaultModel: stillUsable ? configured : null });
  });

  router.post('/generations', validateBody(createGenerationSchema), async (req, res) => {
    const { conversationId, providerId, model, content, attachmentIds, timeZone } =
      req.body as z.infer<typeof createGenerationSchema>;

    // The same answer a model that does not exist gets, so hiding one cannot
    // be used to discover that it is there.
    if (hiddenFor(req, providerId, model)) {
      throw new AppError('MODEL_NOT_FOUND', 'That model is not available.');
    }

    if (!isCanonicalUuid(conversationId)) throw AppError.notFound('Conversation not found.');

    // The pair is validated inside the service, against the server-side
    // catalog, before anything is minted or persisted.
    // Returns only once the user message is durable (INV-08).
    const result = await service.start(
      ownerOf(req),
      conversationId,
      providerId,
      model,
      content,
      attachmentIds ?? [],
      timeZone
    );

    const dto: GenerationAcceptedDto = result;
    res.status(202).json(dto);
  });

  router.post('/generations/regenerate', validateBody(regenerateSchema), async (req, res) => {
    const { conversationId, providerId, model, timeZone } = req.body as z.infer<
      typeof regenerateSchema
    >;

    if (!isCanonicalUuid(conversationId)) throw AppError.notFound('Conversation not found.');

    res
      .status(202)
      .json(await service.regenerate(ownerOf(req), conversationId, providerId, model, timeZone));
  });

  router.get('/generations/:id', (req, res) => {
    res.json(manager.require(req.params.id, ownerOf(req)));
  });

  router.post('/generations/:id/cancel', (req, res) => {
    res.json(manager.cancel(req.params.id, ownerOf(req)));
  });

  router.get('/generations/:id/stream', (req, res) => {
    const id = req.params.id;
    const owner = ownerOf(req);
    // Throws GENERATION_NOT_FOUND before any SSE header is written, so the
    // failure is a normal JSON error rather than an event stream.
    manager.require(id, owner);

    // `Last-Event-ID` is the standard EventSource reconnect header; the query
    // parameter exists because a manual fetch-based client cannot set it.
    const header = req.get('Last-Event-ID') ?? req.query['lastEventId'];
    const parsed = typeof header === 'string' ? Number.parseInt(header, 10) : Number.NaN;
    const lastEventId = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeats proxy buffering, which otherwise delays every chunk.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const write = (eventId: number, event: GenerationEvent): void => {
      res.write(`id: ${eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Either the missed events exactly, or one resync carrying the whole state.
    // A gap is never left silent (INV-20).
    for (const envelope of manager.catchUp(id, owner, lastEventId)) {
      write(envelope.id, envelope.event);
    }

    const current = manager.require(id, owner);
    if (isDone(current.state)) {
      // Terminal: the catch-up above already carried the outcome, so close
      // rather than hold a connection that will never produce another event.
      res.end();
      return;
    }

    const unsubscribe = manager.subscribe(id, owner, ({ id: eventId, event }) => {
      write(eventId, event);
      if (event.type === 'done') {
        cleanup();
        res.end();
      }
    });

    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);

    let cleaned = false;
    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
    }

    // Detaching an observer must never cancel the generation (INV-06).
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  return router;
}

function isDone(state: string): boolean {
  return (
    state === 'completed' || state === 'cancelled' || state === 'failed' || state === 'timed_out'
  );
}
