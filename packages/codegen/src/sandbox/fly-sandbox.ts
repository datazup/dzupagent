/**
 * Fly.io Machines sandbox — creates on-demand VMs for command execution.
 * Uses Fly Machines REST API directly.
 */

import { posix as posixPath } from 'node:path'

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

/**
 * Constant shell script used to write an uploaded file. All model-controlled
 * values (file path, file content) are passed as positional arguments — `$1`
 * (path) and `$2` (base64 content) — so shell metacharacters within them are
 * never interpreted. Invoked as: sh -c SCRIPT <argv0> <path> <base64>.
 */
const WRITE_FILE_SCRIPT =
  'mkdir -p "$(dirname "$1")" && printf %s "$2" | base64 -d > "$1"'

/**
 * Reject model-controlled paths that would escape the sandbox workspace before
 * they are handed to any file operation. Absolute paths and `..` traversal are
 * refused; the returned value is a normalized, workspace-relative path. This is
 * defense-in-depth on top of the argv-based exec (which already prevents shell
 * injection): even without a shell, an unguarded `../../etc/passwd` write would
 * still touch the host filesystem inside the machine.
 */
function assertSafeSandboxPath(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error(`Invalid sandbox path: ${JSON.stringify(filePath)}`)
  }
  if (posixPath.isAbsolute(filePath)) {
    throw new Error(`Absolute paths are not allowed in the sandbox: "${filePath}"`)
  }
  // Normalize using POSIX semantics (the sandbox is a Linux machine). A leading
  // `..` segment after normalization means the path escapes the workspace root.
  const normalized = posixPath.normalize(filePath)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path traversal detected: "${filePath}" escapes the sandbox workspace`)
  }
  return normalized
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
    // Write files without ever interpolating the model-controlled path or
    // content into a shell string. The script below is a compile-time constant;
    // `filePath` and the base64-encoded content are only ever passed as
    // positional arguments ($1/$2), so shell metacharacters in them are inert.
    for (const [filePath, content] of Object.entries(files)) {
      const safePath = assertSafeSandboxPath(filePath)
      const base64Content = Buffer.from(content, 'utf8').toString('base64')
      const execResult = await this.execArgv([
        'sh',
        '-c',
        WRITE_FILE_SCRIPT,
        'write-file',
        safePath,
        base64Content,
      ])
      if (execResult.exitCode !== 0) {
        throw new Error(
          `Fly uploadFiles failed for '${filePath}' (exit ${execResult.exitCode}): ${execResult.stderr}`,
        )
      }
    }
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    this.assertReady()
    const result: Record<string, string> = {}
    for (const filePath of paths) {
      const safePath = assertSafeSandboxPath(filePath)
      // `cat` is invoked directly as argv; the path is a positional argument,
      // never spliced into a shell command line.
      const execResult = await this.execArgv(['cat', safePath])
      if (execResult.exitCode === 0) {
        // Key results by the caller-supplied path for a stable contract.
        result[filePath] = execResult.stdout
      }
    }
    return result
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    // A caller-supplied `command` is an opaque shell command line, so it is
    // wrapped in `sh -c` by design. File operations (uploadFiles/downloadFiles)
    // must NOT route through here — they use execArgv() to avoid interpolating
    // model-controlled paths into a shell string (CWE-78).
    return this.execArgv(['sh', '-c', command], options)
  }

  /**
   * Execute a raw argv array in the sandbox with no shell wrapping added by
   * this method. The array is sent verbatim to the Fly exec API, so each
   * element is a distinct argument — path/content values placed as positional
   * arguments cannot break out into command injection.
   */
  private async execArgv(cmd: string[], options?: ExecOptions): Promise<ExecResult> {
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
            cmd,
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
      const fetchInit: RequestInit = {
        method: opts.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
        },
        signal: controller.signal,
      }
      if (opts.body !== undefined) fetchInit.body = opts.body
      // eslint-disable-next-line no-restricted-globals -- intentional: fly.io control-plane endpoint configured by operator, not user input
      return await fetch(`${this.baseUrl}${path}`, fetchInit)
    } finally {
      clearTimeout(timer)
    }
  }
}
