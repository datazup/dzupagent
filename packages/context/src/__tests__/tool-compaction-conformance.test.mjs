import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

test('completed-tool compaction and pipeline conformance', async () => {
  assert.ok(process.env.TMPDIR?.startsWith('/data/storage/datazup-runtime/ninel/'))
  const { startVitest } = await import('vitest/node')
  const cacheDir = mkdtempSync(path.join(process.env.TMPDIR, 'tool-compaction-'))
  const fixtures = [
    'src/tool-results/__tests__/compact-completed-tool-results.test.ts',
    'src/tool-results/__tests__/compaction-untrusted-input.test.ts',
    'src/tool-results/__tests__/memory-compaction-conformance.test.ts',
    'src/__tests__/auto-compress-tool-results.test.ts',
  ]
  let vitest
  try {
    vitest = await startVitest('test', [], {
      root: packageRoot, config: false, run: true, watch: false,
      include: fixtures, environment: 'node', globals: false,
      unstubEnvs: true, unstubGlobals: true, testTimeout: 30_000,
      fileParallelism: false, maxWorkers: 1, minWorkers: 1,
      pool: 'forks', cache: false, update: false, reporters: ['default'],
    }, { configFile: false, cacheDir })
    const files = vitest.state.getFiles()
    assert.equal(files.length, fixtures.length, 'all conformance fixtures must run')
    assert.deepEqual(vitest.state.getUnhandledErrors(), [])
    assert.deepEqual(files.filter((file) => file.result?.state !== 'pass')
      .map((file) => ({ file: path.relative(packageRoot, file.filepath), state: file.result?.state })), [])
  } finally {
    await vitest?.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('Context TypeScript passes without emitting shared artifacts', () => {
  const config = ts.readConfigFile(path.join(packageRoot, 'tsconfig.json'), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot)
  assert.deepEqual(parsed.errors, [])
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true, incremental: false, composite: false },
  })
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
    file: diagnostic.file ? path.relative(packageRoot, diagnostic.file.fileName) : '<configuration>',
    line: diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 0,
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  }))
  assert.deepEqual(diagnostics, [])
})
