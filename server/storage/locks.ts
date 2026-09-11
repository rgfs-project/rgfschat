/**
 * In-process keyed locks (contracts §2).
 *
 * Every canonical mutation — including deletion — runs under the lock for its
 * resource, so a read-modify-write sequence such as "parse the conversation,
 * append a message, write it back" cannot interleave with another and lose a
 * message.
 *
 * **Single process only.** These locks are memory, not files: two Node
 * processes sharing one `DATA_DIR` would not see each other's locks. Contracts
 * §2 declares multi-process deployment unsupported, and the README says so.
 */
export class KeyedLock {
  /** Tail of the promise chain per key. Absent means the key is free. */
  readonly #chains = new Map<string, Promise<unknown>>();

  /**
   * Runs `fn` with exclusive access to `key`. Waiters are served in the order
   * they arrived, and a rejection does not poison the queue behind it.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();

    // Swallow the predecessor's rejection so one failure cannot cascade into
    // every queued caller; the original rejection still reaches its own caller.
    const run = previous.then(fn, fn);

    // The chain tracks completion, not outcome.
    const chain = run.then(
      () => undefined,
      () => undefined
    );
    this.#chains.set(key, chain);

    try {
      return await run;
    } finally {
      // Only clear if nobody queued behind us, so the map cannot grow forever.
      if (this.#chains.get(key) === chain) this.#chains.delete(key);
    }
  }

  /** Test/diagnostic aid: how many keys currently have work queued. */
  get size(): number {
    return this.#chains.size;
  }
}

/** Lock key for a conversation: `<user>/<conversation>` (contracts §2). */
export function conversationKey(userId: string, conversationId: string): string {
  return `${userId}/${conversationId}`;
}

/** Lock key for a user's derived chats index. */
export function chatsIndexKey(userId: string): string {
  return `index:${userId}`;
}
