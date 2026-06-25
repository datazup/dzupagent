/**
 * ShortTermBuffer — a fixed-capacity in-memory buffer that implements
 * short-term (working) memory semantics:
 *
 * - Ordered insertion with turn-based timestamps
 * - Capacity cap: oldest item evicted when buffer is full
 * - Recency scoring: higher score = more recently added
 * - Flush-to-long-term: moves buffer contents to a MemoryService
 * - Automatic flush when buffer reaches a configurable threshold
 *
 * @example
 * ```ts
 * const buf = new ShortTermBuffer({ capacity: 10, flushThreshold: 8, store: svc, namespace: 'stm' })
 * buf.add({ text: 'user said hello', turn: 1 })
 * const items = buf.peek()
 * await buf.flush({ tenantId: 't1' })
 * ```
 */
import type { MemoryService } from "./memory-service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BufferItem {
  /** Arbitrary text content */
  text: string;
  /** Logical turn / sequence number — used for recency scoring */
  turn: number;
  /** Optional tag for categorization */
  tag?: string | undefined;
  /** Insertion timestamp (set automatically by add()) */
  insertedAt?: number | undefined;
}

export interface ShortTermBufferConfig {
  /** Maximum number of items in the buffer (default: 20) */
  capacity?: number | undefined;
  /** Number of items that triggers an automatic flush (default: capacity) */
  flushThreshold?: number | undefined;
  /** MemoryService for long-term persistence */
  store: MemoryService;
  /** Namespace in the MemoryService */
  namespace: string;
  /** Auto-flush when threshold is reached (default: true) */
  autoFlush?: boolean | undefined;
}

export interface RecencyScore {
  item: BufferItem;
  score: number;
}

// ---------------------------------------------------------------------------
// ShortTermBuffer
// ---------------------------------------------------------------------------

export class ShortTermBuffer {
  private items: BufferItem[] = [];
  private readonly capacity: number;
  private readonly flushThreshold: number;
  private readonly store: MemoryService;
  private readonly namespace: string;
  private readonly autoFlush: boolean;
  private flushCounter: number = 0;

  constructor(config: ShortTermBufferConfig) {
    this.capacity = config.capacity ?? 20;
    this.store = config.store;
    this.namespace = config.namespace;
    this.autoFlush = config.autoFlush ?? true;
    // Default threshold: capacity (auto-flush only when full)
    this.flushThreshold = config.flushThreshold ?? this.capacity;
  }

  /**
   * Add an item to the buffer.
   * If the buffer is at capacity, the oldest item (lowest turn) is evicted.
   * If autoFlush is enabled and the buffer reaches flushThreshold after
   * the add, a flush is triggered automatically.
   */
  async add(
    item: BufferItem,
    scope: Record<string, string> = {},
  ): Promise<void> {
    const entry: BufferItem = {
      ...item,
      insertedAt: item.insertedAt ?? Date.now(),
    };

    if (this.items.length >= this.capacity) {
      // Evict oldest (first in array = lowest turn)
      this.items.shift();
    }

    this.items.push(entry);

    if (this.autoFlush && this.items.length >= this.flushThreshold) {
      await this.flush(scope);
    }
  }

  /**
   * Return all buffer items in insertion order without removing them.
   */
  peek(): BufferItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  /**
   * Remove and return the most recently added item, or undefined if empty.
   */
  pop(): BufferItem | undefined {
    return this.items.pop();
  }

  /**
   * Clear all buffer items.
   */
  clear(): void {
    this.items = [];
  }

  /**
   * Return the current number of items in the buffer.
   */
  get size(): number {
    return this.items.length;
  }

  /**
   * Compute recency scores for all current items.
   * The most recently added item gets score 1.0; older items decay linearly
   * based on how many turns ago they were added relative to the newest turn.
   *
   * Score formula: 1 - (newestTurn - item.turn) / max(newestTurn - oldestTurn, 1)
   */
  recencyScores(): RecencyScore[] {
    if (this.items.length === 0) return [];
    const turns = this.items.map((i) => i.turn);
    const newest = Math.max(...turns);
    const oldest = Math.min(...turns);
    const range = Math.max(newest - oldest, 1);
    return this.items.map((item) => ({
      item: { ...item },
      score: 1 - (newest - item.turn) / range,
    }));
  }

  /**
   * Flush all buffer items to long-term storage and clear the buffer.
   * Each item is stored under a unique key: `stm-flush-${flushId}-${index}`.
   */
  async flush(scope: Record<string, string> = {}): Promise<number> {
    if (this.items.length === 0) return 0;
    const count = this.items.length;
    const flushId = ++this.flushCounter;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      const key = `stm-flush-${flushId}-${i}`;
      await this.store.put(this.namespace, scope, key, {
        text: item.text,
        turn: item.turn,
        tag: item.tag ?? null,
        insertedAt: item.insertedAt ?? null,
        flushId,
        flushIndex: i,
      });
    }
    this.items = [];
    return count;
  }

  /**
   * Flush only items whose turn is older than (maxTurn - oldThreshold).
   * Items within oldThreshold turns of the newest item are kept.
   */
  async partialFlush(
    oldThreshold: number,
    scope: Record<string, string> = {},
  ): Promise<number> {
    if (this.items.length === 0) return 0;
    const newest = Math.max(...this.items.map((i) => i.turn));
    const cutoff = newest - oldThreshold;
    const toFlush = this.items.filter((i) => i.turn <= cutoff);
    const toKeep = this.items.filter((i) => i.turn > cutoff);

    if (toFlush.length === 0) return 0;
    const flushId = ++this.flushCounter;
    for (let i = 0; i < toFlush.length; i++) {
      const item = toFlush[i]!;
      const key = `stm-partial-${flushId}-${i}`;
      await this.store.put(this.namespace, scope, key, {
        text: item.text,
        turn: item.turn,
        tag: item.tag ?? null,
        insertedAt: item.insertedAt ?? null,
        flushId,
        flushIndex: i,
      });
    }
    this.items = toKeep;
    return toFlush.length;
  }

  /**
   * Serialize buffer state to a plain object for persistence.
   */
  serialize(): { items: BufferItem[]; capacity: number; flushCounter: number } {
    return {
      items: this.items.map((i) => ({ ...i })),
      capacity: this.capacity,
      flushCounter: this.flushCounter,
    };
  }

  /**
   * Restore buffer state from a serialized snapshot.
   * Items are trimmed to current capacity if the snapshot had a larger capacity.
   */
  deserialize(snapshot: { items: BufferItem[]; flushCounter?: number }): void {
    const items = snapshot.items.map((i) => ({ ...i }));
    // Trim to current capacity (keep most recent)
    this.items = items.slice(-this.capacity);
    if (typeof snapshot.flushCounter === "number") {
      this.flushCounter = snapshot.flushCounter;
    }
  }
}
