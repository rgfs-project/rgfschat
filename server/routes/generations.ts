import { Router, type Request } from 'express';
import { z } from 'zod';
import type { GenerationAcceptedDto, GenerationEvent } from '@shared/generation.ts';
import { isCanonicalUuid } from '@shared/conversation.ts';
import { AppError } from '../errors/AppError.ts';
import type { GenerationManager } from '../generation/manager.ts';
import type { GenerationService } from '../generation/service.ts';
import { validateBody } from '../http/validate.ts';
import type { Provider } from '../provider/types.ts';

/** Heartbeat interval. Contracts §5 require at least one every 15 s. */
const SSE_HEARTBEAT_MS = 10_000;

// From Phase 3 the client sends only the new user message; the server assembles
// history from canonical storage (contracts §4).
const createGenerationSchema = z.strictObject({
  conversationId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  content: z.string().min(1).max(200_000),
});

/** Re-runs the last turn; no new user message is added. */
const regenerateSchema = z.strictObject({
  conversationId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
});

export interface GenerationRoutesOptions {
  manager: GenerationManager;
  provider: Provider;
  service: GenerationService;
}

/** Identity comes only from the session (INV-14). */
function ownerOf(req: Request): string {
  const userId = req.auth?.userId;
  if (userId === undefined) throw AppError.internal('Route reached without authentication');
  return userId;
}

export function generationRouter({ manager, provider, service }: GenerationRoutesOptions): Router {
  const router = Router();

  router.get('/models', async (_req, res) => {
    const models = await provider.listModels();
    res.json({ models });
  });

  router.post('/generations', validateBody(createGenerationSchema), async (req, res) => {
    const { conversationId, model, content } = req.body as z.infer<typeof createGenerationSchema>;

    if (!isCanonicalUuid(conversationId)) throw AppError.notFound('Conversation not found.');

    // The model is validated against the discovered list before anything is
    // minted or persisted, so an unknown model never creates a generation.
    const models = await provider.listModels();
    if (!models.some((candidate) => candidate.id === model)) {
      throw new AppError('MODEL_NOT_FOUND', 'The requested model is not available.');
    }

    // Returns only once the user message is durable (INV-08).
    const result = await service.start(ownerOf(req), conversationId, model, content);

    const dto: GenerationAcceptedDto = result;
    res.status(202).json(dto);
  });

  router.post('/generations/regenerate', validateBody(regenerateSchema), async (req, res) => {
    const { conversationId, model } = req.body as z.infer<typeof regenerateSchema>;

    if (!isCanonicalUuid(conversationId)) throw AppError.notFound('Conversation not found.');

    const models = await provider.listModels();
    if (!models.some((candidate) => candidate.id === model)) {
      throw new AppError('MODEL_NOT_FOUND', 'The requested model is not available.');
    }

    res.status(202).json(await service.regenerate(ownerOf(req), conversationId, model));
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
    const snapshot = manager.require(id, owner);

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

    // A reconnecting client gets the full picture first, then live events.
    // Replay of individual missed events is Phase 6.
    write(snapshot.lastEventId, { type: 'snapshot', snapshot });

    if (
      snapshot.state === 'completed' ||
      snapshot.errorCode !== undefined ||
      isDone(snapshot.state)
    ) {
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
