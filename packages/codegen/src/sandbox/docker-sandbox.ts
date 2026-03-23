/**
 * Docker-based sandbox for running commands in an isolated container.
 * Extracted from apps/api sandbox-runner.ts and adapted to SandboxProtocol.
 *
 * Security: --network=none, --read-only, --security-opt=no-new-privileges, --tmpfs
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { SandboxProtocol, ExecResult, ExecOptions } from './sandbox-protocol.js'

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
}

const DEFAULT_IMAGE = 'node:20-slim'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MEMORY = '512m'
const DEFAULT_CPU = '1.0'

export class DockerSandbox implements SandboxProtocol {
  private readonly image: string
  private readonly timeoutMs: number
  private readonly memoryLimit: string
  private readonly cpuLimit: string
  private tempDir: string | null = null

  constructor(config?: DockerSandboxConfig) {
    this.image = config?.image ?? DEFAULT_IMAGE
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.memoryLimit = config?.memoryLimit ?? DEFAULT_MEMORY
    this.cpuLimit = config?.cpuLimit ?? DEFAULT_CPU
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
      const fullPath = join(this.tempDir, filePath)
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
      try {
        const fullPath = join(this.tempDir, filePath)
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

    const dockerArgs = [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      `--memory=${this.memoryLimit}`,
      `--cpus=${this.cpuLimit}`,
      '--tmpfs=/tmp:size=100m',
      '--tmpfs=/work:size=200m',
      '--security-opt=no-new-privileges',
      '-v', `${this.tempDir}:/work:ro`,
      '--stop-timeout=5',
      '-w', cwd,
      this.image,
      'sh', '-c', command,
    ]

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
}
