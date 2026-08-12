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
    try {
      await access(join(process.cwd(), 'dist/index.js'))
    } catch {
      return
    }
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "console.log(JSON.stringify(Object.keys(await import('@dzupagent/memory')).sort()))",
    ], { cwd: process.cwd() })
    const builtRootNames = JSON.parse(stdout) as string[]
    for (const name of runtimeNames) expect(builtRootNames).not.toContain(name)
  })

  it('resolves the built package subpath when a complete dist exists', async () => {
    try {
      await access(join(process.cwd(), 'dist/records/index.js'))
      await access(join(process.cwd(), 'dist/records/index.d.ts'))
    } catch {
      // The repository runs build and test tasks concurrently. A clean build
      // emits JavaScript before declaration generation finishes, so the
      // unconditional package-artifact post-gates own that in-flight state.
      return
    }
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
