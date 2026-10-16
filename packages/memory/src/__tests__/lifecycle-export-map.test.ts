import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import * as lifecycle from '../lifecycle/index.js'

const runtimeNames = [
  'MemoryTransitionError',
  'projectMemoryVersionChainV1',
  'reduceMemoryCommandV1',
]
const declarationNames = [
  'MemoryCommandV1',
  'MemoryEventV1',
  'MemoryLifecycleStateV1',
  'MemoryTransitionError',
  'MemoryTransitionReceiptV1',
  'MemoryVersionChainV1',
  'projectMemoryVersionChainV1',
  'reduceMemoryCommandV1',
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

describe('@dzupagent/memory/lifecycle export', () => {
  it('declares exactly the narrow runtime and source surface', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(packageJson.exports['./lifecycle']).toEqual({
      import: './dist/lifecycle/index.js',
      types: './dist/lifecycle/index.d.ts',
    })
    expect(Object.keys(lifecycle).sort()).toEqual(runtimeNames)

    const index = await readFile(join(process.cwd(), 'src/lifecycle/index.ts'), 'utf8')
    for (const name of declarationNames) expect(index).toContain(name)
  })

  it('does not widen the compatibility root barrel', async () => {
    const rootIndex = await readFile(join(process.cwd(), 'src/index.ts'), 'utf8')
    expect(rootIndex).not.toContain('./lifecycle/')
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

  it.skipIf(!packagingEnabled)('resolves built JavaScript and declarations when their complete pair is built', async () => {
    await requireDist('dist/lifecycle/index.js', 'dist/lifecycle/index.d.ts')
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "console.log(JSON.stringify(Object.keys(await import('@dzupagent/memory/lifecycle')).sort()))",
    ], { cwd: process.cwd() })
    expect(JSON.parse(stdout)).toEqual(runtimeNames)

    const fixtureDir = await mkdtemp(join(process.cwd(), '.lifecycle-types-'))
    try {
      const fixture = join(fixtureDir, 'consumer.ts')
      await writeFile(fixture, [
        "import { MemoryTransitionError, projectMemoryVersionChainV1, reduceMemoryCommandV1, type MemoryCommandV1, type MemoryEventV1, type MemoryLifecycleStateV1, type MemoryTransitionReceiptV1, type MemoryVersionChainV1 } from '@dzupagent/memory/lifecycle'",
        '// @ts-expect-error lifecycle contracts are intentionally subpath-only',
        "import type { MemoryCommandV1 as RootCommandV1 } from '@dzupagent/memory'",
        'declare const state: MemoryLifecycleStateV1 | undefined',
        'declare const command: MemoryCommandV1',
        'const result = reduceMemoryCommandV1(state, command)',
        'const receipt: MemoryTransitionReceiptV1 = result.receipt',
        'const event: MemoryEventV1 | undefined = result.event',
        'const chain: MemoryVersionChainV1 = projectMemoryVersionChainV1(result.state.events)',
        'const error = new MemoryTransitionError("invalid-command")',
        'void (null as RootCommandV1 | null)',
        'void receipt',
        'void event',
        'void chain',
        'void error',
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
