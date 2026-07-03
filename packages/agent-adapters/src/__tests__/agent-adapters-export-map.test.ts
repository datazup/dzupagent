import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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

  it('imports recently published subpaths from packed tarball output when dist exists', async () => {
    try {
      await access(join(process.cwd(), 'dist/index.js'))
    } catch {
      return
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'agent-adapters-pack-'))
    try {
      const { stdout } = await execFileAsync('npm', [
        'pack',
        '--json',
        '--pack-destination',
        tempDir,
      ], { cwd: process.cwd() })
      const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>
      await execFileAsync('tar', ['-xzf', join(tempDir, filename), '-C', tempDir])

      const packageRoot = join(tempDir, 'package')
      const imports = await Promise.all([
        import(pathToFileURL(join(packageRoot, 'dist/pipeline/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/runs/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/skills.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/enrichment.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/fleet-executors/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/subagents/index.js')).href),
      ])

      expect(imports[0]).toEqual(expect.objectContaining({
        AdapterPipeline: expect.any(Function),
        createAdapterRuntimeToolHandlers: expect.any(Function),
      }))
      expect(imports[1]).toEqual(expect.objectContaining({
        RunEventStore: expect.any(Function),
        ScriptRunEventStore: expect.any(Function),
      }))
      expect(imports[2]).toEqual(expect.objectContaining({
        AdapterSkillRegistry: expect.any(Function),
        createDefaultSkillRegistry: expect.any(Function),
      }))
      expect(imports[3]).toEqual(expect.objectContaining({
        EnrichmentPipeline: expect.any(Function),
      }))
      expect(imports[4]).toEqual(expect.objectContaining({
        AdapterFleetExecutor: expect.any(Function),
        mapWorkerSpecToAgentExecution: expect.any(Function),
      }))
      expect(imports[5]).toEqual(expect.objectContaining({
        RegistrySubagentExecutor: expect.any(Function),
        createWiredSubagentRuntime: expect.any(Function),
      }))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
