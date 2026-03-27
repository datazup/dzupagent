import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SRC_DIR = join(__dirname, '..')

/**
 * Scan all .ts files in a directory recursively and extract
 * @dzipagent/* import paths.
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

    const importRegex = /from\s+['"](@dzipagent\/[^'"]+)['"]/g
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
 * @dzipagent/core is a re-export hub that intentionally depends on
 * @dzipagent/memory, @dzipagent/context, and optionally @dzipagent/memory-ipc.
 * These are declared in package.json dependencies/peerDependencies.
 *
 * This test ensures core does NOT import from packages outside that
 * explicit allowlist (e.g., @dzipagent/agent, @dzipagent/codegen).
 */
const ALLOWED_IMPORTS = new Set([
  '@dzipagent/core',
  '@dzipagent/memory',
  '@dzipagent/context',
  '@dzipagent/memory-ipc',
])

describe('Package boundary enforcement', () => {
  it('@dzipagent/core only imports from allowed @dzipagent packages', () => {
    const imports = scanForgeImports(SRC_DIR)
    const violations = imports.filter(i => {
      // Extract the package name (e.g., "@dzipagent/memory" from "@dzipagent/memory/foo")
      const parts = i.importPath.split('/')
      const pkgName = parts.slice(0, 2).join('/')
      return !ALLOWED_IMPORTS.has(pkgName)
    })

    if (violations.length > 0) {
      const details = violations
        .map(v => `  ${v.file} imports "${v.importPath}"`)
        .join('\n')
      expect.fail(
        `@dzipagent/core imports disallowed @dzipagent packages:\n${details}`,
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('@dzipagent/core has at least one re-export from @dzipagent/memory', () => {
    const imports = scanForgeImports(SRC_DIR)
    const memoryImports = imports.filter(i => i.importPath.startsWith('@dzipagent/memory'))
    expect(memoryImports.length).toBeGreaterThan(0)
  })

  it('@dzipagent/core has at least one re-export from @dzipagent/context', () => {
    const imports = scanForgeImports(SRC_DIR)
    const contextImports = imports.filter(i => i.importPath.startsWith('@dzipagent/context'))
    expect(contextImports.length).toBeGreaterThan(0)
  })
})
