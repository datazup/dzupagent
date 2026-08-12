import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import * as workerSurface from '../workers/index.js'

const runtimeNames = ['createInMemoryMemoryOutbox']
const declarationNames = [
  'MemoryConsolidationJobV1',
  'MemoryConsolidationPort',
  'MemoryDeadLetterV1',
  'MemoryOutboxEnvelopeV1',
  'MemoryRetryPolicyV1',
  'MemoryWorkerCheckpointV1',
  'MemoryWorkerLeaseV1',
  'MemoryWorkerOutcomeV1',
  'createInMemoryMemoryOutbox',
]
const execFileAsync = promisify(execFile)

describe('@dzupagent/memory/workers export', () => {
  it('declares exactly the admitted nine-name worker surface', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(packageJson.exports['./workers']).toEqual({
      import: './dist/workers/index.js',
      types: './dist/workers/index.d.ts',
    })
    expect(Object.keys(workerSurface).sort()).toEqual(runtimeNames)
    const index = await readFile(join(process.cwd(), 'src/workers/index.ts'), 'utf8')
    for (const name of declarationNames) expect(index).toContain(name)
  })

  it('does not widen the compatibility root barrel', async () => {
    const rootIndex = await readFile(join(process.cwd(), 'src/index.ts'), 'utf8')
    expect(rootIndex).not.toContain('createInMemoryMemoryOutbox')
  })

  it('resolves the built runtime and external declaration contract', async () => {
    try {
      await access(join(process.cwd(), 'dist/workers/index.js'))
      await access(join(process.cwd(), 'dist/workers/index.d.ts'))
    } catch {
      return
    }
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "console.log(JSON.stringify(Object.keys(await import('@dzupagent/memory/workers')).sort()))",
    ], { cwd: process.cwd() })
    expect(JSON.parse(stdout)).toEqual(runtimeNames)

    const fixtureDir = await mkdtemp(join(process.cwd(), '.worker-types-'))
    try {
      const fixture = join(fixtureDir, 'consumer.ts')
      await writeFile(fixture, [
        "import { createInMemoryMemoryOutbox, type MemoryConsolidationJobV1, type MemoryConsolidationPort, type MemoryDeadLetterV1, type MemoryOutboxEnvelopeV1, type MemoryRetryPolicyV1, type MemoryWorkerCheckpointV1, type MemoryWorkerLeaseV1, type MemoryWorkerOutcomeV1 } from '@dzupagent/memory/workers'",
        '// @ts-expect-error worker contracts are intentionally subpath-only',
        "import { createInMemoryMemoryOutbox as rootFactory } from '@dzupagent/memory'",
        'declare const job: MemoryConsolidationJobV1',
        'declare const port: MemoryConsolidationPort',
        'declare const deadLetter: MemoryDeadLetterV1',
        'declare const envelope: MemoryOutboxEnvelopeV1',
        'declare const retry: MemoryRetryPolicyV1',
        'declare const checkpoint: MemoryWorkerCheckpointV1',
        'declare const lease: MemoryWorkerLeaseV1',
        'declare const outcome: MemoryWorkerOutcomeV1',
        'const outbox = createInMemoryMemoryOutbox()',
        'void outbox.runClaimed({ lease }, port)',
        'void [job, deadLetter, envelope, retry, checkpoint, outcome, rootFactory]',
      ].join('\n'), 'utf8')
      await execFileAsync(process.execPath, [
        join(process.cwd(), '../../node_modules/typescript/bin/tsc'),
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
        '--module', 'NodeNext', '--moduleResolution', 'NodeNext', fixture,
      ], { cwd: process.cwd() })
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  })
})
