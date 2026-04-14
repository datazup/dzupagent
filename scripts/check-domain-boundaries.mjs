/**
 * check-domain-boundaries.mjs
 *
 * Enforces the architectural boundary rule:
 *   Universal @dzupagent/* packages MUST NOT import domain-specific packages.
 *
 * Domain packages were extracted from dzupagent/packages/ during the refactoring
 * described in DZUPAGENT_REFACTORING.md. Any re-introduction of these imports is
 * a boundary violation and must be caught in CI.
 *
 * Usage:
 *   node scripts/check-domain-boundaries.mjs
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const repoRoot = process.cwd()
const packagesDir = join(repoRoot, 'packages')

/**
 * Domain packages that were moved out of dzupagent/packages/.
 * Any import of these inside packages/ is a boundary violation.
 */
const FORBIDDEN_IMPORTS = [
  '@dzupagent/domain-nl2sql',
  '@dzupagent/workflow-domain',
  '@dzupagent/org-domain',
  '@dzupagent/persona-registry',
  '@dzupagent/scheduler',
  '@dzupagent/execution-ledger',
]

/**
 * Run ripgrep and return matching lines (empty array = no matches).
 */
function rg(args) {
  try {
    const output = execFileSync('rg', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return output.trim().split('\n').filter(Boolean)
  } catch (error) {
    // rg exits with code 1 when no matches are found — that is success here
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return []
    }
    throw error
  }
}

const violations = []

for (const pkg of FORBIDDEN_IMPORTS) {
  // Match any import/require/dynamic-import of the forbidden package inside packages/
  // Exclude dist/, node_modules/, and test files (*.test.ts, __tests__/)
  const pattern = `['"]${pkg}['"/]`
  const matches = rg([
    '--glob', '!**/dist/**',
    '--glob', '!**/node_modules/**',
    '--glob', '!**/*.test.ts',
    '--glob', '!**/__tests__/**',
    '-l',                           // print only file paths
    '-e', pattern,
    packagesDir,
  ])

  for (const file of matches) {
    violations.push({ pkg, file })
  }
}

if (violations.length === 0) {
  console.log('Domain boundary check passed — no forbidden imports found in dzupagent/packages/.')
  process.exit(0)
}

console.error('DOMAIN BOUNDARY VIOLATIONS DETECTED')
console.error('======================================')
console.error('The following universal packages import domain-specific packages')
console.error('that have been moved out of dzupagent. This violates the architectural')
console.error('boundary defined in DZUPAGENT_REFACTORING.md.\n')

for (const { pkg, file } of violations) {
  console.error(`  FORBIDDEN: import of "${pkg}"`)
  console.error(`  FILE:      ${file.replace(repoRoot + '/', '')}`)
  console.error()
}

console.error('How to fix:')
console.error('  - If the import is in production code, move the logic to the owning app package.')
console.error('  - If the import is in a compatibility shim, it belongs in packages/shims/, not in a universal package src/.')
console.error('  - See DZUPAGENT_REFACTORING.md §8 for boundary contracts.')

process.exit(1)
