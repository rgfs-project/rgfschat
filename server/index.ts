import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { GenerationManager } from './generation/manager.ts';
import { createLogger } from './logger.ts';
import { ProviderHub } from './provider/hub.ts';
import { ProviderRegistry } from './provider/registry.ts';
import { AuditLog } from './admin/audit.ts';
import { SettingsStore } from './admin/settings.ts';
import { ConversationStore } from './storage/conversations.ts';
import { ChatIndex } from './storage/index.ts';
import { StoragePaths } from './storage/paths.ts';
import { GenerationService } from './generation/service.ts';
import { CheckpointStore } from './generation/checkpoints.ts';
import { recoverGenerations } from './generation/recovery.ts';
import { UserStore } from './auth/users.ts';
import { SessionManager } from './auth/sessions.ts';

async function main(): Promise<void> {
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

  const paths0 = new StoragePaths(config.dataDir);
  const registry = new ProviderRegistry({ paths: paths0, logger, policy: config.hostPolicy });
  const hub = new ProviderHub({
    logger,
    policy: config.hostPolicy,
    defaultContextTokens: config.provider.defaultContextTokens,
    maxOutputTokens: config.provider.maxOutputTokens,
  });
  const checkpoints = new CheckpointStore({ paths: paths0, logger });
  const manager = new GenerationManager({
    logger,
    maxOutputTokens: config.provider.maxOutputTokens,
    replayEvents: config.streaming.replayEvents,
    checkpointMs: config.streaming.checkpointMs,
    retentionMs: config.streaming.retentionMs,
    checkpoints,
  });

  const store = new ConversationStore({ paths: paths0, logger });
  const index = new ChatIndex({ store, logger });
  const service = new GenerationService({
    store,
    index,
    manager,
    hub,
    checkpoints,
    logger,
    defaultContextTokens: config.provider.defaultContextTokens,
    maxOutputTokens: config.provider.maxOutputTokens,
  });

  const paths = store.paths;
  const users = new UserStore({ paths, logger });
  const sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: config.auth.absoluteTtlMs,
    idleTtlMs: config.auth.idleTtlMs,
  });

  /*
   * Instance settings and the audit log. Settings load before the app is built
   * so `registrationMode` is already resolved when the first request arrives;
   * an absent or unreadable file falls back to the environment.
   */
  const settings = new SettingsStore({
    paths,
    logger,
    fallbackRegistrationMode: config.auth.registrationMode,
  });
  await settings.load();
  const audit = new AuditLog({ paths, logger });

  const app = createApp({
    logger,
    // The server binary lives at dist/server/index.js, so the built client is
    // its sibling.
    clientDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'client'),
    hub,
    manager,
    store,
    index,
    service,
    users,
    sessions,
    authConfig: config.auth,
    isProduction: config.isProduction,
    registry,
    settings,
    audit,
    policy: config.hostPolicy,
  });

  // Prepares the user's directories and sweeps temp files left by a crash
  // (contracts §2). Failing here is fatal: storage must be usable before the
  // server accepts a request that would write to it.
  // Also rebuilds the derived index when it is missing, unparseable, or was
  // left dirty by a crash (INV-11).
  // Storage for a user is prepared on demand now that accounts exist; startup
  // only sweeps expired sessions and warns when there is no account yet.
  // Providers load from _system/providers.json, bootstrapping from the
  // environment on first run. Discovery is warmed in the background so a
  // provider that is down cannot delay startup.
  registry
    .load({
      baseUrl: config.provider.baseUrl,
      ...(config.provider.apiKey !== undefined ? { apiKey: config.provider.apiKey } : {}),
      timeoutMs: config.provider.timeoutMs,
    })
    .then((result) => {
      hub.setProviders(result.providers);
      hub.warm();
      logger.info('Providers loaded', {
        count: result.providers.length,
        rejected: result.rejected.length,
      });
    })
    .catch((err: unknown) => logger.error('Provider configuration failed to load', { error: err }));

  sessions
    .cleanupExpired()
    .then(async () => {
      if ((await users.count()) === 0) {
        logger.warn('No accounts exist. Create the first admin with: npm run user:create', {});
      }
    })
    .catch((err: unknown) => {
      logger.error('Startup initialisation failed', { error: err });
      process.exit(1);
    });

  // Recovery runs to completion before the listener starts: a client must never
  // be able to read a conversation that is missing an interrupted turn (INV-21).
  await recoverGenerations({ checkpoints, store, index, logger })
    .then((result) => {
      if (result.interrupted + result.alreadyWritten + result.cleared > 0) {
        logger.info('Generation recovery complete', { ...result });
      }
    })
    .catch((err: unknown) => {
      logger.error('Generation recovery failed', { error: err });
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

await main();
