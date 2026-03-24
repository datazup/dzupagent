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

describe('Package boundary enforcement', () => {
  it('@forgeagent/core imports no other @forgeagent packages', () => {
    const imports = scanForgeImports(SRC_DIR)
    const violations = imports.filter(
      i => !i.importPath.startsWith('@forgeagent/core'),
    )

    if (violations.length > 0) {
      const details = violations
        .map(v => `  ${v.file} imports "${v.importPath}"`)
        .join('\n')
      expect.fail(
        `@forgeagent/core must not import from other @forgeagent packages:\n${details}`,
      )
    }

    expect(violations).toHaveLength(0)
  })
})
