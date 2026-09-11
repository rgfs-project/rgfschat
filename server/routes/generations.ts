import { Router } from 'express';
import { z } from 'zod';
import type { GenerationAcceptedDto, GenerationEvent } from '@shared/generation.ts';
import { AppError } from '../errors/AppError.ts';
import type { GenerationManager } from '../generation/manager.ts';
import { validateBody } from '../http/validate.ts';
import type { Provider } from '../provider/types.ts';

/** Heartbeat interval. Contracts §5 require at least one every 15 s. */
const SSE_HEARTBEAT_MS = 10_000;

const messageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(200_000),
});

const createGenerationSchema = z.strictObject({
  model: z.string().min(1).max(200),
  messages: z.array(messageSchema).min(1).max(200),
});

export interface GenerationRoutesOptions {
  manager: GenerationManager;
  provider: Provider;
}

export function generationRouter({ manager, provider }: GenerationRoutesOptions): Router {
  const router = Router();

  router.get('/models', async (_req, res) => {
    const models = await provider.listModels();
    res.json({ models });
  });

  router.post('/generations', validateBody(createGenerationSchema), async (req, res) => {
    const { model, messages } = req.body as z.infer<typeof createGenerationSchema>;

    // The model is validated against the discovered list before anything is
    // minted, so an unknown model never creates a generation.
    const models = await provider.listModels();
    if (!models.some((candidate) => candidate.id === model)) {
      throw new AppError('MODEL_NOT_FOUND', 'The requested model is not available.');
    }

    const { generationId, assistantMessageId } = manager.start(model, messages);

    const dto: GenerationAcceptedDto = { generationId, assistantMessageId };
    res.status(202).json(dto);
  });

  router.get('/generations/:id', (req, res) => {
    res.json(manager.require(req.params.id));
  });

  router.post('/generations/:id/cancel', (req, res) => {
    res.json(manager.cancel(req.params.id));
  });

  router.get('/generations/:id/stream', (req, res) => {
    const id = req.params.id;
    // Throws GENERATION_NOT_FOUND before any SSE header is written, so the
    // failure is a normal JSON error rather than an event stream.
    const snapshot = manager.require(id);

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

    const unsubscribe = manager.subscribe(id, ({ id: eventId, event }) => {
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
