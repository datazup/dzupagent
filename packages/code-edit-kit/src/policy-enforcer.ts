/**
 * PolicyEnforcer — sandbox-style permission gating layered on top of
 * validation hooks. Consulted by `apply_patch` before any pre-apply hooks run.
 *
 * Three permission tiers mirror the codegen sandbox tiers:
 *
 * - `read-only`       — any write operation is denied outright.
 * - `workspace-write` — absolute paths outside `workspaceRoot` are denied;
 *                       relative paths are allowed.
 * - `full-access`     — enforcer is a no-op and only hooks are evaluated.
 */
import type {
  ValidationHook,
  ValidationHookContext,
  ValidationHookResult,
} from './types.js'

// ---------------------------------------------------------------------------
// Minimal path helpers (we intentionally avoid importing `node:path` so this
// package does not require @types/node in its DTS build; the checks below
// cover POSIX and Windows absolute-path forms we care about).
// ---------------------------------------------------------------------------

function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith('/')) return true
  // Windows drive (C:\ or C:/) or UNC (\\server\share).
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true
  if (p.startsWith('\\\\')) return true
  return false
}

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/')
}

function stripTrailingSlash(p: string): string {
  return p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p
}

/**
 * Collapse `a/b/../c` to `a/c`. Does not resolve against cwd — callers must
 * already pass an absolute path or rely on the relative-path fast-path in
 * {@link DefaultPolicyEnforcer.enforce}.
 */
function normalizePath(p: string): string {
  const slashed = normalizeSeparators(p)
  const parts = slashed.split('/')
  const stack: string[] = []
  for (const seg of parts) {
    if (seg === '' || seg === '.') {
      // Preserve a leading empty segment (for absolute POSIX paths).
      if (stack.length === 0 && seg === '') stack.push('')
      continue
    }
    if (seg === '..') {
      if (stack.length > 1 || (stack.length === 1 && stack[0] !== '')) {
        stack.pop()
      }
      continue
    }
    stack.push(seg)
  }
  return stack.join('/') || '/'
}

export type PolicyTier = 'read-only' | 'workspace-write' | 'full-access'

export interface PolicyEnforceInput {
  diff: string
  filesModified?: string[]
  linesAdded?: number
  linesRemoved?: number
}

export interface PolicyEnforcer {
  readonly tier: PolicyTier
  readonly hooks: readonly ValidationHook[]
  enforce(input: PolicyEnforceInput): Promise<ValidationHookResult>
}

/**
 * Default implementation. Keeps the hooks list around so callers can delegate
 * their own hook execution to the enforcer if they wish — the `apply_patch`
 * tool ignores this field and runs hooks itself (the enforcer acts purely as
 * a sandbox gate).
 */
export class DefaultPolicyEnforcer implements PolicyEnforcer {
  readonly tier: PolicyTier
  readonly hooks: readonly ValidationHook[]
  private readonly workspaceRoot?: string

  constructor(
    hooks: ValidationHook[],
    tier: PolicyTier,
    workspaceRoot?: string,
  ) {
    this.hooks = [...hooks]
    this.tier = tier
    if (workspaceRoot !== undefined) {
      this.workspaceRoot = stripTrailingSlash(normalizePath(workspaceRoot))
    }
  }

  async enforce(input: PolicyEnforceInput): Promise<ValidationHookResult> {
    if (this.tier === 'read-only') {
      return { valid: false, reason: 'read-only sandbox' }
    }

    if (this.tier === 'workspace-write') {
      if (!this.workspaceRoot) {
        return {
          valid: false,
          reason: 'workspace-write tier requires workspaceRoot',
        }
      }
      const root = this.workspaceRoot
      const rootWithSep = root.endsWith('/') ? root : root + '/'
      const files = input.filesModified ?? []
      for (const path of files) {
        // Relative paths are workspace-relative by definition and allowed.
        if (!isAbsolutePath(path)) continue
        const resolved = stripTrailingSlash(normalizePath(path))
        if (resolved !== root && !resolved.startsWith(rootWithSep)) {
          return {
            valid: false,
            reason: `path outside workspace: ${path}`,
          }
        }
      }
      return { valid: true }
    }

    // full-access — no restrictions.
    return { valid: true }
  }

  /**
   * Convenience: run all registered hooks through the enforcer gate and then
   * sequentially as pre-apply validators. Returns the first rejection or
   * `{ valid: true }` when all pass.
   */
  async runHooks(
    stage: 'pre_apply' | 'post_apply',
    ctx: ValidationHookContext,
  ): Promise<ValidationHookResult> {
    for (const hook of this.hooks) {
      if (!hook.run) continue
      const triggers: Record<ValidationHook['trigger'], boolean> = {
        always: true,
        after_write: stage === 'post_apply',
        after_patch: true,
        after_edit: true,
      }
      if (!triggers[hook.trigger]) continue
      const res = await hook.run(ctx)
      if (!res.valid) return res
    }
    return { valid: true }
  }
}
