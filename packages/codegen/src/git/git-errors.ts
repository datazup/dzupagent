/**
 * Git tool — error containment (DZUPAGENT-ERR-H-09).
 *
 * Raw `execFile` failures from git surface stderr verbatim: pre-commit /
 * pre-push hook output, remote URLs (which may embed credentials), and
 * absolute internal filesystem paths. None of that may reach the LLM/tool
 * output. This module classifies the failure into a fixed, non-sensitive
 * category vocabulary, returns an LLM-safe summary, and logs the full raw
 * detail admin-side (structured stderr) — mirroring the database connector's
 * `db-errors.ts` containment pattern.
 */

import { redactSecrets } from '../sandbox/audit/audited-sandbox.js'

/**
 * Typed wrapper for git tool failures. Carries the raw error for admin-side
 * logging while keeping the client/LLM-safe summary separate.
 */
export class GitToolError extends Error {
  readonly operation: string
  readonly category: string
  readonly cause?: unknown

  constructor(operation: string, category: string, summary: string, cause?: unknown) {
    super(summary)
    this.name = 'GitToolError'
    this.operation = operation
    this.category = category
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Classify a git/execFile error into a coarse, non-sensitive category. Only the
 * lowercased raw text is *matched* against a fixed vocabulary — no raw content
 * is ever echoed back to the caller.
 */
function classifyGitError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (raw.includes('not a git repository')) return 'not_a_repo'
  if (
    raw.includes('pre-commit') ||
    raw.includes('pre-push') ||
    raw.includes('hook') ||
    raw.includes('husky')
  ) {
    return 'hook_failed'
  }
  if (
    raw.includes('merge conflict') ||
    raw.includes('conflict') ||
    raw.includes('unmerged')
  ) {
    return 'merge_conflict'
  }
  if (
    raw.includes('authentication') ||
    raw.includes('permission denied') ||
    raw.includes('could not read from remote') ||
    raw.includes('access denied')
  ) {
    return 'auth_failed'
  }
  if (
    raw.includes('already exists') ||
    raw.includes('not a valid') ||
    raw.includes('did not match any') ||
    raw.includes('unknown revision') ||
    raw.includes('pathspec')
  ) {
    return 'ref_error'
  }
  if (raw.includes('timed out') || raw.includes('etimedout')) return 'timeout'
  if (raw.includes('nothing to commit') || raw.includes('no changes added')) {
    return 'nothing_to_commit'
  }
  return 'git_command_failed'
}

/** Client/LLM-safe summary per category — no raw git/hook/path text. */
const GIT_CATEGORY_SUMMARY: Record<string, string> = {
  not_a_repo: 'the working directory is not a git repository',
  hook_failed:
    'a git hook rejected the operation — review the hook output in the server logs and fix the underlying issue',
  merge_conflict: 'the operation could not complete due to a merge conflict',
  auth_failed: 'the git operation was not authorized for this repository or remote',
  ref_error:
    'the referenced branch, ref, or path was invalid — verify names with git_branch(list) / git_log',
  timeout: 'the git operation timed out',
  nothing_to_commit: 'there were no changes to commit',
  git_command_failed: 'the git operation failed',
}

/**
 * Contain a git tool error: log full raw detail admin-side (structured stderr)
 * and return a sanitized, category-based summary for the LLM/tool output. The
 * raw stderr / hook output / internal paths never reach the tool result.
 *
 * @param operation Stable operation id for logging/classification.
 * @param err       The raw thrown value.
 * @returns LLM-safe summary string (no host/URL/path/hook-output).
 */
export function handleGitToolError(operation: string, err: unknown): string {
  const category = classifyGitError(err)
  const summary =
    GIT_CATEGORY_SUMMARY[category] ?? GIT_CATEGORY_SUMMARY['git_command_failed']!
  const wrapped = new GitToolError(operation, category, summary, err)

  const rawMessage = err instanceof Error ? err.message : String(err)
  // Full raw detail server-side only — redact secrets before it even hits the
  // admin log so credential-bearing remote URLs are not persisted in plaintext.
  console.error(
    JSON.stringify({
      level: 'error',
      component: 'git-tools',
      operation: wrapped.operation,
      category: wrapped.category,
      error: {
        message: redactSecrets(rawMessage),
        name: err instanceof Error ? err.constructor.name : typeof err,
        stack: err instanceof Error ? redactSecrets(err.stack ?? '') : undefined,
      },
      timestamp: new Date().toISOString(),
    }),
  )

  return wrapped.message
}
