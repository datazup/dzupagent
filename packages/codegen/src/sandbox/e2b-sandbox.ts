/**
 * E2B cloud sandbox — runs commands in managed cloud containers.
 * Uses E2B REST API directly (no SDK dependency).
 */

import type { SandboxProtocol, ExecResult, ExecOptions } from './sandbox-protocol.js'

export interface E2BSandboxConfig {
  /** E2B API key */
  apiKey: string
  /** E2B template ID (default: 'base') */
  template?: string
  /** Timeout per command in ms (default: 30_000) */
  timeoutMs?: number
  /** API base URL (default: 'https://api.e2b.dev') */
  baseUrl?: string
}

interface E2BCreateResponse {
  sandboxID: string
}

interface E2BExecResponse {
  exitCode: number
  stdout: string
  stderr: string
}

const DEFAULT_TEMPLATE = 'base'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_BASE_URL = 'https://api.e2b.dev'

export class E2BSandbox implements SandboxProtocol {
  private sandboxId: string | null = null
  private readonly apiKey: string
  private readonly template: string
  private readonly timeoutMs: number
  private readonly baseUrl: string

  constructor(config: E2BSandboxConfig) {
    this.apiKey = config.apiKey
    this.template = config.template ?? DEFAULT_TEMPLATE
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  }

  get isReady(): boolean {
    return this.sandboxId !== null
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.apiFetch('/health', { method: 'GET', timeoutMs: 5000 })
      return res.ok
    } catch {
      return false
    }
  }

  async uploadFiles(files: Record<string, string>): Promise<void> {
    this.assertReady()
    for (const [filePath, content] of Object.entries(files)) {
      await this.apiFetch(`/sandboxes/${this.sandboxId}/files`, {
        method: 'POST',
        body: JSON.stringify({ path: filePath, content }),
        timeoutMs: this.timeoutMs,
      })
    }
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    this.assertReady()
    const result: Record<string, string> = {}
    for (const filePath of paths) {
      try {
        const res = await this.apiFetch(
          `/sandboxes/${this.sandboxId}/files?path=${encodeURIComponent(filePath)}`,
          { method: 'GET', timeoutMs: this.timeoutMs },
        )
        if (res.ok) {
          const data = (await res.json()) as { content: string }
          result[filePath] = data.content
        }
      } catch {
        // File not found or not readable — skip
      }
    }
    return result
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.sandboxId) {
      await this.init()
    }

    const timeout = options?.timeoutMs ?? this.timeoutMs
    try {
      const res = await this.apiFetch(`/sandboxes/${this.sandboxId}/commands`, {
        method: 'POST',
        body: JSON.stringify({
          cmd: command,
          cwd: options?.cwd ?? '/home/user',
          timeout: Math.ceil(timeout / 1000),
        }),
        timeoutMs: timeout + 5000, // extra buffer for HTTP overhead
      })

      if (!res.ok) {
        const text = await res.text()
        return { exitCode: 1, stdout: '', stderr: `E2B API error (${res.status}): ${text}`, timedOut: false }
      }

      const data = (await res.json()) as E2BExecResponse
      return { exitCode: data.exitCode, stdout: data.stdout, stderr: data.stderr, timedOut: false }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { exitCode: 124, stdout: '', stderr: 'Command timed out', timedOut: true }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { exitCode: 1, stdout: '', stderr: `E2B fetch error: ${msg}`, timedOut: false }
    }
  }

  async cleanup(): Promise<void> {
    if (!this.sandboxId) return
    try {
      await this.apiFetch(`/sandboxes/${this.sandboxId}`, {
        method: 'DELETE',
        timeoutMs: 10_000,
      })
    } catch {
      // Best-effort cleanup
    }
    this.sandboxId = null
  }

  /** Create the sandbox instance via API. */
  private async init(): Promise<void> {
    const res = await this.apiFetch('/sandboxes', {
      method: 'POST',
      body: JSON.stringify({ template: this.template }),
      timeoutMs: this.timeoutMs,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`E2B sandbox creation failed (${res.status}): ${text}`)
    }
    const data = (await res.json()) as E2BCreateResponse
    this.sandboxId = data.sandboxID
  }

  private assertReady(): void {
    if (!this.sandboxId) {
      throw new Error('E2B sandbox not initialized. Call execute() or init() first.')
    }
  }

  private async apiFetch(
    path: string,
    opts: { method: string; body?: string; timeoutMs: number },
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: opts.method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: opts.body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
