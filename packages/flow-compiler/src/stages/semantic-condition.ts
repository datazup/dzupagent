import { validateFlowConditionExpression, type FlowNode } from '@dzupagent/flow-ast'

import type { WalkContext } from './semantic-context.js'

// ---------------------------------------------------------------------------
// Condition expression validation (Stage 3 / R3)
// ---------------------------------------------------------------------------

/**
 * Validate a condition expression string (`branch.condition` or
 * `for_each.source`) by:
 *   1. Rejecting known unsafe patterns (eval, dynamic Function/import).
 *   2. Checking the expression against the shared runtime-supported subset.
 *
 * Emits `INVALID_CONDITION` into `ctx.errors` on failure; silently
 * passes valid expressions.
 *
 * Stage 2 already ensures the field is a non-empty string, so an empty
 * value here means stage 2 was skipped — we skip validation too (stage 2
 * already owns that diagnostic).
 */
export function validateConditionExpr(
  nodeType: FlowNode['type'],
  expr: string,
  nodePath: string,
  fieldLabel: string,
  ctx: WalkContext,
): void {
  if (!expr) return

  const validation = validateFlowConditionExpression(expr, {
    referencePolicy: ctx.referencePolicy,
    ...(ctx.referenceBindings !== undefined
      ? { knownBindings: ctx.referenceBindings }
      : {}),
  })
  if (validation.valid) return

  if (validation.reason.includes('disallowed construct')) {
    ctx.errors.push({
      nodeType,
      nodePath,
      code: 'INVALID_CONDITION',
      category: 'shape',
      message: `${fieldLabel} contains a disallowed construct (eval, dynamic Function, or import): "${expr}".`,
    })
    return
  }

  ctx.errors.push({
    nodeType,
    nodePath,
    code: 'INVALID_CONDITION',
    category: 'shape',
    message: `${fieldLabel} is not a valid expression in the runtime-supported expression subset: ${validation.reason}`,
  })
}

// ---------------------------------------------------------------------------
// Suggestion ranking
// ---------------------------------------------------------------------------

const MAX_SUGGESTIONS = 3

/**
 * Return up to {@link MAX_SUGGESTIONS} closest matches from `haystack` to
 * `needle` within `maxDistance` Levenshtein edits, sorted by distance then
 * alphabetically. Used for "did you mean?" diagnostics on unresolved tool
 * and persona references.
 */
export function topSuggestions(
  needle: string,
  haystack: readonly string[],
  maxDistance: number,
): string[] {
  const scored: Array<{ name: string; distance: number }> = []
  for (const candidate of haystack) {
    if (candidate === needle) continue
    const distance = levenshtein(needle, candidate)
    if (distance <= maxDistance) {
      scored.push({ name: candidate, distance })
    }
  }
  scored.sort((a, b) => (a.distance - b.distance) || a.name.localeCompare(b.name))
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.name)
}

/**
 * Iterative two-row Levenshtein. Small, dependency-free, O(m*n) time / O(n)
 * space. Adequate for ref strings of typical length (≤64 chars) and registry
 * sizes encountered by the compiler.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  const dp: number[] = new Array(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j

  for (let i = 1; i <= m; i++) {
    let prev = dp[0] ?? 0
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j] ?? 0
      const left = dp[j - 1] ?? 0
      const up = dp[j] ?? 0
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, up, left)
      prev = tmp
    }
  }
  return dp[n] ?? 0
}
