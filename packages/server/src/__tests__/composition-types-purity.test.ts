import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const currentDir = dirname(fileURLToPath(import.meta.url))
const compositionTypesPath = resolve(currentDir, '../composition/types.ts')

describe('composition types purity', () => {
  it('imports route contracts through type-only siblings', () => {
    const source = readFileSync(compositionTypesPath, 'utf-8')
    const runtimeRouteImports = [
      'memory-health',
      'run-context',
      'deploy',
      'learning',
      'benchmarks',
      'evals',
      'compile',
      'a2a',
    ].map((route) => `../routes/${route}.js`)

    for (const routeImport of runtimeRouteImports) {
      expect(source).not.toContain(routeImport)
    }
  })
})
