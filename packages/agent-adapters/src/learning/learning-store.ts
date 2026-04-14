/**
 * Persistent storage backend interface for adapter learning data.
 *
 * Decouples learning data from the in-memory `AdapterLearningLoop` so that
 * execution records, provider profiles, and failure patterns survive process
 * restarts.
 */

import type { ExecutionRecord, ProviderProfile, FailurePattern } from './adapter-learning-loop.js'

// ---------------------------------------------------------------------------
// Snapshot (export / import)
// ---------------------------------------------------------------------------

/** Snapshot for export/import of all learning data. */
export interface LearningSnapshot {
  version: 1
  exportedAt: number
  records: Record<string, ExecutionRecord[]>
  profiles: Record<string, ProviderProfile>
  failurePatterns: Record<string, FailurePattern[]>
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/** Persistent storage backend for learning data. */
export interface LearningStore {
  /** Append an execution record for a provider. */
  saveRecord(providerId: string, record: ExecutionRecord): void

  /** Load the most recent `limit` records for a provider (oldest-first). */
  loadRecords(providerId: string, limit: number): ExecutionRecord[]

  /** Upsert a computed provider profile. */
  saveProfile(providerId: string, profile: ProviderProfile): void

  /** Retrieve the stored profile for a provider, if any. */
  getProfile(providerId: string): ProviderProfile | undefined

  /** Replace stored failure patterns for a provider. */
  saveFailurePatterns(providerId: string, patterns: FailurePattern[]): void

  /** Retrieve stored failure patterns for a provider. */
  getFailurePatterns(providerId: string): FailurePattern[]

  /** Export all data as a portable snapshot. */
  exportAll(): LearningSnapshot

  /** Import a snapshot, replacing current data. */
  importAll(snapshot: LearningSnapshot): void

  /** Remove old records, keeping at most `maxRecordsPerProvider` per provider. */
  compact(maxRecordsPerProvider: number): { removedCount: number }

  /** Release resources (timers, file handles, etc.). */
  dispose(): void
}
