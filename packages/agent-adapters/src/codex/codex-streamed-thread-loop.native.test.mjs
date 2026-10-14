import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import ts from 'typescript'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

// Fixed, provider-free native entrypoint, following agent's existing native
// qualification tests. No package/config runner or caller-selected suite runs.
test('streamed Codex identity, approval and adapter regressions pass', async () => {
  assert.ok(process.env.TMPDIR?.startsWith('/data/storage/datazup-runtime/ninel/'))
  const cacheDir = mkdtempSync(path.join(process.env.TMPDIR, 'transport-g6-vitest-'))
  const fixtures = [
    'src/codex/codex-streamed-thread-loop.test.ts',
    'src/codex/codex-streamed-thread.test.ts',
    'src/__tests__/codex-adapter.test.ts',
    'src/__tests__/codex-adapter-deep.test.ts',
    'src/__tests__/codex-adapter-concurrency.test.ts',
  ]
  let vitest
  try {
    const { startVitest } = await import('vitest/node')
    vitest = await startVitest('test', [], {
      root: packageRoot, config: false, run: true, watch: false,
      include: fixtures, environment: 'node', globals: false,
      unstubEnvs: true, unstubGlobals: true, testTimeout: 30_000,
      fileParallelism: false, maxWorkers: 1, minWorkers: 1,
      pool: 'forks', cache: false, update: false, reporters: ['default'],
    }, { configFile: false, cacheDir })
    assert.ok(vitest, 'installed Vitest must start')
    const files = vitest.state.getFiles()
    assert.equal(files.length, fixtures.length, 'every fixed suite must run')
    assert.deepEqual(vitest.state.getUnhandledErrors(), [])
    assert.deepEqual(files.filter(file => file.result?.state !== 'pass')
      .map(file => ({ file: path.basename(file.filepath), state: file.result?.state,
        errors: file.result?.errors?.map(error => error.message) })), [])
  } finally {
    await vitest?.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('agent-adapters production TypeScript passes without emitting', () => {
  const config = ts.readConfigFile(path.join(packageRoot, 'tsconfig.json'), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot)
  assert.deepEqual(parsed.errors, [])
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true, incremental: false, composite: false },
  })
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ({
    file: diagnostic.file ? path.relative(packageRoot, diagnostic.file.fileName) : '<configuration>',
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  })), [])
})
