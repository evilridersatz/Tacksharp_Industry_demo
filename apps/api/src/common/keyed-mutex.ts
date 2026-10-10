/**
 * Serializes async work per key (e.g. per customer phone) inside one process.
 * Prevents two WhatsApp messages from the same customer being answered in parallel
 * against the same conversation. Fine for a single Lightsail instance; replace with
 * a Redis lock or BullMQ groups if you scale to multiple API servers.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    this.tails.set(key, current);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === current) {
        this.tails.delete(key);
      }
    }
  }
}
