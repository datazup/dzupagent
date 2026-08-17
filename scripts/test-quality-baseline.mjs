/**
 * Shared logic for the per-violation test-quality baseline (eslint.baseline.js).
 *
 * The baseline records, per file and per rule, HOW MANY violations existed when
 * the three test-quality rules were promoted from `warn` to `error`. A listed
 * file keeps warning instead of failing, but it now has a ceiling: `yarn lint`
 * fails if a recorded count rises, if a file with test-quality violations is not
 * recorded at all, or if a recorded count is stale because violations were fixed
 * without lowering the number.
 *
 * Before this existed the baseline was a plain list of file names, so any listed
 * file could accrue unlimited new violations while the gate stayed green — the
 * stateless-memory-double count drifted 135 -> 139 exactly that way.
 */

import path from 'node:path'

/** ESLint rule that carries all three test-quality selectors. */
export const TEST_QUALITY_ESLINT_RULE = 'no-restricted-syntax'

/**
 * Stable ids for the three selectors in eslint.config.js, matched by the leading
 * text of each selector's `message`. Classification FAILS CLOSED: a
 * `no-restricted-syntax` message that matches no prefix is reported as an error
 * rather than ignored, so editing a message in eslint.config.js without updating
 * this table breaks the build instead of silently disabling the ceiling.
 */
export const TEST_QUALITY_RULES = [
  { id: 'stateless-memory-double', messagePrefix: 'Stateless memory double:' },
  { id: 'vacuous-every', messagePrefix: 'Vacuous on an empty array:' },
  { id: 'real-set-timeout', messagePrefix: 'Avoid real setTimeout in tests.' },
]

export const TEST_QUALITY_RULE_IDS = TEST_QUALITY_RULES.map((rule) => rule.id)

/** @returns {string|null} rule id, or null when the message is not a test-quality one. */
export function classifyTestQualityMessage(message) {
  if (typeof message !== 'string') return null
  const match = TEST_QUALITY_RULES.find((rule) => message.startsWith(rule.messagePrefix))
  return match ? match.id : null
}

export function toRepoRelativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

/**
 * Reduce ESLint results to { [repoRelativePath]: { [ruleId]: count } }.
 *
 * Both severities are counted. A baselined file only warns, but counting errors
 * too means the ceiling still works if a file is dropped from the baseline or a
 * severity is changed.
 *
 * @returns {{ counts: Record<string, Record<string, number>>, lintedFiles: string[], unclassified: Array<{file: string, message: string}> }}
 */
export function collectTestQualityCounts(results, { root, severities }) {
  const counts = {}
  const lintedFiles = []
  const unclassified = []
  for (const result of results) {
    const file = toRepoRelativePath(root, result.filePath)
    lintedFiles.push(file)
    for (const message of result.messages ?? []) {
      if (message.ruleId !== TEST_QUALITY_ESLINT_RULE) continue
      if (severities && !severities.includes(message.severity)) continue
      const ruleId = classifyTestQualityMessage(message.message)
      if (!ruleId) {
        unclassified.push({ file, message: message.message })
        continue
      }
      counts[file] ??= {}
      counts[file][ruleId] = (counts[file][ruleId] ?? 0) + 1
    }
  }
  return { counts, lintedFiles, unclassified }
}

function ruleIdsIn(...records) {
  const ids = new Set()
  for (const record of records) for (const id of Object.keys(record ?? {})) ids.add(id)
  return [...ids].sort()
}

/**
 * Compare observed counts against the recorded baseline for one scope (a package
 * directory, repo-relative, e.g. `packages/memory/`).
 *
 * A file is only judged stale when it was actually linted in this run or has
 * disappeared from the scope entirely; that keeps a partial lint (one package)
 * from reporting the rest of the repo as stale.
 *
 * @returns {{ problems: Array<{kind: string, file: string, ruleId?: string, expected?: number, actual?: number, message: string}> }}
 */
export function diffTestQualityCounts({ observed, baseline, scope, lintedFiles }) {
  const linted = new Set(lintedFiles)
  const inScope = (file) => (scope ? file.startsWith(scope) : true)
  const problems = []

  const files = new Set([
    ...Object.keys(observed).filter(inScope),
    ...Object.keys(baseline).filter(inScope),
  ])

  for (const file of [...files].sort()) {
    const actualCounts = observed[file] ?? {}
    const expectedCounts = baseline[file]

    if (!expectedCounts) {
      const total = Object.values(actualCounts).reduce((sum, n) => sum + n, 0)
      if (total > 0) {
        problems.push({
          kind: 'unbaselined-file',
          file,
          actual: total,
          message:
            `${file}: ${total} test-quality violation(s) in a file that is not in eslint.baseline.js. `
            + 'Fix them — the baseline is closed to new entries.',
        })
      }
      continue
    }

    // Not linted in this run and not deleted from disk in a way we can see:
    // skip, another package's lint owns it.
    const wasLinted = linted.has(file)

    for (const ruleId of ruleIdsIn(actualCounts, expectedCounts)) {
      const expected = expectedCounts[ruleId] ?? 0
      const actual = actualCounts[ruleId] ?? 0
      if (actual > expected) {
        problems.push({
          kind: 'count-increased',
          file,
          ruleId,
          expected,
          actual,
          message:
            `${file}: ${ruleId} rose ${expected} -> ${actual}. `
            + 'eslint.baseline.js is a ceiling, not a permit: fix the new violation.',
        })
      } else if (actual < expected && wasLinted) {
        problems.push({
          kind: 'baseline-stale',
          file,
          ruleId,
          expected,
          actual,
          message:
            `${file}: ${ruleId} fell ${expected} -> ${actual}, but eslint.baseline.js still records ${expected}. `
            + 'Run `yarn lint:baseline:update` so the ratchet keeps the ground it gained.',
        })
      }
    }
  }

  return { problems }
}

/** Sum of every recorded violation under `scope` — the natural --max-warnings budget. */
export function baselineWarningBudget(baseline, scope) {
  let total = 0
  for (const [file, counts] of Object.entries(baseline)) {
    if (scope && !file.startsWith(scope)) continue
    for (const count of Object.values(counts)) total += count
  }
  return total
}
