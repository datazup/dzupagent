import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import * as testingSurface from '../testing/index.js'

const runtimeNames = [
  'censusOf',
  'createMemoryCompactionConformanceSuite',
  'createMemoryDeletionConformanceSuite',
  'createMemoryHarness',
  'createMemoryLifecycleConformanceSuite',
  'createMemoryRecordConformanceSuite',
  'createMemoryRetrievalConformanceSuite',
  'createMemoryStoreConformanceSuite',
  'createMemoryWorkerConformanceSuite',
  'expectCompactedCountIsTruthful',
  'expectNoDuplicateAfterRewrite',
  'expectPrunedCountIsTruthful',
  'expectRepeatedPassesDoNotGrow',
  'expectScopeIsPopulated',
]
const declarationNames = [
  'MemoryBenchmarkProfileV1',
  'MemoryHarness',
  'MemoryHarnessOptions',
  'StoreCensus',
  'TruthfulnessTarget',
  ...runtimeNames,
].sort()
const execFileAsync = promisify(execFile)

describe('@dzupagent/memory/testing export', () => {
  it('declares exactly the admitted nineteen-name test-only surface', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(packageJson.exports['./testing']).toEqual({
      import: './dist/testing/index.js',
      types: './dist/testing/index.d.ts',
    })
    expect(Object.keys(testingSurface).sort()).toEqual(runtimeNames)

    const index = await readFile(join(process.cwd(), 'src/testing/index.ts'), 'utf8')
    for (const name of declarationNames) expect(index).toContain(name)
  })

  it('does not widen the compatibility root barrel', async () => {
    const rootIndex = await readFile(join(process.cwd(), 'src/index.ts'), 'utf8')
    for (const name of runtimeNames.filter(name => name.startsWith('createMemory'))) {
      expect(rootIndex).not.toContain(name)
    }
  })

  it('resolves the built runtime and declaration contract', async () => {
    try {
      await access(join(process.cwd(), 'dist/testing/index.js'))
      await access(join(process.cwd(), 'dist/testing/index.d.ts'))
    } catch {
      return
    }
    const builtSurface = await import('@dzupagent/memory/testing')
    expect(Object.keys(builtSurface).sort()).toEqual(runtimeNames)

    const fixtureDir = await mkdtemp(join(process.cwd(), '.testing-types-'))
    try {
      const fixture = join(fixtureDir, 'consumer.ts')
      await writeFile(fixture, [
        "import { createMemoryCompactionConformanceSuite, createMemoryDeletionConformanceSuite, createMemoryLifecycleConformanceSuite, createMemoryRecordConformanceSuite, createMemoryRetrievalConformanceSuite, createMemoryStoreConformanceSuite, createMemoryWorkerConformanceSuite, type MemoryBenchmarkProfileV1 } from '@dzupagent/memory/testing'",
        "import { createMemoryHarness } from '@dzupagent/memory/testing'",
        '// @ts-expect-error conformance contracts are intentionally subpath-only',
        "import { createMemoryStoreConformanceSuite as rootSuite } from '@dzupagent/memory'",
        'declare const profile: MemoryBenchmarkProfileV1',
        'void profile',
        'void createMemoryHarness',
        'void createMemoryCompactionConformanceSuite',
        'void createMemoryDeletionConformanceSuite',
        'void createMemoryLifecycleConformanceSuite',
        'void createMemoryRecordConformanceSuite',
        'void createMemoryRetrievalConformanceSuite',
        'void createMemoryStoreConformanceSuite',
        'void createMemoryWorkerConformanceSuite',
        'void rootSuite',
      ].join('\n'), 'utf8')
      await execFileAsync(process.execPath, [
        join(process.cwd(), '../../node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        fixture,
      ], { cwd: process.cwd() })
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  })
})
