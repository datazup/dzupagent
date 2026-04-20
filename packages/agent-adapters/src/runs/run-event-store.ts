/**
 * RunEventStore — persists raw, normalized, and artifact events for a single run.
 *
 * Layout:
 *   .dzupagent/runs/<runId>/
 *     raw-events.jsonl        — one RawAgentEvent per line
 *     normalized-events.jsonl — one AgentEvent per line
 *     artifacts.jsonl         — one AgentArtifactEvent per line
 *     summary.json            — RunSummary (written on close)
 */
import { mkdir, appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentEvent } from '../types.js'
import type { RawAgentEvent, AgentArtifactEvent, RunSummary } from '@dzupagent/adapter-types'

export type { RawAgentEvent, AgentArtifactEvent, RunSummary }

interface BufferedEntry {
  file: 'raw' | 'normalized' | 'artifact'
  line: string
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

  constructor({ runId, projectDir }: { runId: string; projectDir: string }) {
    this.runId = runId
    this.runDir = join(projectDir, 'runs', runId)
  }

  /** Create the run directory and flush any buffered events. */
  async open(): Promise<void> {
    try {
      await mkdir(this.runDir, { recursive: true })
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
  }

  /** Append a raw provider event. */
  async appendRaw(event: RawAgentEvent): Promise<void> {
    const line = JSON.stringify(event)
    if (!this.isOpen) {
      this.buffer.push({ file: 'raw', line })
      return
    }
    await this.writeLine('raw', line)
  }

  /** Append a normalized AgentEvent. */
  async appendNormalized(event: AgentEvent): Promise<void> {
    const line = JSON.stringify(event)
    if (!this.isOpen) {
      this.buffer.push({ file: 'normalized', line })
      return
    }
    await this.writeLine('normalized', line)
  }

  /** Append an artifact mutation event. */
  async appendArtifact(event: AgentArtifactEvent): Promise<void> {
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
