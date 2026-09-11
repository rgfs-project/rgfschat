import { loadConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { StoragePaths } from '../storage/paths.ts';

/** Rebuilds the derived chats index for `LOCAL_USER_ID`. See scripts/rebuild-index.mjs. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  const store = new ConversationStore({
    paths: new StoragePaths(config.dataDir),
    logger,
  });
  const index = new ChatIndex({ store, logger });

  await store.init(config.localUserId);
  const entries = await index.rebuild(config.localUserId);

  process.stdout.write(
    `Rebuilt index for ${config.localUserId}: ${entries.length} conversation(s)\n`
  );
}

await main();
