/**
 * In-process LRU of variant playlist texts (D7). Keys are object keys under an immutable
 * `assets/{id}/a{n}/` output version, so an entry can never go stale; eviction only bounds
 * memory (entry count and total characters).
 */
export class PlaylistCache {
  private readonly entries = new Map<string, string>();
  private size = 0;

  constructor(
    private readonly maxEntries = 512,
    private readonly maxChars = 32 * 1024 * 1024,
  ) {}

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert: Map iteration order is insertion order, so the first key is the LRU one.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    if (value.length > this.maxChars) return;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.size -= previous.length;
    }
    this.entries.set(key, value);
    this.size += value.length;
    while (this.entries.size > this.maxEntries || this.size > this.maxChars) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.size -= this.entries.get(oldest.value)?.length ?? 0;
      this.entries.delete(oldest.value);
    }
  }

  get count(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.size = 0;
  }
}
