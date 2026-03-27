/**
 * Fly.io Machines sandbox — creates on-demand VMs for command execution.
 * Uses Fly Machines REST API directly.
 */

import type { SandboxProtocol, ExecResult, ExecOptions } from './sandbox-protocol.js'

export interface FlySandboxConfig {
  /** Fly.io API token */
  apiToken: string
  /** Fly app name */
  appName: string
  /** Machine image (default: 'node:20-slim') */
  image?: string
  /** Region (default: 'iad') */
  region?: string
  /** Timeout per command in ms (default: 30_000) */
  timeoutMs?: number
  /** API base URL (default: 'https://api.machines.dev') */
  baseUrl?: string
}

interface FlyMachineResponse {
  id: string
  state: string
}

interface FlyExecResponse {
  exit_code: number
  stdout: string
  stderr: string
}

const DEFAULT_IMAGE = 'node:20-slim'
const DEFAULT_REGION = 'iad'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_BASE_URL = 'https://api.machines.dev'

export class FlySandbox implements SandboxProtocol {
  private machineId: string | null = null
  private readonly apiToken: string
  private readonly appName: string
  private readonly image: string
  private readonly region: string
  private readonly timeoutMs: number
  private readonly baseUrl: string

  constructor(config: FlySandboxConfig) {
    this.apiToken = config.apiToken
    this.appName = config.appName
    this.image = config.image ?? DEFAULT_IMAGE
    this.region = config.region ?? DEFAULT_REGION
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  }

  get isReady(): boolean {
    return this.machineId !== null
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.apiFetch(`/v1/apps/${this.appName}`, {
        method: 'GET',
        timeoutMs: 5000,
      })
      return res.ok
    } catch {
      return false
    }
  }

  async uploadFiles(files: Record<string, string>): Promise<void> {
    this.assertReady()
    // Upload by writing files via exec commands
    for (const [filePath, content] of Object.entries(files)) {
      const escaped = content.replace(/'/g, "'\\''")
      await this.execute(`mkdir -p "$(dirname '${filePath}')" && printf '%s' '${escaped}' > '${filePath}'`)
    }
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    this.assertReady()
    const result: Record<string, string> = {}
    for (const filePath of paths) {
      const execResult = await this.execute(`cat '${filePath}'`)
      if (execResult.exitCode === 0) {
        result[filePath] = execResult.stdout
      }
    }
    return result
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.machineId) {
      await this.init()
    }

    const timeout = options?.timeoutMs ?? this.timeoutMs
    try {
      const res = await this.apiFetch(
        `/v1/apps/${this.appName}/machines/${this.machineId}/exec`,
        {
          method: 'POST',
          body: JSON.stringify({
            cmd: ['sh', '-c', command],
            timeout: Math.ceil(timeout / 1000),
            ...(options?.cwd ? { working_dir: options.cwd } : {}),
          }),
          timeoutMs: timeout + 5000,
        },
      )

      if (!res.ok) {
        const text = await res.text()
        return { exitCode: 1, stdout: '', stderr: `Fly API error (${res.status}): ${text}`, timedOut: false }
      }

      const data = (await res.json()) as FlyExecResponse
      return { exitCode: data.exit_code, stdout: data.stdout, stderr: data.stderr, timedOut: false }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { exitCode: 124, stdout: '', stderr: 'Command timed out', timedOut: true }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { exitCode: 1, stdout: '', stderr: `Fly fetch error: ${msg}`, timedOut: false }
    }
  }

  async cleanup(): Promise<void> {
    if (!this.machineId) return
    try {
      // Stop the machine, then delete it
      await this.apiFetch(
        `/v1/apps/${this.appName}/machines/${this.machineId}/stop`,
        { method: 'POST', timeoutMs: 10_000 },
      )
      await this.apiFetch(
        `/v1/apps/${this.appName}/machines/${this.machineId}`,
        { method: 'DELETE', timeoutMs: 10_000 },
      )
    } catch {
      // Best-effort cleanup
    }
    this.machineId = null
  }

  /** Create a Fly Machine via API. */
  private async init(): Promise<void> {
    const res = await this.apiFetch(`/v1/apps/${this.appName}/machines`, {
      method: 'POST',
      body: JSON.stringify({
        region: this.region,
        config: {
          image: this.image,
          auto_destroy: true,
          restart: { policy: 'no' },
          guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
        },
      }),
      timeoutMs: this.timeoutMs,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Fly machine creation failed (${res.status}): ${text}`)
    }

    const data = (await res.json()) as FlyMachineResponse
    this.machineId = data.id

    // Wait for the machine to start
    await this.waitForState('started')
  }

  private async waitForState(targetState: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      const res = await this.apiFetch(
        `/v1/apps/${this.appName}/machines/${this.machineId}/wait?state=${targetState}&timeout=10`,
        { method: 'GET', timeoutMs: 15_000 },
      )
      if (res.ok) return
    }
    throw new Error(`Fly machine did not reach state '${targetState}' within timeout`)
  }

  private assertReady(): void {
    if (!this.machineId) {
      throw new Error('Fly sandbox not initialized. Call execute() or init() first.')
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
          Authorization: `Bearer ${this.apiToken}`,
        },
        body: opts.body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
