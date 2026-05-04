/**
 * check-layer-boundaries.mjs
 *
 * Enforces source-level layering between sibling workspace packages.
 *
 * Specifically: production source files in `packages/agent-adapters/src/**`
 * MUST NOT reach into `packages/agent/src/**` via relative path. They must
 * import the public `@dzupagent/agent` (or subpath) entry instead. Direct
 * source imports break the package boundary, side-step published exports,
 * and pull internal modules into the adapter build graph.
 *
 * The check ignores:
 *   - test files matching *.test.ts, *.spec.ts
 *   - anything inside __tests__/
 *   - declaration files (*.d.ts)
 *
 * Usage:
 *   node scripts/check-layer-boundaries.mjs
 *
 * Exit codes:
 *   0 — clean
 *   1 — at least one violation found
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const repoRoot = process.cwd()
const packagesDir = join(repoRoot, 'packages')

/**
 * Layer rules. Each rule names an importer package directory and the
 * forbidden source-path prefixes it must not relatively reach into.
 */
const LAYER_RULES = [
  {
    importer: 'agent-adapters',
    forbiddenSourcePathSegments: ['agent/src'],
    rationale:
      'agent-adapters must consume agent through its published @dzupagent/agent ' +
      '(or subpath) entry, not by reaching into agent/src/** with a relative path.',
  },
]

function isProductionSourceFile(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  if (!/\.(?:c|m)?[jt]sx?$/.test(normalized)) return false
  if (/\.d\.[cm]?ts$/.test(normalized)) return false
  if (/(?:^|\/)__tests__(?:\/|$)/.test(normalized)) return false
  if (/\.(?:test|spec)\.(?:c|m)?[jt]sx?$/.test(normalized)) return false
  return true
}

function listProductionSourceFiles(srcDir) {
  const files = []

  function walk(dir) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (entry === 'dist' || entry === 'node_modules' || entry === '__tests__') continue
        walk(fullPath)
      } else if (stat.isFile() && isProductionSourceFile(fullPath)) {
        files.push(fullPath)
      }
    }
  }

  walk(srcDir)
  return files
}

/**
 * Match a relative `from '...path...'` or dynamic `import('...path...')`
 * specifier and return its specifier text, plus the line number.
 */
function* findRelativeImports(source) {
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]+?\s+from\s*)?(['"])(\.{1,2}\/[^'"]+)\1/g,
    /\bexport\s+(?:type\s+)?[^'";]+?\s+from\s*(['"])(\.{1,2}\/[^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
    /\brequire(?:\.resolve)?\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[2]
      const line = source.slice(0, match.index).split('\n').length
      yield { specifier, line }
    }
  }
}

const violations = []

for (const rule of LAYER_RULES) {
  const importerSrcDir = join(packagesDir, rule.importer, 'src')
  const sourceFiles = listProductionSourceFiles(importerSrcDir)

  for (const file of sourceFiles) {
    const source = readFileSync(file, 'utf8')
    for (const { specifier, line } of findRelativeImports(source)) {
      const normalized = specifier.replaceAll('\\', '/')
      for (const segment of rule.forbiddenSourcePathSegments) {
        if (normalized.includes(`/${segment}/`) || normalized.endsWith(`/${segment}`)) {
          violations.push({
            importer: rule.importer,
            file: relative(repoRoot, file),
            specifier,
            line,
            forbidden: segment,
            rationale: rule.rationale,
          })
          break
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('LAYER BOUNDARY VIOLATIONS DETECTED')
  console.error('==================================')
  console.error('Sibling packages must consume each other through their published')
  console.error('@dzupagent/* entry (or a declared subpath), not by reaching into')
  console.error('the other package\'s src/** with a relative path.\n')

  for (const v of violations) {
    console.error(`  FORBIDDEN: ${v.importer} reaches into "${v.forbidden}/**"`)
    console.error(`  FILE:      ${v.file}:${v.line}`)
    console.error(`  SOURCE:    ${v.specifier}`)
    console.error(`  WHY:       ${v.rationale}`)
    console.error()
  }

  console.error('How to fix:')
  console.error('  - Replace the relative import with the public package entry, e.g.')
  console.error("    import { X } from '@dzupagent/agent' or '@dzupagent/agent/<subpath>'.")
  console.error('  - If the symbol is not exported, add it to the appropriate barrel')
  console.error('    or subpath in the source package before consuming it.')
  console.error()

  process.exit(1)
}

console.log(
  'Layer boundary check passed — no relative source-path imports across sibling @dzupagent/* packages.',
)
