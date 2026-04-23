import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SRC_DIR = join(__dirname, '..')
const PACKAGE_ROOT = join(SRC_DIR, '..')

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
 * @dzupagent/core is a re-export hub that intentionally depends on
 * @dzupagent/memory, @dzupagent/context, and optionally @dzupagent/memory-ipc.
 * These are declared in package.json dependencies/peerDependencies.
 *
 * This test ensures core does NOT import from packages outside that
 * explicit allowlist (e.g., @dzupagent/agent, @dzupagent/codegen).
 */
const ALLOWED_IMPORTS = new Set([
  '@dzupagent/core',
  '@dzupagent/memory',
  '@dzupagent/context',
  '@dzupagent/memory-ipc',
  '@dzupagent/runtime-contracts',
  '@dzupagent/agent-types', // Layer 0 canonical types (RetryPolicy, StuckDetectorConfig, etc.)
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

  it('root index does not import optional memory-ipc at package import time', () => {
    const rootIndex = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8')
    expect(rootIndex).not.toContain("from './memory-ipc.js'")
    expect(rootIndex).not.toContain("@dzupagent/memory-ipc")
  })

  it('@dzupagent/core has at least one re-export from @dzupagent/memory', () => {
    const imports = scanForgeImports(SRC_DIR)
    const memoryImports = imports.filter(i => i.importPath.startsWith('@dzupagent/memory'))
    expect(memoryImports.length).toBeGreaterThan(0)
  })

  it('@dzupagent/core has at least one re-export from @dzupagent/context', () => {
    const imports = scanForgeImports(SRC_DIR)
    const contextImports = imports.filter(i => i.importPath.startsWith('@dzupagent/context'))
    expect(contextImports.length).toBeGreaterThan(0)
  })

  it('@dzupagent/core exposes memory-ipc as an explicit subpath export', () => {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports?: Record<string, { import?: string; types?: string }>
    }

    expect(packageJson.exports?.['./memory-ipc']).toEqual({
      import: './dist/memory-ipc.js',
      types: './dist/memory-ipc.d.ts',
    })
  })
})
