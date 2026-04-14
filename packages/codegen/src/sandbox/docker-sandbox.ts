/**
 * Docker-based sandbox for running commands in an isolated container.
 * Extracted from apps/api sandbox-runner.ts and adapted to SandboxProtocol.
 *
 * Security: --network=none, --read-only, --security-opt=no-new-privileges, --tmpfs
 *
 * Preview mode: When `previewMode: true`, relaxes network and filesystem
 * restrictions to allow dev-server workflows while keeping other security
 * flags (memory, cpu, no-new-privileges).
 *
 * Implements SandboxProtocolV2 for long-lived session management,
 * streaming execution, and port exposure.
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import type { ExecResult, ExecOptions } from './sandbox-protocol.js'
import type { SandboxProtocolV2, SessionOptions, ExecEvent } from './sandbox-protocol-v2.js'

const execFileAsync = promisify(execFile)

export interface DockerSandboxConfig {
  /** Docker image to use (default: 'node:20-slim') */
  image?: string
  /** Global timeout in ms (default: 60000) */
  timeoutMs?: number
  /** Memory limit e.g. '512m' (default: '512m') */
  memoryLimit?: string
  /** CPU limit e.g. '1.0' (default: '1.0') */
  cpuLimit?: string
  /**
   * When true, relaxes network and filesystem restrictions for preview/dev
   * workflows. Network is allowed, workspace is read-write.
   * Security flags (memory, cpu, no-new-privileges) are kept.
   * Default: false (secure/validation mode).
   */
  previewMode?: boolean
}

const DEFAULT_IMAGE = 'node:20-slim'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MEMORY = '512m'
const DEFAULT_CPU = '1.0'

export class DockerSandbox implements SandboxProtocolV2 {
  private readonly image: string
  private readonly timeoutMs: number
  private readonly memoryLimit: string
  private readonly cpuLimit: string
  private readonly previewMode: boolean
  private tempDir: string | null = null

  constructor(config?: DockerSandboxConfig) {
    this.image = config?.image ?? DEFAULT_IMAGE
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.memoryLimit = config?.memoryLimit ?? DEFAULT_MEMORY
    this.cpuLimit = config?.cpuLimit ?? DEFAULT_CPU
    this.previewMode = config?.previewMode ?? false
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['info'], { timeout: 5000 })
      return true
    } catch {
      return false
    }
  }

  async uploadFiles(files: Record<string, string>): Promise<void> {
    if (!this.tempDir) {
      this.tempDir = await mkdtemp(join(tmpdir(), 'forge-sandbox-'))
    }
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = this.safePath(filePath)
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
    }
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    if (!this.tempDir) {
      return {}
    }
    const result: Record<string, string> = {}
    for (const filePath of paths) {
      const fullPath = this.safePath(filePath)
      try {
        result[filePath] = await readFile(fullPath, 'utf-8')
      } catch {
        // File does not exist or not readable — skip
      }
    }
    return result
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.tempDir) {
      this.tempDir = await mkdtemp(join(tmpdir(), 'forge-sandbox-'))
    }

    const timeout = options?.timeoutMs ?? this.timeoutMs
    const cwd = options?.cwd ?? '/work'
    const dockerArgs = this.buildRunArgs(cwd, command)

    let timedOut = false
    try {
      const { stdout, stderr } = await execFileAsync('docker', dockerArgs, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      })
      return { exitCode: 0, stdout, stderr, timedOut: false }
    } catch (err: unknown) {
      const execErr = err as Error & {
        code?: number | string
        stdout?: string
        stderr?: string
        killed?: boolean
      }
      if (execErr.killed === true) {
        timedOut = true
      }
      return {
        exitCode: typeof execErr.code === 'number' ? execErr.code : 1,
        stdout: execErr.stdout ?? '',
        stderr: execErr.stderr ?? '',
        timedOut,
      }
    }
  }

  async cleanup(): Promise<void> {
    if (this.tempDir) {
      await rm(this.tempDir, { recursive: true, force: true })
      this.tempDir = null
    }
  }

  // ---------------------------------------------------------------------------
  // SandboxProtocolV2 — session management
  // ---------------------------------------------------------------------------

  async startSession(opts?: SessionOptions): Promise<{ sessionId: string }> {
    if (!this.tempDir) {
      this.tempDir = await mkdtemp(join(tmpdir(), 'forge-sandbox-'))
    }

    const sessionId = `forge-session-${randomUUID()}`
    const timeout = opts?.timeoutMs ?? this.timeoutMs

    const dockerArgs = this.buildSessionArgs(sessionId, opts?.envVars)

    // Start a detached container that stays alive
    await execFileAsync('docker', dockerArgs, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    })

    return { sessionId }
  }

  async *executeStream(
    sessionId: string,
    command: string,
    opts?: ExecOptions,
  ): AsyncGenerator<ExecEvent> {
    const timeout = opts?.timeoutMs ?? this.timeoutMs
    const cwd = opts?.cwd ?? '/work'

    const child = spawn('docker', [
      'exec',
      '-w', cwd,
      sessionId,
      'sh', '-c', command,
    ])

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeout)

    try {
      // Set encoding on streams
      if (child.stdout) {
        child.stdout.setEncoding('utf-8')
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf-8')
      }

      // Collect events from both streams via a queue
      const events: ExecEvent[] = []
      let resolveWait: (() => void) | null = null
      let done = false

      const push = (event: ExecEvent): void => {
        events.push(event)
        if (resolveWait) {
          const r = resolveWait
          resolveWait = null
          r()
        }
      }

      child.stdout?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.length > 0) {
            push({ type: 'stdout', data: line })
          }
        }
      })

      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.length > 0) {
            push({ type: 'stderr', data: line })
          }
        }
      })

      child.on('close', (code) => {
        push({ type: 'exit', exitCode: code ?? 1, timedOut })
        done = true
      })

      child.on('error', () => {
        push({ type: 'exit', exitCode: 1, timedOut })
        done = true
      })

      // Yield events as they arrive
      while (!done || events.length > 0) {
        if (events.length > 0) {
          yield events.shift()!
        } else if (!done) {
          await new Promise<void>((r) => {
            resolveWait = r
          })
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async exposePort(_sessionId: string, port: number): Promise<{ url: string }> {
    // For local Docker, the container port is accessible on localhost
    // when not in --network=none mode (i.e. previewMode is true).
    // Full port-mapping support would require -p flags at startSession time;
    // for now, return the direct localhost URL.
    return { url: `http://localhost:${port}` }
  }

  async stopSession(sessionId: string): Promise<void> {
    try {
      await execFileAsync('docker', ['stop', sessionId], { timeout: 15_000 })
    } catch {
      // Container may already be stopped
    }
    try {
      await execFileAsync('docker', ['rm', sessionId], { timeout: 10_000 })
    } catch {
      // Container may already be removed
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve a relative path within the temp directory, guarding against
   * path traversal attacks (e.g. `../etc/passwd`, absolute paths).
   */
  private safePath(relativePath: string): string {
    const base = resolve(this.tempDir!)
    const resolved = resolve(base, relativePath)
    if (resolved !== base && !resolved.startsWith(base + '/')) {
      throw new Error(
        `Path traversal detected: "${relativePath}" resolves outside sandbox directory`,
      )
    }
    return resolved
  }

  /**
   * Build docker run args for one-shot execution.
   * In preview mode: allow network, read-write workspace mount.
   * In secure mode (default): --network=none, --read-only, :ro mount.
   */
  private buildRunArgs(cwd: string, command: string): string[] {
    const args = [
      'run',
      '--rm',
      `--memory=${this.memoryLimit}`,
      `--cpus=${this.cpuLimit}`,
      '--security-opt=no-new-privileges',
      '--stop-timeout=5',
    ]

    if (this.previewMode) {
      // Preview mode: allow network and read-write workspace
      args.push(
        '--tmpfs=/tmp:size=100m',
        '-v', `${this.tempDir}:/work`,
      )
    } else {
      // Secure mode (default): locked-down
      args.push(
        '--network=none',
        '--read-only',
        '--tmpfs=/tmp:size=100m',
        '--tmpfs=/work:size=200m',
        '-v', `${this.tempDir}:/work:ro`,
      )
    }

    args.push('-w', cwd, this.image, 'sh', '-c', command)
    return args
  }

  /**
   * Build docker run args for a long-lived session container.
   * Uses `tail -f /dev/null` to keep the container alive.
   */
  private buildSessionArgs(
    sessionId: string,
    envVars?: Record<string, string>,
  ): string[] {
    const args = [
      'run', '-d',
      '--name', sessionId,
      `--memory=${this.memoryLimit}`,
      `--cpus=${this.cpuLimit}`,
      '--security-opt=no-new-privileges',
    ]

    if (this.previewMode) {
      args.push('-v', `${this.tempDir}:/work`)
    } else {
      args.push(
        '--network=none',
        '--read-only',
        '--tmpfs=/tmp:size=100m',
        '--tmpfs=/work:size=200m',
        '-v', `${this.tempDir}:/work:ro`,
      )
    }

    if (envVars) {
      for (const [key, value] of Object.entries(envVars)) {
        args.push('-e', `${key}=${value}`)
      }
    }

    args.push('-w', '/work', this.image, 'tail', '-f', '/dev/null')
    return args
  }
}
