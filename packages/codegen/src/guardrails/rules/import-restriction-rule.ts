/**
 * Import Restriction Rule — prevents deep imports into package internals.
 *
 * External consumers should only import from a package's public entry
 * point (e.g., '@dzupagent/core'), not from internal paths like
 * '@dzupagent/core/src/internal/secret'.
 */

import type { GuardrailRule, GuardrailContext, GuardrailResult, GuardrailViolation } from '../guardrail-types.js'

const IMPORT_RE = /^\s*import\s+(?:type\s)?(?:\{[^}]*\}|[^;'"]*)\s+from\s+['"]([^'"]+)['"]/

/**
 * Check whether an import path reaches into package internals.
 * Allowed: '@scope/pkg' or '@scope/pkg/index'
 * Disallowed: '@scope/pkg/src/internal/foo'
 */
function isDeepImport(importPath: string, allowedSubpaths: string[]): boolean {
  // Non-scoped package: 'lodash/merge' is sometimes ok, skip
  if (!importPath.startsWith('@')) return false

  // '@scope/pkg' → fine
  const parts = importPath.split('/')
  // Scoped packages have at least @scope/name
  if (parts.length <= 2) return false

  // '@scope/pkg/index' → fine
  const subpath = parts.slice(2).join('/')
  if (subpath === 'index' || subpath === 'index.js' || subpath === 'index.ts') return false

  // Check against allowed subpaths
  if (allowedSubpaths.some((allowed) => subpath === allowed || subpath.startsWith(allowed + '/'))) {
    return false
  }

  return true
}

export interface ImportRestrictionConfig {
  /** Subpaths that are allowed beyond the index (e.g., ['dist', 'types']) */
  allowedSubpaths?: string[]
  /** Package scopes to check (default: ['@dzupagent']) */
  scopes?: string[]
}

export function createImportRestrictionRule(config?: ImportRestrictionConfig): GuardrailRule {
  const allowedSubpaths = config?.allowedSubpaths ?? ['dist', 'types']
  const scopes = config?.scopes ?? ['@dzupagent']

  return {
    id: 'import-restriction',
    name: 'ImportRestrictionRule',
    description: 'Prevents deep imports into package internals — only import from index',
    severity: 'error',
    category: 'imports',
    check(context: GuardrailContext): GuardrailResult {
      const violations: GuardrailViolation[] = []

      for (const file of context.files) {
        const lines = file.content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          const match = IMPORT_RE.exec(line)
          if (!match) continue

          const importPath = match[1]!
          const matchesScope = scopes.some((s) => importPath.startsWith(s + '/'))
          if (!matchesScope) continue

          if (isDeepImport(importPath, allowedSubpaths)) {
            const pkgName = importPath.split('/').slice(0, 2).join('/')
            violations.push({
              ruleId: 'import-restriction',
              file: file.path,
              line: i + 1,
              message: `Deep import "${importPath}" reaches into package internals. Import from "${pkgName}" instead.`,
              severity: 'error',
              suggestion: `Change to: import { ... } from '${pkgName}'`,
              autoFixable: false,
            })
          }
        }
      }

      return { passed: violations.length === 0, violations }
    },
  }
}
