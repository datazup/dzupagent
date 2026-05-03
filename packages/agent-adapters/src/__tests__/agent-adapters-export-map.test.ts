import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('agent-adapters export map', () => {
  it('exposes narrow runs and integration subpaths', async () => {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8')
    const packageJson = JSON.parse(raw) as { exports: Record<string, unknown> }

    expect(packageJson.exports['./runs']).toEqual({
      import: './dist/runs/index.js',
      types: './dist/runs/index.d.ts',
    })
    expect(packageJson.exports['./integration']).toEqual({
      import: './dist/integration/index.js',
      types: './dist/integration/index.d.ts',
    })
  })
})
