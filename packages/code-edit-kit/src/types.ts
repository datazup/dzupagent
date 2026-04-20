export type ValidationTrigger = 'after_write' | 'after_patch' | 'after_edit' | 'always'
export type ValidationFailureAction = 'warn' | 'rollback' | 'require_approval'

export interface ValidationHook {
  name: string
  trigger: ValidationTrigger
  command: string[]               // e.g. ["tsc", "--noEmit"]
  failureAction: ValidationFailureAction
  workingDir?: string             // relative to workspace root
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
}

export const DEFAULT_EDIT_POLICY: EditPolicy = {
  preferPatch: true,
  maxDirectWriteLines: 5,
  requireValidationAfterWrite: true,
}
