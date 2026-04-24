import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SRC_DIR = join(__dirname, '..')

/**
 * Scan all .ts files in a directory recursively and extract
 * @dzupagent/* import paths.
 */
function scanForgeImports(dir: string): Array<{ file: string; importPath: string }> {
  const results: Array<{ file: string; importPath: string }> = []
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true })

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue

    const fullPath = join(entry.parentPath ?? entry.path, entry.name)
    const content = readFileSync(fullPath, 'utf8')

    const importRegex = /from\s+['"](@dzupagent\/[^'"]+)['"]/g
    let match
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1]!
      results.push({
        file: fullPath.replace(SRC_DIR, 'src/'),
        importPath,
      })
    }
  }

  return results
}

/**
 * @dzupagent/core is the dependency root (Layer 1). It must not import from
 * any Layer-2 package (memory, context, memory-ipc, agent, codegen, etc.).
 *
 * Only a small set of foundational type packages are permitted:
 *   - @dzupagent/agent-types      — canonical primitive types (RetryPolicy, etc.)
 *   - @dzupagent/runtime-contracts — shared runtime protocol contracts
 *
 * MC-A01 removed the previous core -> memory / context / memory-ipc imports
 * (see audit/full-dzupagent-2026-04-23/run-001/implementation/phase-major/
 * mc-a01-core-layer-inversion/).
 */
const ALLOWED_IMPORTS = new Set([
  '@dzupagent/core',
  '@dzupagent/runtime-contracts',
  '@dzupagent/agent-types',
])

describe('Package boundary enforcement', () => {
  it('@dzupagent/core only imports from allowed @dzupagent packages', () => {
    const imports = scanForgeImports(SRC_DIR)
    const violations = imports.filter(i => {
      // Extract the package name (e.g., "@dzupagent/memory" from "@dzupagent/memory/foo")
      const parts = i.importPath.split('/')
      const pkgName = parts.slice(0, 2).join('/')
      return !ALLOWED_IMPORTS.has(pkgName)
    })

    if (violations.length > 0) {
      const details = violations
        .map(v => `  ${v.file} imports "${v.importPath}"`)
        .join('\n')
      expect.fail(
        `@dzupagent/core imports disallowed @dzupagent packages:\n${details}`,
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('does not import @dzupagent/memory (Layer 2)', () => {
    const imports = scanForgeImports(SRC_DIR)
    const memoryImports = imports.filter(i => i.importPath.startsWith('@dzupagent/memory'))
    if (memoryImports.length > 0) {
      const detail = memoryImports.map(v => `  ${v.file} imports "${v.importPath}"`).join('\n')
      expect.fail(`@dzupagent/core must not import @dzupagent/memory:\n${detail}`)
    }
    expect(memoryImports).toHaveLength(0)
  })

  it('does not import @dzupagent/context (Layer 2)', () => {
    const imports = scanForgeImports(SRC_DIR)
    const contextImports = imports.filter(i => i.importPath.startsWith('@dzupagent/context'))
    if (contextImports.length > 0) {
      const detail = contextImports.map(v => `  ${v.file} imports "${v.importPath}"`).join('\n')
      expect.fail(`@dzupagent/core must not import @dzupagent/context:\n${detail}`)
    }
    expect(contextImports).toHaveLength(0)
  })

  it('does not import @dzupagent/memory-ipc (Layer 2)', () => {
    const imports = scanForgeImports(SRC_DIR)
    const ipcImports = imports.filter(i => i.importPath.startsWith('@dzupagent/memory-ipc'))
    if (ipcImports.length > 0) {
      const detail = ipcImports.map(v => `  ${v.file} imports "${v.importPath}"`).join('\n')
      expect.fail(`@dzupagent/core must not import @dzupagent/memory-ipc:\n${detail}`)
    }
    expect(ipcImports).toHaveLength(0)
  })

  it('root index does not reference the deleted memory-ipc subpath', () => {
    const rootIndex = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8')
    expect(rootIndex).not.toContain("from './memory-ipc.js'")
    expect(rootIndex).not.toContain("@dzupagent/memory-ipc")
  })
})
