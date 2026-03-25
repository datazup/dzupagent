/**
 * Sandbox reset strategies — control how a sandbox is cleaned
 * between reuses in the pool.
 *
 * - DockerResetStrategy: wipes /work and /tmp via exec, reusable
 * - CloudResetStrategy: cloud sandboxes cannot be reset, must be recreated
 */

import type { PooledSandbox } from './sandbox-pool.js'

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SandboxResetStrategy {
  /**
   * Attempt to reset a sandbox for reuse.
   * @returns true if the sandbox was successfully reset and can be reused,
   *          false if the sandbox should be destroyed and recreated.
   */
  reset(sandbox: PooledSandbox): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Docker reset — wipe workspace, keep container
// ---------------------------------------------------------------------------

export interface DockerResetConfig {
  /** Paths to wipe on reset (default: ['/work', '/tmp']) */
  wipePaths?: string[]
  /** Shell command runner — if not provided, always returns true */
  exec?: (sandboxId: string, command: string) => Promise<{ exitCode: number }>
}

export class DockerResetStrategy implements SandboxResetStrategy {
  private readonly wipePaths: string[]
  private readonly exec: ((sandboxId: string, command: string) => Promise<{ exitCode: number }>) | null

  constructor(config?: DockerResetConfig) {
    this.wipePaths = config?.wipePaths ?? ['/work', '/tmp']
    this.exec = config?.exec ?? null
  }

  async reset(sandbox: PooledSandbox): Promise<boolean> {
    if (!this.exec) {
      // No exec function provided — assume reset is always successful
      return true
    }

    try {
      const commands = this.wipePaths
        .map((p) => `rm -rf ${p}/* ${p}/.[!.]* 2>/dev/null || true`)
        .join(' && ')
      const result = await this.exec(sandbox.id, commands)
      return result.exitCode === 0
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Cloud reset — always returns false (cannot be reused)
// ---------------------------------------------------------------------------

export class CloudResetStrategy implements SandboxResetStrategy {
  /**
   * Cloud sandboxes (E2B, Fly, etc.) cannot be reset in-place.
   * Always returns false, signaling the pool to destroy and recreate.
   */
  async reset(_sandbox: PooledSandbox): Promise<boolean> {
    return false
  }
}
