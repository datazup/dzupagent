/**
 * FileCheckpointStore -- File-system based persistence for workflow checkpoints.
 *
 * Stores each checkpoint as a JSON file under:
 *   {directory}/{workflowId}/v{version}.json
 *
 * Thread-safe for single-process use. For multi-process scenarios,
 * use a database-backed CheckpointStore instead.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { CheckpointStore, WorkflowCheckpoint } from '../session/workflow-checkpointer.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FileCheckpointStoreConfig {
  /** Directory to store checkpoint files. Default: '.dzupagent/checkpoints' */
  directory: string
  /** Whether to pretty-print JSON. Default false */
  prettyPrint?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Filename for a specific version: v3.json */
function versionFilename(version: number): string {
  return `v${String(version)}.json`
}

/** Extract the version number from a filename, or undefined if not a valid checkpoint file. */
function parseVersionFilename(filename: string): number | undefined {
  const match = /^v(\d+)\.json$/.exec(filename)
  if (!match) return undefined
  return Number(match[1])
}

/**
 * Reviver for JSON.parse that converts ISO date strings back to Date objects
 * for known date fields in WorkflowCheckpoint.
 */
function dateReviver(key: string, value: unknown): unknown {
  if (
    typeof value === 'string' &&
    (key === 'createdAt' || key === 'completedAt') &&
    /^\d{4}-\d{2}-\d{2}T/.test(value)
  ) {
    return new Date(value)
  }
  return value
}

// ---------------------------------------------------------------------------
// FileCheckpointStore
// ---------------------------------------------------------------------------

export class FileCheckpointStore implements CheckpointStore {
  private readonly directory: string
  private readonly prettyPrint: boolean

  constructor(config: FileCheckpointStoreConfig) {
    this.directory = config.directory
    this.prettyPrint = config.prettyPrint ?? false
  }

  /**
   * Persist a checkpoint to disk.
   * Creates the workflow directory if it does not exist.
   */
  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    const dir = path.join(this.directory, checkpoint.workflowId)
    await mkdir(dir, { recursive: true })

    const filePath = path.join(dir, versionFilename(checkpoint.version))
    const json = this.prettyPrint
      ? JSON.stringify(checkpoint, null, 2)
      : JSON.stringify(checkpoint)

    await writeFile(filePath, json, 'utf-8')
  }

  /**
   * Load a checkpoint from disk.
   * If version is omitted, loads the latest version.
   * Returns undefined if the workflow or version does not exist.
   */
  async load(workflowId: string, version?: number): Promise<WorkflowCheckpoint | undefined> {
    if (version !== undefined) {
      return this.loadVersion(workflowId, version)
    }

    // Find the latest version
    const versions = await this.listVersions(workflowId)
    if (versions.length === 0) return undefined

    const latest = versions[versions.length - 1]
    // latest is guaranteed to be a number since versions.length > 0
    return this.loadVersion(workflowId, latest!)
  }

  /**
   * List all persisted version numbers for a workflow, sorted ascending.
   * Returns an empty array if the workflow directory does not exist.
   */
  async listVersions(workflowId: string): Promise<number[]> {
    const dir = path.join(this.directory, workflowId)

    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return []
      }
      throw err
    }

    const versions: number[] = []
    for (const entry of entries) {
      const v = parseVersionFilename(entry)
      if (v !== undefined) {
        versions.push(v)
      }
    }

    return versions.sort((a, b) => a - b)
  }

  /**
   * Delete checkpoint(s) from disk.
   * If version is specified, deletes only that version file.
   * If version is omitted, deletes the entire workflow directory.
   */
  async delete(workflowId: string, version?: number): Promise<void> {
    const dir = path.join(this.directory, workflowId)

    if (version !== undefined) {
      const filePath = path.join(dir, versionFilename(version))
      try {
        await rm(filePath)
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          return // Already gone -- nothing to do
        }
        throw err
      }

      // Clean up the directory if it's now empty
      try {
        const remaining = await readdir(dir)
        if (remaining.length === 0) {
          await rm(dir, { recursive: true })
        }
      } catch {
        // Directory may have been removed concurrently -- ignore
      }
    } else {
      try {
        await rm(dir, { recursive: true })
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          return
        }
        throw err
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async loadVersion(
    workflowId: string,
    version: number,
  ): Promise<WorkflowCheckpoint | undefined> {
    const filePath = path.join(this.directory, workflowId, versionFilename(version))

    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return undefined
      }
      throw err
    }

    return JSON.parse(raw, dateReviver) as WorkflowCheckpoint
  }
}

// ---------------------------------------------------------------------------
// Utility type guard
// ---------------------------------------------------------------------------

interface NodeError extends Error {
  code?: string
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error
}
