import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { GenerationManager } from './generation/manager.ts';
import { createLogger } from './logger.ts';
import { LlamaCppProvider } from './provider/llamacpp.ts';
import { ConversationStore } from './storage/conversations.ts';
import { ChatIndex } from './storage/index.ts';
import { StoragePaths } from './storage/paths.ts';
import { GenerationService } from './generation/service.ts';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Config failures happen before the logger exists, so this is the one
    // place that writes a plain message to stderr.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel });

  const provider = new LlamaCppProvider(config.provider, logger);
  const manager = new GenerationManager({
    provider,
    logger,
    maxOutputTokens: config.provider.maxOutputTokens,
  });

  const store = new ConversationStore({ paths: new StoragePaths(config.dataDir), logger });
  const index = new ChatIndex({ store, logger });
  const service = new GenerationService({
    store,
    index,
    manager,
    provider,
    logger,
    defaultContextTokens: config.provider.defaultContextTokens,
    maxOutputTokens: config.provider.maxOutputTokens,
  });

  const app = createApp({
    logger,
    provider,
    manager,
    store,
    index,
    service,
    userId: () => config.localUserId,
  });

  // Prepares the user's directories and sweeps temp files left by a crash
  // (contracts §2). Failing here is fatal: storage must be usable before the
  // server accepts a request that would write to it.
  // Also rebuilds the derived index when it is missing, unparseable, or was
  // left dirty by a crash (INV-11).
  store
    .init(config.localUserId)
    .then(() => index.list(config.localUserId))
    .catch((err: unknown) => {
      logger.error('Storage initialisation failed', { error: err });
      process.exit(1);
    });

  const server = app.listen(config.port, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    logger.info('Server listening', { port, nodeEnv: config.nodeEnv });
  });

  server.on('error', (err) => {
    logger.error('Server failed to start', { error: err });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutting down', { signal });
    // In-flight generations are in-memory only; Phase 6 makes them durable.
    manager.shutdown();
    server.close((err) => {
      if (err) {
        logger.error('Shutdown failed', { error: err });
        process.exit(1);
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
