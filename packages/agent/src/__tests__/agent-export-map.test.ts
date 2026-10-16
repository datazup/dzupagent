import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

/**
 * Packaging checks need this package's own built `dist`, which the default
 * test task does not build. Without the packaging flag the spec is reported
 * as skipped, never as passed; with it (see `test:packaging`) a missing
 * `dist` fails the spec instead of returning early.
 */
const PACKAGING_ENV_VAR = 'DZUPAGENT_PACKAGING_TESTS'
const packagingEnabled = (process.env[PACKAGING_ENV_VAR] ?? '').length > 0

describe('agent export map', () => {
  it.skipIf(!packagingEnabled)('imports runtime-expanded subpaths from packed tarball output', async () => {
    await access(join(process.cwd(), 'dist/index.js')).catch(() => {
      throw new Error(
        `${PACKAGING_ENV_VAR} is set but dist/index.js is missing; run build:verify for @dzupagent/agent first`,
      )
    })

    const tempDir = await mkdtemp(join(tmpdir(), 'agent-pack-'))
    try {
      const { stdout } = await execFileAsync('npm', [
        'pack',
        '--json',
        '--pack-destination',
        tempDir,
      ], { cwd: process.cwd() })
      const packed = JSON.parse(stdout) as Array<{ filename: string }>
      const first = packed[0]
      if (!first) throw new Error(`npm pack returned no tarball: ${stdout}`)
      const { filename } = first
      await execFileAsync('tar', ['-xzf', join(tempDir, filename), '-C', tempDir])

      const packageRoot = join(tempDir, 'package')
      const imports = await Promise.all([
        import(pathToFileURL(join(packageRoot, 'dist/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/pipeline.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/runtime.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/workflow.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/runner.js')).href),
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
      expect(imports[4]).toEqual(expect.objectContaining({
        InMemoryAgentRunner: expect.any(Function),
        InMemoryAgentRunStore: expect.any(Function),
        InMemoryAgentEventJournal: expect.any(Function),
        RunControl: expect.any(Function),
      }))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 90_000)
})
