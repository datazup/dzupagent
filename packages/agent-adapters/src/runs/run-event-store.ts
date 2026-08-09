/**
 * RunEventStore — persists raw, normalized, and artifact events for a single run.
 *
 * Layout: <projectDir>/.dzupagent/runs/<runId>/
 *   raw-events.jsonl        — one RawAgentEvent per line
 *   normalized-events.jsonl — one AgentEvent per line
 *   artifacts.jsonl         — one AgentArtifactEvent per line
 *   summary.json            — RunSummary (written on close)
 *
 * Path is derived via runLogRoot() so that replay endpoints share the same contract.
 */
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runLogRoot } from './run-log-root.js'

import type { AgentEvent } from '../types.js'
import type { RawAgentEvent, AgentArtifactEvent, RunSummary } from '@dzupagent/adapter-types'

export type { RawAgentEvent, AgentArtifactEvent, RunSummary }

interface BufferedEntry {
  file: 'raw' | 'normalized' | 'artifact'
  line: string
}

export interface RetainedNormalizedEventRecord {
  /** Stable identity of this physical JSONL occurrence within the run store. */
  occurrenceId: string
  event: AgentEvent
}

/**
 * Manages the `.dzupagent/runs/<runId>/` folder layout and writes JSONL files.
 *
 * All append methods are safe to call before `open()` — events are buffered
 * in memory and flushed when `open()` is called.
 *
 * Disk errors (full disk, missing folder) are caught and emitted as warnings
 * to stderr — the class never throws to the caller.
 */
export class RunEventStore {
  private readonly runId: string
  private readonly runDir: string
  private isOpen = false
  private buffer: BufferedEntry[] = []
  private readonly counts = { rawEventCount: 0, normalizedEventCount: 0, artifactCount: 0 }
  private readonly countListeners = new Set<() => void>()

  constructor({ runId, projectDir }: { runId: string; projectDir: string }) {
    this.runId = runId
    this.runDir = runLogRoot(projectDir, runId)
  }

  /** Create the run directory and flush any buffered events. */
  async open(): Promise<void> {
    if (this.isOpen) return
    const bufferedCounts = { ...this.counts }
    try {
      await mkdir(this.runDir, { recursive: true })
      const [raw, normalized, artifact] = await Promise.all([
        this.countRetainedLines('raw'),
        this.countRetainedLines('normalized'),
        this.countRetainedLines('artifact'),
      ])
      this.counts.rawEventCount = raw + bufferedCounts.rawEventCount
      this.counts.normalizedEventCount = normalized + bufferedCounts.normalizedEventCount
      this.counts.artifactCount = artifact + bufferedCounts.artifactCount
      this.isOpen = true
    } catch (err: unknown) {
      process.stderr.write(
        `[RunEventStore] Failed to create run directory ${this.runDir}: ${String(err)}\n`,
      )
      // Even on error, mark open so we attempt flushes (they will fail gracefully)
      this.isOpen = true
    }

    // Flush buffered entries
    const buffered = this.buffer.splice(0)
    for (const entry of buffered) {
      await this.writeLine(entry.file, entry.line)
    }
    this.notifyCountsChanged()
  }

  /** Append a raw provider event. */
  async appendRaw(event: RawAgentEvent): Promise<void> {
    this.counts.rawEventCount += 1
    this.notifyCountsChanged()
    const line = JSON.stringify(event)
    if (!this.isOpen) {
      this.buffer.push({ file: 'raw', line })
      return
    }
    await this.writeLine('raw', line)
  }

  /** Append a normalized AgentEvent. */
  async appendNormalized(event: AgentEvent): Promise<void> {
    this.counts.normalizedEventCount += 1
    this.notifyCountsChanged()
    const line = JSON.stringify(event)
    if (!this.isOpen) {
      this.buffer.push({ file: 'normalized', line })
      return
    }
    await this.writeLine('normalized', line)
  }

  /** Append an artifact mutation event. */
  async appendArtifact(event: AgentArtifactEvent): Promise<void> {
    this.counts.artifactCount += 1
    this.notifyCountsChanged()
    const line = JSON.stringify(event)
    if (!this.isOpen) {
      this.buffer.push({ file: 'artifact', line })
      return
    }
    await this.writeLine('artifact', line)
  }

  /** Write the run summary and complete the store. */
  async close(summary: RunSummary): Promise<void> {
    const summaryPath = join(this.runDir, 'summary.json')
    try {
      await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
    } catch (err: unknown) {
      process.stderr.write(
        `[RunEventStore] Failed to write summary for run ${this.runId}: ${String(err)}\n`,
      )
    }
  }

  /** Synchronous live counters used by dashboard projections without file-system reads. */
  getCounts(): Readonly<{
    rawEventCount: number
    normalizedEventCount: number
    artifactCount: number
  }> {
    return { ...this.counts }
  }

  /** Subscribe to counter changes. The returned cleanup is idempotent. */
  onCountsChanged(listener: () => void): () => void {
    this.countListeners.add(listener)
    return () => this.countListeners.delete(listener)
  }

  /** Stable run identity used by retained dashboard replay adapters. */
  getRunId(): string {
    return this.runId
  }

  /**
   * Read the retained normalized stream in file order.
   *
   * Invalid or partial trailing records are ignored because a process may die
   * between the append and filesystem completion. The caller rebuilds derived
   * state from the complete records that remain.
   */
  async readNormalizedEvents(): Promise<AgentEvent[]> {
    return (await this.readNormalizedEventRecords()).map((record) => record.event)
  }

  /**
   * Read retained normalized events with a stable identity per physical line.
   *
   * Event-content hashes cannot distinguish two legitimate identical tool
   * calls. The zero-based JSONL line position is stable across repeated reads
   * and remains distinct for identical records. Invalid/partial lines still
   * consume their position so a later valid record never changes identity.
   */
  async readNormalizedEventRecords(): Promise<RetainedNormalizedEventRecord[]> {
    try {
      const content = await readFile(join(this.runDir, this.fileNameFor('normalized')), 'utf8')
      const records: RetainedNormalizedEventRecord[] = []
      for (const [lineIndex, line] of content.split('\n').entries()) {
        if (line.trim().length === 0) continue
        try {
          records.push({
            occurrenceId: `normalized:${lineIndex}`,
            event: JSON.parse(line) as AgentEvent,
          })
        } catch {
          // Retained repair is best-effort and must not invent a record from a
          // partial line left by process death.
        }
      }
      return records
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      process.stderr.write(
        `[RunEventStore] Failed to read normalized events for run ${this.runId}: ${String(error)}\n`,
      )
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private fileNameFor(file: 'raw' | 'normalized' | 'artifact'): string {
    switch (file) {
      case 'raw':
        return 'raw-events.jsonl'
      case 'normalized':
        return 'normalized-events.jsonl'
      case 'artifact':
        return 'artifacts.jsonl'
    }
  }

  private notifyCountsChanged(): void {
    for (const listener of [...this.countListeners]) listener()
  }

  private async countRetainedLines(file: 'raw' | 'normalized' | 'artifact'): Promise<number> {
    try {
      const content = await readFile(join(this.runDir, this.fileNameFor(file)), 'utf8')
      return content.split('\n').filter((line) => line.trim().length > 0).length
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      process.stderr.write(
        `[RunEventStore] Failed to count ${this.fileNameFor(file)} for run ${this.runId}: ${String(error)}\n`,
      )
      return 0
    }
  }

  private async writeLine(file: 'raw' | 'normalized' | 'artifact', line: string): Promise<void> {
    const filePath = join(this.runDir, this.fileNameFor(file))
    try {
      await appendFile(filePath, line + '\n', 'utf8')
    } catch (err: unknown) {
      process.stderr.write(
        `[RunEventStore] Failed to append to ${this.fileNameFor(file)} for run ${this.runId}: ${String(err)}\n`,
      )
    }
  }
}
