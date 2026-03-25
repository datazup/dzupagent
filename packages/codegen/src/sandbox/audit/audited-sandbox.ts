/**
 * AuditedSandbox — decorator that wraps any SandboxProtocol implementation
 * and records all operations to a SandboxAuditStore.
 *
 * Features:
 * - Records execute, upload, download, cleanup as audit entries
 * - Redacts known secret patterns from command strings
 * - Provides getAuditTrail() to retrieve the full audit chain
 */

import type { SandboxProtocol, ExecOptions, ExecResult } from '../sandbox-protocol.js'
import type { SandboxAuditStore, SandboxAuditEntry } from './audit-types.js'

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  // API keys and tokens
  /(?:api[_-]?key|token|secret|password|passwd|auth)\s*[=:]\s*\S+/gi,
  // Bearer tokens
  /Bearer\s+\S+/gi,
  // AWS keys
  /AKIA[0-9A-Z]{16}/g,
  // Generic hex/base64 secrets (32+ chars)
  /(?:sk|pk|key|secret)[_-][a-zA-Z0-9]{32,}/g,
]

export function redactSecrets(input: string): string {
  let result = input
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0
    result = result.replace(pattern, '[REDACTED]')
  }
  return result
}

// ---------------------------------------------------------------------------
// AuditedSandbox
// ---------------------------------------------------------------------------

export interface AuditedSandboxConfig {
  /** The underlying sandbox to wrap */
  sandbox: SandboxProtocol
  /** Where to store audit entries */
  store: SandboxAuditStore
  /** Unique ID for this sandbox instance */
  sandboxId: string
  /** Optional run/session ID */
  runId?: string
}

export class AuditedSandbox implements SandboxProtocol {
  private readonly inner: SandboxProtocol
  private readonly store: SandboxAuditStore
  private readonly sandboxId: string
  private readonly runId: string | undefined

  constructor(config: AuditedSandboxConfig) {
    this.inner = config.sandbox
    this.store = config.store
    this.sandboxId = config.sandboxId
    this.runId = config.runId
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable()
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    const redactedCommand = redactSecrets(command)
    const result = await this.inner.execute(command, options)

    await this.record('execute', {
      command: redactedCommand,
      cwd: options?.cwd,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    })

    return result
  }

  async uploadFiles(files: Record<string, string>): Promise<void> {
    await this.inner.uploadFiles(files)

    await this.record('upload', {
      files: Object.keys(files),
      totalBytes: Object.values(files).reduce((sum, c) => sum + c.length, 0),
    })
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    const result = await this.inner.downloadFiles(paths)

    await this.record('download', {
      requestedPaths: paths,
      returnedPaths: Object.keys(result),
      totalBytes: Object.values(result).reduce((sum, c) => sum + c.length, 0),
    })

    return result
  }

  async cleanup(): Promise<void> {
    await this.inner.cleanup()

    await this.record('cleanup', {})
  }

  /** Retrieve the full audit trail for this sandbox. */
  async getAuditTrail(): Promise<SandboxAuditEntry[]> {
    return this.store.getBySandbox(this.sandboxId)
  }

  /** Verify the integrity of the audit chain. */
  async verifyAuditChain(): Promise<{ valid: boolean; brokenAt?: number }> {
    return this.store.verifyChain(this.sandboxId)
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async record(
    action: SandboxAuditEntry['action'],
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.store.append({
      id: `${this.sandboxId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sandboxId: this.sandboxId,
      runId: this.runId,
      action,
      details,
      timestamp: new Date(),
    })
  }
}
