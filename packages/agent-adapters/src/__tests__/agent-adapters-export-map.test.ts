import { describe, expect, it } from 'vitest'
import { access, readFile } from 'node:fs/promises'
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
    expect(packageJson.exports['./pipeline']).toEqual({
      import: './dist/pipeline/index.js',
      types: './dist/pipeline/index.d.ts',
    })
    expect(packageJson.exports['./dzupagent']).toEqual({
      import: './dist/dzupagent/index.js',
      types: './dist/dzupagent/index.d.ts',
    })
  })

  it('imports the pipeline package subpath from built artifacts when dist exists', async () => {
    const builtPipeline = join(process.cwd(), 'dist/pipeline/index.js')
    try {
      await access(builtPipeline)
    } catch {
      return
    }

    const mod = await import(builtPipeline)

    expect(mod).toEqual(expect.objectContaining({
      AdapterPipeline: expect.any(Function),
      createAdapterRuntimeToolHandlers: expect.any(Function),
    }))
  })
})
