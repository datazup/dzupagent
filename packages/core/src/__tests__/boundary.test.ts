import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SRC_DIR = join(__dirname, '..')

/**
 * Scan all .ts files in a directory recursively and extract
 * @forgeagent/* import paths.
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

    const importRegex = /from\s+['"](@forgeagent\/[^'"]+)['"]/g
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
 * @forgeagent/core is a re-export hub that intentionally depends on
 * @forgeagent/memory, @forgeagent/context, and optionally @forgeagent/memory-ipc.
 * These are declared in package.json dependencies/peerDependencies.
 *
 * This test ensures core does NOT import from packages outside that
 * explicit allowlist (e.g., @forgeagent/agent, @forgeagent/codegen).
 */
const ALLOWED_IMPORTS = new Set([
  '@forgeagent/core',
  '@forgeagent/memory',
  '@forgeagent/context',
  '@forgeagent/memory-ipc',
])

describe('Package boundary enforcement', () => {
  it('@forgeagent/core only imports from allowed @forgeagent packages', () => {
    const imports = scanForgeImports(SRC_DIR)
    const violations = imports.filter(i => {
      // Extract the package name (e.g., "@forgeagent/memory" from "@forgeagent/memory/foo")
      const parts = i.importPath.split('/')
      const pkgName = parts.slice(0, 2).join('/')
      return !ALLOWED_IMPORTS.has(pkgName)
    })

    if (violations.length > 0) {
      const details = violations
        .map(v => `  ${v.file} imports "${v.importPath}"`)
        .join('\n')
      expect.fail(
        `@forgeagent/core imports disallowed @forgeagent packages:\n${details}`,
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('@forgeagent/core has at least one re-export from @forgeagent/memory', () => {
    const imports = scanForgeImports(SRC_DIR)
    const memoryImports = imports.filter(i => i.importPath.startsWith('@forgeagent/memory'))
    expect(memoryImports.length).toBeGreaterThan(0)
  })

  it('@forgeagent/core has at least one re-export from @forgeagent/context', () => {
    const imports = scanForgeImports(SRC_DIR)
    const contextImports = imports.filter(i => i.importPath.startsWith('@forgeagent/context'))
    expect(contextImports.length).toBeGreaterThan(0)
  })
})
