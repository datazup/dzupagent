import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import * as retrievalSurface from '../retrieval/index.js'

const runtimeNames = ['retrieveMemoryV1']
const declarationNames = [
  'MemoryCandidateV1',
  'MemoryQueryRewriterPort',
  'MemoryQueryV1',
  'MemoryRerankerPort',
  'MemoryResultV1',
  'MemoryRetrievalProfileV1',
  'MemoryRetrieverPort',
  'MemorySelectionExplanationV1',
  'retrieveMemoryV1',
]
const execFileAsync = promisify(execFile)

/**
 * Packaging checks need this package's own built `dist`, which the default
 * test task does not build. Without the packaging flag they are reported as
 * skipped, never as passed; with it (see `test:packaging`) a missing `dist`
 * fails the spec instead of returning early.
 */
const PACKAGING_ENV_VAR = 'DZUPAGENT_PACKAGING_TESTS'
const packagingEnabled = (process.env[PACKAGING_ENV_VAR] ?? '').length > 0

async function requireDist(...files: string[]): Promise<void> {
  for (const file of files) {
    await access(join(process.cwd(), file)).catch(() => {
      throw new Error(
        `${PACKAGING_ENV_VAR} is set but ${file} is missing; run build:verify for @dzupagent/memory first`,
      )
    })
  }
}

describe('@dzupagent/memory/retrieval export', () => {
  it('declares exactly the admitted nine-name retrieval surface', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(packageJson.exports['./retrieval']).toEqual({
      import: './dist/retrieval/index.js',
      types: './dist/retrieval/index.d.ts',
    })
    expect(Object.keys(retrievalSurface).sort()).toEqual(runtimeNames)

    const index = await readFile(join(process.cwd(), 'src/retrieval/index.ts'), 'utf8')
    for (const name of declarationNames) expect(index).toContain(name)
  })

  it('does not widen the compatibility root barrel', async () => {
    const rootIndex = await readFile(join(process.cwd(), 'src/index.ts'), 'utf8')
    expect(rootIndex).not.toContain('retrieveMemoryV1')
  })

  it.skipIf(!packagingEnabled)('built root barrel stays free of the subpath runtime names', async () => {
    await requireDist('dist/index.js')
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "console.log(JSON.stringify(Object.keys(await import('@dzupagent/memory')).sort()))",
    ], { cwd: process.cwd() })
    const builtRootNames = JSON.parse(stdout) as string[]
    for (const name of runtimeNames) expect(builtRootNames).not.toContain(name)
  })

  it.skipIf(!packagingEnabled)('resolves the built JavaScript and exact external declaration contract', async () => {
    await requireDist('dist/retrieval/index.js', 'dist/retrieval/index.d.ts')
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "console.log(JSON.stringify(Object.keys(await import('@dzupagent/memory/retrieval')).sort()))",
    ], { cwd: process.cwd() })
    expect(JSON.parse(stdout)).toEqual(runtimeNames)

    const fixtureDir = await mkdtemp(join(process.cwd(), '.retrieval-types-'))
    try {
      const fixture = join(fixtureDir, 'consumer.ts')
      await writeFile(fixture, [
        "import { retrieveMemoryV1, type MemoryCandidateV1, type MemoryQueryRewriterPort, type MemoryQueryV1, type MemoryRerankerPort, type MemoryResultV1, type MemoryRetrievalProfileV1, type MemoryRetrieverPort, type MemorySelectionExplanationV1 } from '@dzupagent/memory/retrieval'",
        '// @ts-expect-error retrieval contracts are intentionally subpath-only',
        "import { retrieveMemoryV1 as rootRetrieve } from '@dzupagent/memory'",
        'declare const candidate: MemoryCandidateV1',
        'declare const query: MemoryQueryV1',
        'declare const result: MemoryResultV1',
        'declare const profile: MemoryRetrievalProfileV1',
        'declare const retriever: MemoryRetrieverPort',
        'declare const rewriter: MemoryQueryRewriterPort',
        'declare const reranker: MemoryRerankerPort',
        'declare const explanation: MemorySelectionExplanationV1',
        'void retrieveMemoryV1({ query, profile, retriever, queryRewriter: rewriter, reranker })',
        'void candidate',
        'void result',
        'void explanation',
        'void rootRetrieve',
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
