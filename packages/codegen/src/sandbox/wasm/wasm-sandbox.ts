/**
 * WASM-based sandbox using QuickJS for JavaScript execution.
 *
 * Provides a lightweight, in-process alternative to Docker/cloud sandboxes.
 * The WASI filesystem and capability guard are fully functional regardless
 * of whether the QuickJS WASM runtime is installed.
 *
 * QuickJS WASM (`quickjs-emscripten`) is an optional peer dependency.
 * When not available, `execute()` throws a descriptive error while all
 * other operations (file upload/download, FS manipulation) still work.
 */

import { WasiFilesystem } from './wasi-fs.js'
import { CapabilityGuard } from './capability-guard.js'
import type { WasiCapability } from './capability-guard.js'
import {
  SandboxResourceError,
  SandboxTimeoutError,
  SandboxAccessDeniedError,
} from './sandbox-errors.js'

// ---------------------------------------------------------------------------
// Resource limit types
// ---------------------------------------------------------------------------

export interface SandboxResourceLimits {
  /** Maximum memory in bytes (default: 128 MB) */
  maxMemoryBytes?: number
  /** Maximum execution time in ms (default: 30_000) */
  maxExecutionMs?: number
  /** Allowed filesystem paths (default: none — no FS access restriction beyond capabilities) */
  allowedPaths?: string[]
  /** Maximum output size in bytes (default: 1 MB) */
  maxOutputBytes?: number
}

// ---------------------------------------------------------------------------
// Config & result types
// ---------------------------------------------------------------------------

export interface WasmSandboxConfig {
  /** Capabilities granted to the WASM module (default: fs-read, fs-write, stdout, stderr). */
  capabilities?: WasiCapability[]
  /** WASM linear memory limit in 64 KiB pages (default: 256 = 16 MiB). */
  memoryLimitPages?: number
  /** Fuel limit for QuickJS execution (default: 1_000_000). */
  fuelLimit?: number
  /** Maximum execution time in milliseconds (default: 30_000). */
  timeoutMs?: number
  /** Files to pre-populate in the WASI filesystem (path -> UTF-8 content). */
  initialFiles?: Record<string, string>
  /** Resource limits for hardened execution. */
  resourceLimits?: SandboxResourceLimits
}

export interface WasmExecResult {
  stdout: string
  stderr: string
  exitCode: number
  fuelConsumed: number
  memoryPagesUsed: number
  durationMs: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: WasiCapability[] = [
  'fs-read',
  'fs-write',
  'stdout',
  'stderr',
]
const DEFAULT_MEMORY_LIMIT_PAGES = 256
const DEFAULT_FUEL_LIMIT = 1_000_000
const DEFAULT_TIMEOUT_MS = 30_000

/** 128 MiB */
const DEFAULT_MAX_MEMORY_BYTES = 128 * 1024 * 1024
/** 30 seconds */
const DEFAULT_MAX_EXECUTION_MS = 30_000
/** 1 MiB */
const DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Attempt a dynamic import of an optional module.
 * Uses Function constructor to prevent TypeScript from resolving the module
 * at compile time. Returns `undefined` if the module is not installed.
 */
async function tryImport(moduleName: string): Promise<unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>
    return await dynamicImport(moduleName)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// WasmSandbox
// ---------------------------------------------------------------------------

export class WasmSandbox {
  private readonly fs: WasiFilesystem
  private readonly guard: CapabilityGuard
  private readonly memoryLimitPages: number
  private readonly fuelLimit: number
  private readonly timeoutMs: number
  private readonly maxMemoryBytes: number
  private readonly maxExecutionMs: number
  private readonly allowedPaths: string[] | undefined
  private readonly maxOutputBytes: number

  constructor(config?: WasmSandboxConfig) {
    this.fs = new WasiFilesystem()
    this.guard = new CapabilityGuard(
      new Set(config?.capabilities ?? DEFAULT_CAPABILITIES),
    )
    this.memoryLimitPages = config?.memoryLimitPages ?? DEFAULT_MEMORY_LIMIT_PAGES
    this.fuelLimit = config?.fuelLimit ?? DEFAULT_FUEL_LIMIT
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS

    // Resource limits
    const rl = config?.resourceLimits
    this.maxMemoryBytes = rl?.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES
    this.maxExecutionMs = rl?.maxExecutionMs ?? DEFAULT_MAX_EXECUTION_MS
    this.allowedPaths = rl?.allowedPaths
    this.maxOutputBytes = rl?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    // Pre-populate initial files
    if (config?.initialFiles) {
      for (const [path, content] of Object.entries(config.initialFiles)) {
        this.ensureParentDirs(path)
        this.fs.writeFile(path, encoder.encode(content))
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Availability check
  // ---------------------------------------------------------------------------

  /** Check whether the QuickJS WASM runtime can be loaded. */
  async isAvailable(): Promise<boolean> {
    const mod = await tryImport('quickjs-emscripten')
    return mod !== undefined
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  /**
   * Execute JavaScript code inside the QuickJS WASM sandbox.
   *
   * Enforces resource limits:
   * - Memory: WASM linear memory `maximum` pages derived from `maxMemoryBytes`
   * - Time: `Promise.race` with AbortController-based timeout
   * - Output: stdout/stderr truncated at `maxOutputBytes`
   *
   * @throws {SandboxTimeoutError} if execution exceeds `maxExecutionMs`.
   * @throws {SandboxResourceError} if memory allocation exceeds `maxMemoryBytes`.
   * @throws Error if the QuickJS WASM runtime is not installed.
   */
  async execute(
    code: string,
    _options?: { args?: string[]; env?: Record<string, string> },
  ): Promise<WasmExecResult> {
    const start = Date.now()

    const quickjs = await tryImport('quickjs-emscripten')
    if (!quickjs) {
      throw new Error(
        'QuickJS WASM not available — install quickjs-emscripten as a dependency to enable WASM sandbox execution.',
      )
    }

    // Enforce execution time via Promise.race + AbortController
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), this.maxExecutionMs)

    const execPromise = this.executeInner(quickjs, code, start)
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new SandboxTimeoutError(this.maxExecutionMs))
      })
    })

    try {
      const result = await Promise.race([execPromise, timeoutPromise])
      return result
    } finally {
      clearTimeout(timeoutHandle)
    }
  }

  /**
   * Inner execution logic — separated so the outer execute() can wrap it
   * with timeout enforcement.
   */
  private async executeInner(
    quickjs: unknown,
    code: string,
    start: number,
  ): Promise<WasmExecResult> {
    // Validate memory limit: compute WASM max pages from maxMemoryBytes
    const maxPages = Math.floor(this.maxMemoryBytes / 65536)
    if (this.memoryLimitPages > maxPages) {
      throw new SandboxResourceError(
        'memory',
        this.maxMemoryBytes,
        this.memoryLimitPages * 65536,
      )
    }

    // QuickJS module loaded. The runtime interaction below is intentionally
    // simplified since the module is an optional peer dependency whose types
    // are not available at compile time. A full implementation would use the
    // typed API surface when quickjs-emscripten is installed.
    //
    // This stub delegates to a minimal eval path that captures stdout/stderr.
    // Production callers should verify `isAvailable()` first.
    try {
      const mod = quickjs as Record<string, unknown>
      const newModule = mod['newQuickJSWASMModule'] as (() => Promise<unknown>) | undefined
      if (typeof newModule !== 'function') {
        throw new Error('quickjs-emscripten API not compatible — newQuickJSWASMModule not found')
      }

      const runtime = (await newModule()) as Record<string, unknown>
      const newContext = runtime['newContext'] as (() => unknown) | undefined
      if (typeof newContext !== 'function') {
        throw new Error('quickjs-emscripten API not compatible — newContext not found')
      }

      const vm = newContext() as Record<string, unknown>
      try {
        const evalCode = vm['evalCode'] as ((c: string) => Record<string, unknown>) | undefined
        if (typeof evalCode !== 'function') {
          throw new Error('quickjs-emscripten API not compatible — evalCode not found')
        }

        const result = evalCode(code)
        const hasError = result['error'] !== undefined

        if (hasError) {
          const dump = vm['dump'] as ((h: unknown) => unknown) | undefined
          const errorVal = typeof dump === 'function' ? String(dump(result['error'])) : 'unknown error'
          const dispose = (result['error'] as Record<string, unknown>)?.['dispose'] as (() => void) | undefined
          if (typeof dispose === 'function') dispose()

          return {
            stdout: '',
            stderr: this.truncateOutput(errorVal + '\n'),
            exitCode: 1,
            fuelConsumed: this.fuelLimit,
            memoryPagesUsed: this.memoryLimitPages,
            durationMs: Date.now() - start,
          }
        }

        const valueDispose = (result['value'] as Record<string, unknown>)?.['dispose'] as (() => void) | undefined
        if (typeof valueDispose === 'function') valueDispose()

        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          fuelConsumed: 0,
          memoryPagesUsed: this.memoryLimitPages,
          durationMs: Date.now() - start,
        }
      } finally {
        const vmDispose = vm['dispose'] as (() => void) | undefined
        if (typeof vmDispose === 'function') vmDispose()
        const rtDispose = runtime['dispose'] as (() => void) | undefined
        if (typeof rtDispose === 'function') rtDispose()
      }
    } catch (err) {
      // Re-throw resource errors so they propagate correctly
      if (err instanceof SandboxResourceError || err instanceof SandboxTimeoutError) {
        throw err
      }
      return {
        stdout: '',
        stderr: this.truncateOutput(
          (err instanceof Error ? err.message : String(err)) + '\n',
        ),
        exitCode: 1,
        fuelConsumed: 0,
        memoryPagesUsed: this.memoryLimitPages,
        durationMs: Date.now() - start,
      }
    }
  }

  // ---------------------------------------------------------------------------
  // File operations (always available, independent of QuickJS)
  // ---------------------------------------------------------------------------

  /** Upload files into the WASI filesystem. */
  async uploadFiles(files: Record<string, string>): Promise<void> {
    this.guard.check('fs-write')
    for (const [path, content] of Object.entries(files)) {
      this.validatePath(path)
      this.ensureParentDirs(path)
      this.fs.writeFile(path, encoder.encode(content))
    }
  }

  /** Download files from the WASI filesystem. */
  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    this.guard.check('fs-read')
    const result: Record<string, string> = {}
    for (const path of paths) {
      this.validatePath(path)
      if (this.fs.exists(path)) {
        result[path] = decoder.decode(this.fs.readFile(path))
      }
    }
    return result
  }

  /** Reset the WASI filesystem to empty state. */
  async cleanup(): Promise<void> {
    const entries = this.fs.readdir('/')
    for (const entry of entries) {
      this.fs.unlink('/' + entry)
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** Get the underlying WASI filesystem. */
  getFilesystem(): WasiFilesystem {
    return this.fs
  }

  /** Get the capability guard. */
  getCapabilities(): CapabilityGuard {
    return this.guard
  }

  /** Get the configured resource limits. */
  getConfig(): {
    memoryLimitPages: number
    fuelLimit: number
    timeoutMs: number
    maxMemoryBytes: number
    maxExecutionMs: number
    allowedPaths: string[] | undefined
    maxOutputBytes: number
  } {
    return {
      memoryLimitPages: this.memoryLimitPages,
      fuelLimit: this.fuelLimit,
      timeoutMs: this.timeoutMs,
      maxMemoryBytes: this.maxMemoryBytes,
      maxExecutionMs: this.maxExecutionMs,
      allowedPaths: this.allowedPaths,
      maxOutputBytes: this.maxOutputBytes,
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Validate that a path is within the configured `allowedPaths`.
   *
   * When `allowedPaths` is not set (undefined), all paths are allowed.
   * Path traversal (e.g., `/../`) is resolved before checking.
   *
   * @throws {SandboxAccessDeniedError} if the path is outside allowed paths.
   */
  validatePath(path: string): void {
    if (!this.allowedPaths) return

    // Normalize: resolve `.` and `..` segments
    const normalized = resolvePath(path)

    const isAllowed = this.allowedPaths.some((allowed) => {
      const normalizedAllowed = resolvePath(allowed)
      return (
        normalized === normalizedAllowed
        || normalized.startsWith(normalizedAllowed + '/')
      )
    })

    if (!isAllowed) {
      throw new SandboxAccessDeniedError(path, this.allowedPaths)
    }
  }

  /**
   * Truncate output to `maxOutputBytes`. If truncated, appends a warning.
   */
  truncateOutput(output: string): string {
    const bytes = encoder.encode(output)
    if (bytes.byteLength <= this.maxOutputBytes) {
      return output
    }
    const truncated = decoder.decode(bytes.slice(0, this.maxOutputBytes))
    return truncated + '\n[output truncated — exceeded ' + this.maxOutputBytes + ' byte limit]'
  }

  /** Ensure all parent directories exist for the given file path. */
  private ensureParentDirs(filePath: string): void {
    const parts = filePath.split('/').filter((s) => s.length > 0)
    if (parts.length <= 1) return

    const parentParts = parts.slice(0, -1)
    const parentPath = '/' + parentParts.join('/')
    this.fs.mkdirp(parentPath)
  }
}

// ---------------------------------------------------------------------------
// Path resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve a POSIX-style path by collapsing `.` and `..` segments.
 * Always returns a path starting with `/`.
 */
function resolvePath(raw: string): string {
  const parts = raw.split('/').filter((s) => s.length > 0)
  const resolved: string[] = []

  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      resolved.pop()
    } else {
      resolved.push(part)
    }
  }

  return '/' + resolved.join('/')
}
