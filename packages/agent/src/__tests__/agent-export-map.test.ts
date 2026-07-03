import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('agent export map', () => {
  it('imports runtime-expanded subpaths from packed tarball output when dist exists', async () => {
    try {
      await access(join(process.cwd(), 'dist/index.js'))
    } catch {
      return
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'agent-pack-'))
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
        import(pathToFileURL(join(packageRoot, 'dist/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/pipeline.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/runtime.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/workflow.js')).href),
      ])

      expect(imports[0]).toEqual(expect.objectContaining({
        DzupAgent: expect.any(Function),
        PipelineRuntime: expect.any(Function),
      }))
      expect(imports[1]).toEqual(expect.objectContaining({
        PipelineRuntime: expect.any(Function),
        createRuntimeToolHandlers: expect.any(Function),
        RedisPipelineCheckpointStore: expect.any(Function),
        PostgresPipelineCheckpointStore: expect.any(Function),
      }))
      expect(imports[2]).toEqual(expect.objectContaining({
        PipelineRuntime: expect.any(Function),
        createRuntimeToolHandlers: expect.any(Function),
        CheckpointExpiredError: expect.any(Function),
        ConcreteRunHandle: expect.any(Function),
      }))
      expect(imports[3]).toEqual(expect.objectContaining({
        CompiledWorkflow: expect.any(Function),
        WorkflowBuilder: expect.any(Function),
        createWorkflow: expect.any(Function),
      }))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 90_000)
})
