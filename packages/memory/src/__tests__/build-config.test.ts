import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('build config', () => {
  it('uses clean TypeScript emission for one shared deterministic module graph', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: { build: string }
    }

    expect(packageJson.scripts.build).toContain('node scripts/clean-dist.mjs')
    expect(packageJson.scripts.build).toContain('tsc -p tsconfig.build.json')
    expect(packageJson.scripts.build).not.toMatch(/\btsup\b/u)
  })
})
