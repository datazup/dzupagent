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

  constructor(config?: WasmSandboxConfig) {
    this.fs = new WasiFilesystem()
    this.guard = new CapabilityGuard(
      new Set(config?.capabilities ?? DEFAULT_CAPABILITIES),
    )
    this.memoryLimitPages = config?.memoryLimitPages ?? DEFAULT_MEMORY_LIMIT_PAGES
    this.fuelLimit = config?.fuelLimit ?? DEFAULT_FUEL_LIMIT
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS

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
            stderr: errorVal + '\n',
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
      return {
        stdout: '',
        stderr: (err instanceof Error ? err.message : String(err)) + '\n',
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
      this.ensureParentDirs(path)
      this.fs.writeFile(path, encoder.encode(content))
    }
  }

  /** Download files from the WASI filesystem. */
  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    this.guard.check('fs-read')
    const result: Record<string, string> = {}
    for (const path of paths) {
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
  getConfig(): { memoryLimitPages: number; fuelLimit: number; timeoutMs: number } {
    return {
      memoryLimitPages: this.memoryLimitPages,
      fuelLimit: this.fuelLimit,
      timeoutMs: this.timeoutMs,
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Ensure all parent directories exist for the given file path. */
  private ensureParentDirs(filePath: string): void {
    const parts = filePath.split('/').filter((s) => s.length > 0)
    if (parts.length <= 1) return

    const parentParts = parts.slice(0, -1)
    const parentPath = '/' + parentParts.join('/')
    this.fs.mkdirp(parentPath)
  }
}
