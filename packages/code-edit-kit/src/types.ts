export type ValidationTrigger = 'after_write' | 'after_patch' | 'after_edit' | 'always'
export type ValidationFailureAction = 'warn' | 'rollback' | 'require_approval'

/**
 * Context passed to a `ValidationHook.run` callback.
 * Populated with the stage in the edit lifecycle and a summary of the diff
 * the hook is asked to evaluate.
 */
export interface ValidationHookContext {
  /** Either 'pre_apply' (before patching) or 'post_apply' (after patching). */
  stage: 'pre_apply' | 'post_apply'
  /** Raw unified diff string being applied. */
  diff: string
  /** Files that will be (or have been) modified. */
  filesModified?: string[]
  /** Total lines added in the diff. */
  linesAdded?: number
  /** Total lines removed in the diff. */
  linesRemoved?: number
}

/**
 * Result returned by a validation hook. `valid: false` indicates the hook
 * rejected the patch; the `reason` is surfaced to the caller.
 */
export interface ValidationHookResult {
  valid: boolean
  reason?: string
}

/**
 * A validation hook evaluated by the edit tools before/after an apply.
 *
 * The `command` field is retained for policy/runtime descriptors (e.g. a CI
 * spec such as `["tsc", "--noEmit"]`), but for in-process execution a `run`
 * callback is what actually gets invoked by `apply_patch`.
 */
export interface ValidationHook {
  name: string
  trigger: ValidationTrigger
  failureAction: ValidationFailureAction
  /** Optional command descriptor (e.g. ["tsc", "--noEmit"]). */
  command?: string[]
  /** Working dir relative to workspace root (descriptor only). */
  workingDir?: string
  /**
   * In-process evaluator. When provided, apply_patch invokes this function
   * at the appropriate stage. If omitted, the hook is treated as a descriptor
   * and is skipped by apply_patch.
   */
  run?: (ctx: ValidationHookContext) => ValidationHookResult | Promise<ValidationHookResult>
}

export interface ApplyPatchResult {
  success: boolean
  filesModified: string[]
  linesAdded: number
  linesRemoved: number
  rollbackToken?: string          // opaque token for rollback
  error?: string
}

export interface EditPolicy {
  preferPatch: boolean            // default: true — use apply_patch over write_file
  maxDirectWriteLines: number     // default: 5 — above this, prefer patch
  requireValidationAfterWrite: boolean
  /** Hooks evaluated before/after edits. */
  hooks?: ValidationHook[]
}

export const DEFAULT_EDIT_POLICY: EditPolicy = {
  preferPatch: true,
  maxDirectWriteLines: 5,
  requireValidationAfterWrite: true,
  hooks: [],
}

/**
 * Error thrown when a tool operation is rejected by policy or a validation hook.
 * Tools catch this and surface a structured error message rather than raw exceptions.
 */
export class ToolRejectedError extends Error {
  readonly hookName: string
  readonly stage: 'pre_apply' | 'post_apply'

  constructor(message: string, hookName: string, stage: 'pre_apply' | 'post_apply') {
    super(message)
    this.name = 'ToolRejectedError'
    this.hookName = hookName
    this.stage = stage
  }
}
