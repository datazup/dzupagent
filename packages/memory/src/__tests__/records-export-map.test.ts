import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import * as records from '../records/index.js'

const runtimeNames = [
  'MemoryRecordDecodeError',
  'adaptMemoryRecordToV1',
  'adaptStagedRecordToV1',
  'canonicalizeMemoryRecordV1',
  'cloneMemoryRecordV1',
  'decodeMemoryRecordV1',
  'digestMemoryRecordV1',
  'freezeMemoryRecordV1',
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

describe('@dzupagent/memory/records export', () => {
  it('declares the narrow runtime and declaration artifacts', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(packageJson.exports['./records']).toEqual({
      import: './dist/records/index.js',
      types: './dist/records/index.d.ts',
    })
    expect(Object.keys(records).sort()).toEqual(runtimeNames)
  })

  it('does not widen the compatibility root barrel', async () => {
    const rootIndex = await readFile(join(process.cwd(), 'src/index.ts'), 'utf8')
    expect(rootIndex).not.toContain('./records/')
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

  it.skipIf(!packagingEnabled)('resolves the built package subpath from a complete dist', async () => {
    await requireDist('dist/records/index.js', 'dist/records/index.d.ts')
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "console.log(JSON.stringify(Object.keys(await import('@dzupagent/memory/records')).sort()))",
    ], { cwd: process.cwd() })
    expect(JSON.parse(stdout)).toEqual(runtimeNames)

    const fixtureDir = await mkdtemp(join(process.cwd(), '.records-types-'))
    try {
      const fixture = join(fixtureDir, 'consumer.ts')
      await writeFile(fixture, [
        "import { adaptMemoryRecordToV1, decodeMemoryRecordV1, type MemoryGovernanceV1, type MemoryRecordV1, type MemoryScopeV1 } from '@dzupagent/memory/records'",
        "import type { MemoryRecord } from '@dzupagent/agent-types'",
        '// @ts-expect-error canonical records are intentionally subpath-only',
        "import type { MemoryRecordV1 as RootRecordV1 } from '@dzupagent/memory'",
        'declare const input: unknown',
        'declare const legacy: MemoryRecord',
        'declare const adapterInputs: Parameters<typeof adaptMemoryRecordToV1>[1]',
        'const decoded: MemoryRecordV1 = decodeMemoryRecordV1(input)',
        'const adapted: MemoryRecordV1 = adaptMemoryRecordToV1(legacy, adapterInputs)',
        'const scope: MemoryScopeV1 = decoded.scope',
        'const governance: MemoryGovernanceV1 = adapted.governance',
        'void (null as RootRecordV1 | null)',
        'void scope',
        'void governance',
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
