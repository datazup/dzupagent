/**
 * apply_patch LangChain tool — applies a unified diff to a WorkspaceFS.
 *
 * Wraps `workspace.applyPatch()` and returns a human-readable summary:
 * - Files modified, total lines added/removed
 * - Rollback error when the patch was rejected
 *
 * Pre- and post-apply validation hooks declared on `opts.policy.hooks` are
 * executed in registration order. Pre-apply hooks run with `trigger` of
 * `'after_edit'`, `'after_patch'`, or `'always'` — all are evaluated before
 * calling `WorkspaceFS.applyPatch`. A hook returning `{ valid: false }` aborts
 * the operation via a `ToolRejectedError`.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { WorkspaceFS } from '@dzupagent/codegen'
import {
  ToolRejectedError,
  type EditPolicy,
  type ValidationHook,
  type ValidationHookContext,
} from '../types.js'
import type { PolicyEnforcer } from '../policy-enforcer.js'
import {
  FileRollbackStore,
  InMemoryRollbackStore,
  type RollbackStore,
} from '../rollback/file-rollback-store.js'

const inputSchema = z.object({
  diff: z.string().describe('Unified diff in git diff format'),
})

/**
 * Locally-sourced UUID — avoids a hard dependency on `node:crypto` types in
 * the DTS build (this package keeps `"types": []` in its tsconfig). Uses
 * `globalThis.crypto.randomUUID()` when available (Node 19+ and browsers),
 * and falls back to a plain pseudo-random v4 for older runtimes.
 */
function uuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  const hex = (n: number): string => Math.floor(Math.random() * n).toString(16)
  return [
    `${hex(0x100000000)}`.padStart(8, '0'),
    `${hex(0x10000)}`.padStart(4, '0'),
    `4${`${hex(0x1000)}`.padStart(3, '0')}`,
    `${(8 + Math.floor(Math.random() * 4)).toString(16)}${`${hex(0x1000)}`.padStart(3, '0')}`,
    `${hex(0x1000000)}`.padStart(6, '0') + `${hex(0x1000000)}`.padStart(6, '0'),
  ].join('-')
}

// ---------------------------------------------------------------------------
// Rollback registry
// ---------------------------------------------------------------------------

/**
 * Module-level default rollback store. Preserves the original process-local
 * semantics for call sites that use the plain `createApplyPatchTool(ws)`
 * signature without supplying a custom store. Tests clear this via
 * `__clearRollbackRegistry()`.
 */
let defaultRollbackStore: RollbackStore = new InMemoryRollbackStore()

/**
 * Restore files captured by a previous `apply_patch` to their pre-patch state.
 *
 * The token is the value emitted as `rollbackToken: <uuid>` in an
 * `apply_patch` result string. Returns `true` on a successful restore and
 * `false` when the token is unknown (already consumed or never issued).
 *
 * By default this consults the process-local registry. When using a custom
 * (e.g. persistent) store, pass it explicitly as the second argument.
 */
export async function undoApplyPatch(
  rollbackToken: string,
  store: RollbackStore = defaultRollbackStore,
): Promise<boolean> {
  const entry = await store.load(rollbackToken)
  if (!entry) return false
  await store.delete(rollbackToken)
  for (const [path, original] of entry.originals) {
    if (original === null) {
      await entry.workspace.delete(path).catch(() => undefined)
    } else {
      await entry.workspace.write(path, original)
    }
  }
  return true
}

/** Test helper — clears the default in-memory rollback registry. */
export function __clearRollbackRegistry(): void {
  defaultRollbackStore = new InMemoryRollbackStore()
}

/** Test/inspection helper — expose the default store (mostly for assertions). */
export function __getDefaultRollbackStore(): RollbackStore {
  return defaultRollbackStore
}

/**
 * Count `+` / `-` lines in a unified diff, ignoring file headers
 * (`+++`, `---`) which are not additions/removals.
 */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  const lines = diff.split(/\r?\n/)
  for (const line of lines) {
    // File headers start with "+++" / "---" and must not be counted as content.
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

/**
 * Extract destination file paths from a unified diff.
 * Reads every `+++ b/<path>` (or `+++ <path>`) line.
 */
export function extractDiffFiles(diff: string): string[] {
  const files: string[] = []
  const lines = diff.split(/\r?\n/)
  for (const line of lines) {
    if (!line.startsWith('+++ ')) continue
    const raw = line.slice(4).trim()
    if (raw === '/dev/null') continue
    const stripped = raw.replace(/^[ab]\//, '')
    files.push(stripped)
  }
  return files
}

/**
 * Determine whether a given hook applies to a stage. For pre-apply, we treat
 * `after_edit` / `after_patch` / `always` triggers as eligible to short-circuit
 * bad patches early. For post-apply the same triggers apply after writes land.
 */
function hookMatchesStage(
  hook: ValidationHook,
  stage: 'pre_apply' | 'post_apply',
): boolean {
  if (!hook.run) return false
  switch (hook.trigger) {
    case 'always':
      return true
    case 'after_write':
      return stage === 'post_apply'
    case 'after_patch':
    case 'after_edit':
      return true
    default:
      return false
  }
}

export interface HookRunRecord {
  hook: ValidationHook
  result: ValidationHookResultInternal
}

interface ValidationHookResultInternal {
  valid: boolean
  reason?: string
  /**
   * Set when the hook threw. We treat thrown errors as a non-fatal
   * warning so subsequent hooks still run.
   */
  threw?: boolean
}

async function runHooksCollecting(
  hooks: ValidationHook[] | undefined,
  stage: 'pre_apply' | 'post_apply',
  ctx: ValidationHookContext,
): Promise<HookRunRecord[]> {
  const records: HookRunRecord[] = []
  if (!hooks || hooks.length === 0) return records
  for (const hook of hooks) {
    if (!hookMatchesStage(hook, stage)) continue
    // Narrowed by hookMatchesStage (returns false when run is undefined).
    const runFn = hook.run!
    try {
      const res = await runFn(ctx)
      records.push({ hook, result: { valid: res.valid, reason: res.reason } })
    } catch (err) {
      // Exceptions are treated as warn-level: other hooks still run.
      const msg = err instanceof Error ? err.message : String(err)
      records.push({
        hook,
        result: {
          valid: false,
          reason: `hook threw: ${msg}`,
          threw: true,
        },
      })
    }
  }
  return records
}

/**
 * Legacy helper retained for parity — throws the first rejection. Only used
 * for pre_apply evaluation where a reject must abort before we write.
 */
async function runHooks(
  hooks: ValidationHook[] | undefined,
  stage: 'pre_apply' | 'post_apply',
  ctx: ValidationHookContext,
): Promise<void> {
  const records = await runHooksCollecting(hooks, stage, ctx)
  for (const rec of records) {
    // Thrown hooks are warnings, not rejections.
    if (rec.result.threw) continue
    if (!rec.result.valid) {
      const reason = rec.result.reason ?? 'validation hook rejected the patch'
      throw new ToolRejectedError(
        `${rec.hook.name} (${stage}): ${reason}`,
        rec.hook.name,
        stage,
      )
    }
  }
}

export interface CreateApplyPatchToolOptions {
  policy?: EditPolicy
  /** Optional policy enforcer — consulted before pre-apply hooks. */
  policyEnforcer?: PolicyEnforcer
  /**
   * Custom rollback store. When omitted the process-local default is used,
   * unless `storageDir` is provided (which wires a FileRollbackStore bound
   * to the tool's workspace).
   */
  rollbackStore?: RollbackStore
  /**
   * When set, the tool persists rollback entries to disk under this directory
   * via a `FileRollbackStore`. Ignored if `rollbackStore` is also provided.
   */
  storageDir?: string
}

export function createApplyPatchTool(
  workspace: WorkspaceFS,
  opts?: CreateApplyPatchToolOptions,
): DynamicStructuredTool {
  const hooks = opts?.policy?.hooks
  const enforcer = opts?.policyEnforcer
  // Resolve the store lazily so that `__clearRollbackRegistry()` (which
  // rebinds the module-level default) affects tools created beforehand.
  const fileStore: RollbackStore | undefined = opts?.storageDir
    ? new FileRollbackStore(workspace, { storageDir: opts.storageDir })
    : undefined
  const resolveStore = (): RollbackStore =>
    opts?.rollbackStore ?? fileStore ?? defaultRollbackStore

  return new DynamicStructuredTool({
    name: 'apply_patch',
    description:
      'Apply a unified diff (git diff format) to the workspace. ' +
      'Use this to make precise, multi-file edits described as a patch. ' +
      'Returns a summary of files modified and lines changed, or an error if the patch was rejected.',
    schema: inputSchema,
    func: async (input) => {
      const diff = input.diff
      const { added: linesAdded, removed: linesRemoved } = countDiffLines(diff)
      const filesInDiff = extractDiffFiles(diff)

      // ---- PolicyEnforcer gate ----
      if (enforcer) {
        const decision = await enforcer.enforce({
          diff,
          filesModified: filesInDiff,
          linesAdded,
          linesRemoved,
        })
        if (!decision.valid) {
          return `apply_patch denied by policy: ${decision.reason ?? 'unknown reason'}`
        }
      }

      // ---- Pre-apply hook evaluation ----
      try {
        await runHooks(hooks, 'pre_apply', {
          stage: 'pre_apply',
          diff,
          filesModified: filesInDiff,
          linesAdded,
          linesRemoved,
        })
      } catch (err) {
        if (err instanceof ToolRejectedError) {
          return `apply_patch rejected by policy: ${err.message}`
        }
        const msg = err instanceof Error ? err.message : String(err)
        return `apply_patch pre-validation failed: ${msg}`
      }

      // ---- Capture originals for rollback BEFORE applying ----
      const originals = new Map<string, string | null>()
      for (const p of filesInDiff) {
        try {
          originals.set(p, await workspace.read(p))
        } catch {
          originals.set(p, null)
        }
      }

      // ---- Apply ----
      let result
      try {
        result = await workspace.applyPatch(diff)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `apply_patch failed: ${msg}`
      }

      if (result.rolledBack) {
        const firstFailure = result.results.find((r) => !r.success)
        const detail = firstFailure?.errorMessage ?? firstFailure?.error ?? 'unknown error'
        return `Patch rejected and rolled back: ${detail}`
      }

      const successful = result.results.filter((r) => r.success)

      if (successful.length === 0) {
        const firstFailure = result.results.find((r) => !r.success)
        const detail = firstFailure?.errorMessage ?? firstFailure?.error ?? 'unknown error'
        return `Patch applied 0 files. First failure: ${detail}`
      }

      const successfulPaths = successful.map((r) => r.filePath)

      // ---- Post-apply hook evaluation (collects all results) ----
      const postRecords = await runHooksCollecting(hooks, 'post_apply', {
        stage: 'post_apply',
        diff,
        filesModified: successfulPaths,
        linesAdded,
        linesRemoved,
      })

      const invalidPost = postRecords.filter((r) => !r.result.valid && !r.result.threw)
      if (invalidPost.length > 0) {
        // Classify by the most severe failureAction in order:
        // rollback > require_approval > warn.
        const actions = invalidPost.map((r) => r.hook.failureAction)
        const summary = invalidPost
          .map((r) => `${r.hook.name}: ${r.result.reason ?? 'rejected'}`)
          .join('; ')

        if (actions.includes('rollback')) {
          // Restore originals synchronously.
          for (const [path, original] of originals) {
            if (original === null) {
              await workspace.delete(path).catch(() => undefined)
            } else {
              await workspace.write(path, original)
            }
          }
          return `apply_patch rolled back after post-validation failed: ${summary}`
        }

        if (actions.includes('require_approval')) {
          // Register rollback token so a reviewer can undo.
          const rollbackToken = uuid()
          await resolveStore().save(rollbackToken, { workspace, originals })
          return [
            `apply_patch requires approval — post-validation reported issues:`,
            `  ${summary}`,
            `approvalRequired: true`,
            `rollbackToken: ${rollbackToken}`,
            `filesModified: ${successfulPaths.join(', ')}`,
          ].join('\n')
        }

        // warn — applied but surface failure details; still emit rollback token.
        const rollbackToken = uuid()
        await resolveStore().save(rollbackToken, { workspace, originals })
        return [
          `apply_patch post-validation failed: ${summary}`,
          `rollbackToken: ${rollbackToken}`,
        ].join('\n')
      }

      const fileList = successfulPaths.map((p) => `  - ${p}`).join('\n')
      const lineSummary =
        linesAdded + linesRemoved > 0
          ? ` (+${linesAdded}/-${linesRemoved} lines)`
          : ''

      const failed = result.results.filter((r) => !r.success)
      const failNote =
        failed.length > 0
          ? `\n${failed.length} file(s) failed: ${failed.map((r) => r.filePath).join(', ')}`
          : ''

      // Register rollback token for any successful patch (even without hooks).
      const rollbackToken = uuid()
      await resolveStore().save(rollbackToken, { workspace, originals })

      return (
        `Patch applied to ${successful.length} file(s)${lineSummary}:\n${fileList}${failNote}\nrollbackToken: ${rollbackToken}`
      )
    },
  })
}
