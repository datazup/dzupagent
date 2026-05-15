/**
 * Governed Process-Tool-Call (PTC) types.
 *
 * PTC = the ability for an LLM agent to execute arbitrary code inside the
 * tool loop. Every PTC invocation is routed through the same
 * `ToolGovernance.checkAccess` path as any other tool, ensuring:
 *   - blocklist enforcement
 *   - per-minute rate limiting
 *   - approval-gate gating (hard stop, `approval:requested` event)
 *   - optional custom validator
 *   - audit trail via `ToolAuditHandler`
 *
 * The default tool name used for governance lookups is `'ptc'` so operators
 * can target it with any standard governance config option:
 *   ```ts
 *   governance: { approvalRequired: ['ptc'], rateLimits: { ptc: 5 } }
 *   ```
 */

/** Supported languages for PTC code execution. */
export type PtcLanguage = 'javascript' | 'typescript'

/** Raw input accepted by the governed PTC tool. */
export interface PtcRequest {
  /** Source code to execute inside the QuickJS WASM sandbox. */
  code: string
  /** Language of the submitted code. TypeScript is stripped to JS before execution. */
  language?: PtcLanguage
  /** Optional human-readable intent description forwarded to the audit trail. */
  reason?: string
}

/** Execution result returned by the PTC tool. */
export interface PtcResult {
  /** Captured stdout (may be empty if the runtime did not capture output). */
  stdout: string
  /** Captured stderr / error output. */
  stderr: string
  /** Process exit code: 0 = success, non-zero = error. */
  exitCode: number
  /** Wall-clock execution duration in milliseconds. */
  durationMs: number
  /** Whether the code was blocked by governance before execution. */
  blocked: boolean
  /** Human-readable reason when `blocked === true` or execution was denied. */
  blockReason?: string
}

/** Governance options forwarded to `ToolGovernance` for each PTC invocation. */
export interface PtcGovernanceConfig {
  /**
   * Tool name used for all `ToolGovernance.checkAccess` lookups.
   * Defaults to `'ptc'`.
   */
  toolName?: string

  /**
   * When `true`, PTC execution is disabled entirely — every call is blocked
   * without consulting governance. Useful as a fast-path kill-switch.
   */
  disabled?: boolean

  /**
   * When `true`, TypeScript source is transpiled to JavaScript before
   * execution. When `false` (default), TypeScript is passed as-is and
   * QuickJS will error on type syntax.
   *
   * Requires `@dzupagent/codegen`'s `WasmTypeScriptTranspiler` (esbuild
   * peer dependency) to be available. Falls back to un-transpiled execution
   * when the transpiler is unavailable.
   */
  transpileTypeScript?: boolean
}
