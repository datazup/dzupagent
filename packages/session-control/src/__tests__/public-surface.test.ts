import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as root from '../index.js'
import * as testing from '../testing.js'

/**
 * DZUPAGENT-ARCH-M-14: the root barrel published the whole tree through twelve
 * `export *` lines, including the in-memory reference store and ledger. The root
 * is now enumerated explicitly and capped in config/barrel-budgets.json; the
 * reference doubles and conformance helpers live on `./testing`, with the root
 * re-exports kept as transitional compatibility.
 */
function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

describe('@dzupagent/session-control public surface', () => {
  it('root index has no export-star statements', () => {
    expect(readSource('../index.ts')).not.toMatch(/^\s*export\s+(?:type\s+)?\*/m)
  })

  it('./testing exposes the in-memory reference implementations and conformance helpers', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'InMemoryCommandLedger',
      'InMemorySessionStore',
      'scanPortableSessionControlValue',
      'validateSessionControlConformanceFixture',
    ])
    expect(new testing.InMemorySessionStore()).toBeInstanceOf(root.InMemorySessionStore)
  })

  it('root keeps the transitional re-exports identical to ./testing', () => {
    for (const [name, value] of Object.entries(testing)) {
      expect((root as Record<string, unknown>)[name], name).toBe(value)
    }
  })

  it('package.json publishes the ./testing subpath', () => {
    const manifest = JSON.parse(readSource('../../package.json')) as {
      exports: Record<string, { import?: string; types?: string }>
    }
    expect(manifest.exports['./testing']).toEqual({
      import: './dist/testing.js',
      types: './dist/testing.d.ts',
    })
  })
})
