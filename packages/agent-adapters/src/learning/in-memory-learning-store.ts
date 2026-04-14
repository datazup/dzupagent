/**
 * In-memory implementation of {@link LearningStore}.
 *
 * Uses plain arrays with a configurable per-provider capacity.
 * No persistence across restarts — useful for tests or short-lived processes.
 */

import type { ExecutionRecord, ProviderProfile, FailurePattern } from './adapter-learning-loop.js'
import type { LearningStore, LearningSnapshot } from './learning-store.js'

export class InMemoryLearningStore implements LearningStore {
  private readonly records = new Map<string, ExecutionRecord[]>()
  private readonly profiles = new Map<string, ProviderProfile>()
  private readonly patterns = new Map<string, FailurePattern[]>()
  private readonly capacityPerProvider: number

  constructor(capacityPerProvider: number = 500) {
    this.capacityPerProvider = capacityPerProvider
  }

  // -----------------------------------------------------------------------
  // Records
  // -----------------------------------------------------------------------

  saveRecord(providerId: string, record: ExecutionRecord): void {
    const arr = this.records.get(providerId) ?? []
    arr.push(record)
    while (arr.length > this.capacityPerProvider) arr.shift()
    this.records.set(providerId, arr)
  }

  loadRecords(providerId: string, limit: number): ExecutionRecord[] {
    const arr = this.records.get(providerId) ?? []
    return arr.slice(-limit)
  }

  // -----------------------------------------------------------------------
  // Profiles
  // -----------------------------------------------------------------------

  saveProfile(providerId: string, profile: ProviderProfile): void {
    this.profiles.set(providerId, profile)
  }

  getProfile(providerId: string): ProviderProfile | undefined {
    return this.profiles.get(providerId)
  }

  // -----------------------------------------------------------------------
  // Failure patterns
  // -----------------------------------------------------------------------

  saveFailurePatterns(providerId: string, patterns: FailurePattern[]): void {
    this.patterns.set(providerId, patterns)
  }

  getFailurePatterns(providerId: string): FailurePattern[] {
    return this.patterns.get(providerId) ?? []
  }

  // -----------------------------------------------------------------------
  // Export / Import
  // -----------------------------------------------------------------------

  exportAll(): LearningSnapshot {
    const records: Record<string, ExecutionRecord[]> = {}
    for (const [id, arr] of this.records) {
      records[id] = [...arr]
    }

    const profiles: Record<string, ProviderProfile> = {}
    for (const [id, profile] of this.profiles) {
      profiles[id] = profile
    }

    const failurePatterns: Record<string, FailurePattern[]> = {}
    for (const [id, pats] of this.patterns) {
      failurePatterns[id] = [...pats]
    }

    return {
      version: 1,
      exportedAt: Date.now(),
      records,
      profiles,
      failurePatterns,
    }
  }

  importAll(snapshot: LearningSnapshot): void {
    this.records.clear()
    this.profiles.clear()
    this.patterns.clear()

    for (const [id, arr] of Object.entries(snapshot.records)) {
      this.records.set(id, [...arr])
    }

    for (const [id, profile] of Object.entries(snapshot.profiles)) {
      this.profiles.set(id, profile)
    }

    for (const [id, pats] of Object.entries(snapshot.failurePatterns)) {
      this.patterns.set(id, [...pats])
    }
  }

  // -----------------------------------------------------------------------
  // Compaction
  // -----------------------------------------------------------------------

  compact(maxRecordsPerProvider: number): { removedCount: number } {
    let removedCount = 0
    for (const [id, arr] of this.records) {
      if (arr.length > maxRecordsPerProvider) {
        const excess = arr.length - maxRecordsPerProvider
        arr.splice(0, excess)
        removedCount += excess
        this.records.set(id, arr)
      }
    }
    return { removedCount }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  dispose(): void {
    // No-op for in-memory store.
  }
}
