/**
 * WorkspaceRunner: bridges VirtualFS snapshots to sandbox execution.
 *
 * Materializes VFS content into a SandboxProtocol-compatible sandbox,
 * runs commands, and optionally syncs modified files back to the VFS.
 */

import type { VirtualFS } from './virtual-fs.js'
import type { SandboxProtocol, ExecResult, ExecOptions } from '../sandbox/sandbox-protocol.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a workspace command execution */
export interface WorkspaceRunResult {
  /** Whether the command exited with code 0 */
  success: boolean
  /** Exit code */
  exitCode: number
  /** Stdout content */
  stdout: string
  /** Stderr content */
  stderr: string
  /** Whether the command timed out */
  timedOut: boolean
  /** Execution duration in ms */
  durationMs: number
  /** Files that were modified by the command (if syncBack enabled) */
  modifiedFiles?: string[]
}

/** Options for workspace execution */
export interface WorkspaceRunOptions {
  /** Command to execute (including arguments) */
  command: string
  /** Working directory within the workspace. Default: '/' */
  cwd?: string
  /** Timeout in ms. Default: 60_000 */
  timeoutMs?: number
  /** Sync modified files back to VFS after execution. Default: false */
  syncBack?: boolean
  /**
   * File paths to check for modifications when syncing back.
   * Required when syncBack is true since SandboxProtocol does not
   * provide a listModifiedFiles method. If omitted and syncBack is true,
   * all VFS file paths are checked.
   */
  syncPaths?: string[]
}

// ---------------------------------------------------------------------------
// WorkspaceRunner
// ---------------------------------------------------------------------------

/**
 * Bridges VirtualFS snapshots to sandbox execution.
 *
 * Workflow:
 * 1. Takes a snapshot of the VFS
 * 2. Uploads files to the sandbox via SandboxProtocol.uploadFiles
 * 3. Executes the command via SandboxProtocol.execute
 * 4. Optionally downloads files and syncs changes back to the VFS
 */
export class WorkspaceRunner {
  constructor(private readonly sandbox: SandboxProtocol) {}

  /**
   * Execute a command against a VFS snapshot.
   */
  async run(vfs: VirtualFS, options: WorkspaceRunOptions): Promise<WorkspaceRunResult> {
    const startTime = Date.now()

    // 1. Snapshot VFS and upload to sandbox
    const snapshot = vfs.toSnapshot()
    await this.sandbox.uploadFiles(snapshot)

    // 2. Execute command
    let result: ExecResult
    try {
      const execOpts: ExecOptions = { timeoutMs: options.timeoutMs ?? 60_000 }
      if (options.cwd !== undefined) execOpts.cwd = options.cwd
      result = await this.sandbox.execute(options.command, execOpts)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: `Sandbox execution error: ${message}`,
        timedOut: false,
        durationMs: Date.now() - startTime,
      }
    }

    // 3. Sync back if requested
    let modifiedFiles: string[] | undefined
    if (options.syncBack) {
      modifiedFiles = await this.syncBack(vfs, snapshot, options.syncPaths)
    }

    const runResult: WorkspaceRunResult = {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      durationMs: Date.now() - startTime,
    }
    if (modifiedFiles !== undefined) runResult.modifiedFiles = modifiedFiles
    return runResult
  }

  /**
   * Download files from the sandbox and write changed ones back to VFS.
   * Returns the list of file paths that were actually modified.
   */
  private async syncBack(
    vfs: VirtualFS,
    originalSnapshot: Record<string, string>,
    syncPaths?: string[],
  ): Promise<string[]> {
    const pathsToCheck = syncPaths ?? Object.keys(originalSnapshot)
    if (pathsToCheck.length === 0) return []

    const downloaded = await this.sandbox.downloadFiles(pathsToCheck)
    const modified: string[] = []

    for (const [path, content] of Object.entries(downloaded)) {
      if (originalSnapshot[path] !== content) {
        vfs.write(path, content)
        modified.push(path)
      }
    }

    return modified
  }

  /** Check if the sandbox backend is available */
  async isAvailable(): Promise<boolean> {
    return this.sandbox.isAvailable()
  }

  /** Clean up sandbox resources */
  async cleanup(): Promise<void> {
    await this.sandbox.cleanup()
  }
}
