/**
 * Boundary tests: `@dzupagent/agent` MUST NOT depend on upstream packages.
 *
 * Hierarchy (lower depends on higher):
 *   Layer 0 (foundations):   @dzupagent/core, @dzupagent/agent-types,
 *                            @dzupagent/adapter-types, @dzupagent/security,
 *                            @dzupagent/context, @dzupagent/memory,
 *                            @dzupagent/memory-ipc
 *   Layer 1 (this package):  @dzupagent/agent
 *   Layer 2 (downstream):    @dzupagent/agent-adapters, @dzupagent/codegen,
 *                            @dzupagent/connectors{,-browser,-documents},
 *                            @dzupagent/express, @dzupagent/otel,
 *                            @dzupagent/evals, @dzupagent/rag, @dzupagent/scraper,
 *                            @dzupagent/server
 *
 * If any source file in `packages/agent/src/` imports from a Layer 2 package,
 * this test fails — the boundary has been violated. Same goes for
 * `../../../` relative paths that escape the package root.
 *
 * The list of forbidden upstream packages comes from the `gap_plan` audit
 * (QF-03/QF-04/QF-05).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// here = packages/agent/src/__tests__/boundary
// agent src root = packages/agent/src
const SRC_ROOT = resolve(here, '../..')
const PACKAGE_ROOT = resolve(SRC_ROOT, '..')

const FORBIDDEN_UPSTREAM = [
  '@dzupagent/server',
  '@dzupagent/agent-adapters',
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
  // ESM static `import ... from '...'` and side-effect `import '...'`
  const importRegex = /\bimport\b[^'";]*?['"]([^'"]+)['"]/g
  // ESM static `export ... from '...'`
  const exportFromRegex = /\bexport\b[^'";]*?\bfrom\s+['"]([^'"]+)['"]/g
  // dynamic `import('...')`
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
  // Resolve the absolute path the relative specifier refers to.
  const abs = resolve(dirname(filePath), specifier)
  const rel = relative(PACKAGE_ROOT, abs)
  // If the relative path starts with `..`, the import escaped the package.
  return rel.startsWith('..')
}

describe('@dzupagent/agent ↔ upstream-package boundary', () => {
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
        `Forbidden upstream-package imports detected in @dzupagent/agent:\n${formatted}`,
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
        `Relative imports escaping the @dzupagent/agent package root:\n${formatted}`,
      )
    }
    expect(violations).toEqual([])
  })
})
