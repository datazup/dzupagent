/**
 * Boundary tests: `@dzupagent/agent-adapters` MUST NOT depend on upstream
 * packages.
 *
 * `@dzupagent/agent-adapters` sits one level below `@dzupagent/server`,
 * `@dzupagent/codegen`, the `@dzupagent/connectors*` family, and other
 * application-layer packages. Importing any of them is a layering violation.
 *
 * Importing `@dzupagent/agent` is allowed (it's a peer/sibling that this
 * package depends on by design — see `package.json`).
 *
 * The list of forbidden upstream packages comes from the `gap_plan` audit
 * (QF-03/QF-04/QF-05).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// here = packages/agent-adapters/src/__tests__/boundary
const SRC_ROOT = resolve(here, '../..')
const PACKAGE_ROOT = resolve(SRC_ROOT, '..')

const FORBIDDEN_UPSTREAM = [
  '@dzupagent/server',
  '@dzupagent/codegen',
  '@dzupagent/connectors',
  '@dzupagent/connectors-browser',
  '@dzupagent/connectors-documents',
  '@dzupagent/express',
  '@dzupagent/otel',
  '@dzupagent/evals',
  '@dzupagent/rag',
  '@dzupagent/scraper',
] as const

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, out)
    } else if (st.isFile() && /\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function extractImportSpecifiers(source: string): string[] {
  const stripped = stripCommentsAndStrings(source)
  const specs: string[] = []
  const importRegex = /\bimport\b[^'";]*?['"]([^'"]+)['"]/g
  const exportFromRegex = /\bexport\b[^'";]*?\bfrom\s+['"]([^'"]+)['"]/g
  const dynamicRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

  for (const re of [importRegex, exportFromRegex, dynamicRegex]) {
    let match: RegExpExecArray | null
    while ((match = re.exec(stripped)) !== null) {
      specs.push(match[1])
    }
  }
  return specs
}

function escapesPackage(filePath: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false
  const abs = resolve(dirname(filePath), specifier)
  const rel = relative(PACKAGE_ROOT, abs)
  return rel.startsWith('..')
}

describe('@dzupagent/agent-adapters ↔ upstream-package boundary', () => {
  const files = walk(SRC_ROOT)

  it('does not import any forbidden upstream packages', () => {
    const violations: Array<{ file: string; specifier: string }> = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const specs = extractImportSpecifiers(source)
      for (const spec of specs) {
        if (FORBIDDEN_UPSTREAM.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`))) {
          violations.push({ file: relative(PACKAGE_ROOT, file), specifier: spec })
        }
      }
    }
    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  ${v.file}: '${v.specifier}'`)
        .join('\n')
      throw new Error(
        `Forbidden upstream-package imports detected in @dzupagent/agent-adapters:\n${formatted}`,
      )
    }
    expect(violations).toEqual([])
  })

  it('does not have relative imports that escape the package root', () => {
    const violations: Array<{ file: string; specifier: string }> = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const specs = extractImportSpecifiers(source)
      for (const spec of specs) {
        if (escapesPackage(file, spec)) {
          violations.push({ file: relative(PACKAGE_ROOT, file), specifier: spec })
        }
      }
    }
    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  ${v.file}: '${v.specifier}'`)
        .join('\n')
      throw new Error(
        `Relative imports escaping the @dzupagent/agent-adapters package root:\n${formatted}`,
      )
    }
    expect(violations).toEqual([])
  })
})
