/**
 * File-based implementation of {@link LearningStore}.
 *
 * Persists all learning data as a single JSON file on disk.
 * Writes are debounced via a periodic flush timer so that frequent
 * `saveRecord` calls don't hammer the filesystem.
 *
 * Suitable for development and single-process deployments.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { ExecutionRecord, ProviderProfile, FailurePattern } from './adapter-learning-loop.js'
import type { LearningStore, LearningSnapshot } from './learning-store.js'

const EMPTY_SNAPSHOT: LearningSnapshot = Object.freeze({
  version: 1 as const,
  exportedAt: 0,
  records: {},
  profiles: {},
  failurePatterns: {},
})

export class FileLearningStore implements LearningStore {
  private data: LearningSnapshot
  private dirty = false
  private flushTimer?: ReturnType<typeof setInterval>

  constructor(
    private readonly filePath: string,
    private readonly flushIntervalMs: number = 5_000,
  ) {
    this.data = this.load()
    this.scheduleFlush()
  }

  // -----------------------------------------------------------------------
  // Records
  // -----------------------------------------------------------------------

  saveRecord(providerId: string, record: ExecutionRecord): void {
    if (!this.data.records[providerId]) {
      this.data.records[providerId] = []
    }
    this.data.records[providerId].push(record)
    this.dirty = true
  }

  loadRecords(providerId: string, limit: number): ExecutionRecord[] {
    const arr = this.data.records[providerId] ?? []
    return arr.slice(-limit)
  }

  // -----------------------------------------------------------------------
  // Profiles
  // -----------------------------------------------------------------------

  saveProfile(providerId: string, profile: ProviderProfile): void {
    this.data.profiles[providerId] = profile
    this.dirty = true
  }

  getProfile(providerId: string): ProviderProfile | undefined {
    return this.data.profiles[providerId]
  }

  // -----------------------------------------------------------------------
  // Failure patterns
  // -----------------------------------------------------------------------

  saveFailurePatterns(providerId: string, patterns: FailurePattern[]): void {
    this.data.failurePatterns[providerId] = patterns
    this.dirty = true
  }

  getFailurePatterns(providerId: string): FailurePattern[] {
    return this.data.failurePatterns[providerId] ?? []
  }

  // -----------------------------------------------------------------------
  // Export / Import
  // -----------------------------------------------------------------------

  exportAll(): LearningSnapshot {
    return {
      version: 1,
      exportedAt: Date.now(),
      records: { ...this.data.records },
      profiles: { ...this.data.profiles },
      failurePatterns: { ...this.data.failurePatterns },
    }
  }

  importAll(snapshot: LearningSnapshot): void {
    this.data = {
      version: 1,
      exportedAt: snapshot.exportedAt,
      records: { ...snapshot.records },
      profiles: { ...snapshot.profiles },
      failurePatterns: { ...snapshot.failurePatterns },
    }
    this.dirty = true
  }

  // -----------------------------------------------------------------------
  // Compaction
  // -----------------------------------------------------------------------

  compact(maxRecordsPerProvider: number): { removedCount: number } {
    let removedCount = 0
    for (const [id, arr] of Object.entries(this.data.records)) {
      if (arr && arr.length > maxRecordsPerProvider) {
        const excess = arr.length - maxRecordsPerProvider
        this.data.records[id] = arr.slice(excess)
        removedCount += excess
      }
    }
    if (removedCount > 0) this.dirty = true
    return { removedCount }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  dispose(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.dirty) this.flush()
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private load(): LearningSnapshot {
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, 'utf-8')
        const parsed: unknown = JSON.parse(raw)

        // Basic shape validation
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'version' in parsed &&
          (parsed as LearningSnapshot).version === 1
        ) {
          return parsed as LearningSnapshot
        }
      } catch {
        // Corrupted or unparseable file — start fresh
      }
    }
    return { ...EMPTY_SNAPSHOT, records: {}, profiles: {}, failurePatterns: {} }
  }

  private scheduleFlush(): void {
    this.flushTimer = setInterval(() => {
      if (this.dirty) this.flush()
    }, this.flushIntervalMs)
    // Allow the Node.js process to exit even if the timer is still active
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref()
    }
  }

  private flush(): void {
    this.data.exportedAt = Date.now()
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    this.dirty = false
  }
}
