/**
 * WASM sandbox module — lightweight in-process sandboxing.
 *
 * Provides a WASI filesystem, capability guard, QuickJS-based
 * JavaScript execution, TypeScript transpilation support,
 * and resource limit error classes.
 */

// --- WASI Filesystem ---
export { WasiFilesystem } from './wasi-fs.js'
export type { WasiFileEntry, WasiStatResult } from './wasi-fs.js'

// --- Capability Guard ---
export { CapabilityGuard, CapabilityDeniedError } from './capability-guard.js'
export type { WasiCapability } from './capability-guard.js'

// --- WASM Sandbox ---
export { WasmSandbox } from './wasm-sandbox.js'
export type { WasmSandboxConfig, WasmExecResult, SandboxResourceLimits } from './wasm-sandbox.js'

// --- Sandbox Errors ---
export {
  SandboxResourceError,
  SandboxTimeoutError,
  SandboxAccessDeniedError,
} from './sandbox-errors.js'

// --- TypeScript Transpiler ---
export { WasmTypeScriptTranspiler } from './ts-transpiler.js'
export type { TranspileResult } from './ts-transpiler.js'
