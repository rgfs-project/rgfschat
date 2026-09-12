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
import { PreferencesStore } from './storage/preferences.ts';
import { MemoryStore } from './storage/memories.ts';
import { AttachmentStore } from './attachments/store.ts';
import { reconcileAttachments } from './attachments/reconcile.ts';
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
  const preferences = new PreferencesStore(paths0, logger);
  const memories = new MemoryStore(paths0, logger);

  /*
   * Loaded before the generation service is built, because the service asks it
   * for each model's sampler on every request. An absent or unreadable file
   * falls back to the environment.
   */
  const settings = new SettingsStore({
    paths: paths0,
    logger,
    fallbackRegistrationMode: config.auth.registrationMode,
    fallbackAttachments: config.attachments,
  });
  await settings.load();

  /*
   * Limits read through a function, so an administrator changing them takes
   * effect on the next upload rather than on the next restart — which is
   * exactly the kind of setting that otherwise looks saved and is not.
   *
   * The TTL stays environment-only: it is an operational choice about disk,
   * not a policy an instance should be able to talk itself out of.
   */
  const attachments = new AttachmentStore(paths0, () => ({
    ...settings.attachmentLimits,
    pendingTtlMs: config.attachments.pendingTtlMs,
  }));

  const service = new GenerationService({
    store,
    index,
    manager,
    hub,
    checkpoints,
    logger,
    defaultContextTokens: config.provider.defaultContextTokens,
    maxOutputTokens: config.provider.maxOutputTokens,
    settings,
    memories,
    attachments,
    maxInlineChars: config.attachments.maxInlineChars,
  });

  const paths = store.paths;
  const users = new UserStore({ paths, logger });
  const sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: config.auth.absoluteTtlMs,
    idleTtlMs: config.auth.idleTtlMs,
  });

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
    preferences,
    memories,
    service,
    users,
    sessions,
    authConfig: config.auth,
    isProduction: config.isProduction,
    registry,
    settings,
    audit,
    policy: config.hostPolicy,
    attachments,
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

  /*
   * Attachment housekeeping, per account, before the listener starts.
   *
   * Reconciliation first, then the sweep, and the order matters: the sweep
   * collects pending attachments past their TTL, and an attachment a message
   * refers to is only *pending* because a crash interrupted the linking. Swept
   * first, a conversation would lose the file it was about.
   *
   * Failure here is logged and survived rather than fatal. Neither job is
   * required for correctness of anything a request does — the worst outcome is
   * some bytes not collected until the next boot.
   */
  await Promise.all(
    (await users.list()).map(async (account) => {
      try {
        await reconcileAttachments({ attachments, store, index, userId: account.id, logger });
        const swept = await attachments.sweep(account.id);
        if (swept.incomplete + swept.expired > 0) {
          logger.info('Collected unreferenced attachments', { ...swept });
        }
      } catch (err: unknown) {
        logger.warn('Attachment housekeeping failed for an account', { error: err });
      }
    })
  );

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
