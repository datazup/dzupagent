/**
 * WASM sandbox module — lightweight in-process sandboxing.
 *
 * Provides a WASI filesystem, capability guard, QuickJS-based
 * JavaScript execution, and TypeScript transpilation support.
 */

// --- WASI Filesystem ---
export { WasiFilesystem } from './wasi-fs.js'
export type { WasiFileEntry, WasiStatResult } from './wasi-fs.js'

// --- Capability Guard ---
export { CapabilityGuard, CapabilityDeniedError } from './capability-guard.js'
export type { WasiCapability } from './capability-guard.js'

// --- WASM Sandbox ---
export { WasmSandbox } from './wasm-sandbox.js'
export type { WasmSandboxConfig, WasmExecResult } from './wasm-sandbox.js'

// --- TypeScript Transpiler ---
export { WasmTypeScriptTranspiler } from './ts-transpiler.js'
export type { TranspileResult } from './ts-transpiler.js'
