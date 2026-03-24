/**
 * Frozen snapshot pattern — freeze memory at session start to preserve prompt cache.
 *
 * When frozen, all reads return the snapshot taken at freeze time.
 * Writes are buffered and flushed when unfrozen. This ensures the
 * system prompt (which includes memory context) stays identical
 * throughout the session, maximizing Anthropic prompt cache hits.
 *
 * @example
 * ```ts
 * const snapshot = new FrozenMemorySnapshot(memoryService)
 * await snapshot.freeze(['decisions', 'lessons'], scope)
 *
 * // During session: reads return frozen data, writes are buffered
 * const data = await snapshot.get('decisions', scope)
 *
 * // End of session: flush buffered writes
 * await snapshot.unfreeze()
 * ```
 */
import type { MemoryService } from './memory-service.js'

interface BufferedWrite {
  namespace: string
  scope: Record<string, string>
  key: string
  value: Record<string, unknown>
}

export class FrozenMemorySnapshot {
  private snapshots = new Map<string, Record<string, unknown>[]>()
  private writeBuffer: BufferedWrite[] = []
  private frozen = false

  constructor(private memoryService: MemoryService) {}

  /** Freeze memory — take snapshots of specified namespaces */
  async freeze(
    namespaces: string[],
    scope: Record<string, string>,
  ): Promise<void> {
    for (const ns of namespaces) {
      const records = await this.memoryService.get(ns, scope)
      this.snapshots.set(ns, records)
    }
    this.frozen = true
    this.writeBuffer = []
  }

  /** Check if memory is currently frozen */
  isFrozen(): boolean {
    return this.frozen
  }

  /** Get records — returns frozen snapshot if frozen, else delegates to service */
  async get(
    namespace: string,
    scope: Record<string, string>,
    key?: string,
  ): Promise<Record<string, unknown>[]> {
    if (this.frozen && this.snapshots.has(namespace)) {
      const records = this.snapshots.get(namespace)!
      if (key) return records.filter(r => r['key'] === key)
      return records
    }
    return this.memoryService.get(namespace, scope, key)
  }

  /** Put — buffers write if frozen, else delegates to service */
  async put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    if (this.frozen) {
      this.writeBuffer.push({ namespace, scope, key, value })
      return
    }
    return this.memoryService.put(namespace, scope, key, value)
  }

  /** Unfreeze — flush all buffered writes to the real store */
  async unfreeze(): Promise<void> {
    this.frozen = false

    for (const { namespace, scope, key, value } of this.writeBuffer) {
      await this.memoryService.put(namespace, scope, key, value)
    }

    this.writeBuffer = []
    this.snapshots.clear()
  }

  /** Number of buffered writes waiting to be flushed */
  get pendingWrites(): number {
    return this.writeBuffer.length
  }

  /** Format frozen snapshot as prompt context */
  formatForPrompt(namespace: string, header?: string): string {
    const records = this.snapshots.get(namespace)
    if (!records || records.length === 0) return ''
    return this.memoryService.formatForPrompt(records, { header })
  }
}
