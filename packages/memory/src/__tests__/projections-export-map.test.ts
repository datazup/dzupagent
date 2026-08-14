import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import * as projectionSurface from '../projections/index.js'

const runtimeNames = [
  'diffMemoryProjections',
  'projectMemoryRecordToJson',
  'projectMemoryRecordToMarkdown',
  'projectMemoryRecordV1',
]
const declarationNames = [
  'MemoryProjectionDiffV1',
  'MemoryProjectionProfileV1',
  'MemoryProjectionRequestV1',
  'MemoryProjectionV1',
  ...runtimeNames,
]
const execFileAsync = promisify(execFile)

describe('@dzupagent/memory/projections export', () => {
  it('declares exactly the admitted eight-name pure surface', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(packageJson.exports['./projections']).toEqual({
      import: './dist/projections/index.js',
      types: './dist/projections/index.d.ts',
    })
    expect(Object.keys(projectionSurface).sort()).toEqual([...runtimeNames].sort())
    const index = await readFile(join(process.cwd(), 'src/projections/index.ts'), 'utf8')
    for (const name of declarationNames) expect(index).toContain(name)
    expect(index).not.toContain('GitMemoryProjectionAdapter')
  })

  it('does not widen the compatibility root barrel', async () => {
    const rootIndex = await readFile(join(process.cwd(), 'src/index.ts'), 'utf8')
    for (const name of runtimeNames) expect(rootIndex).not.toContain(name)
  })

  it('resolves built JavaScript and the external declaration contract', async () => {
    try {
      await access(join(process.cwd(), 'dist/projections/index.js'))
      await access(join(process.cwd(), 'dist/projections/index.d.ts'))
    } catch {
      return
    }
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "console.log(JSON.stringify(Object.keys(await import('@dzupagent/memory/projections')).sort()))",
    ], { cwd: process.cwd() })
    expect(JSON.parse(stdout)).toEqual([...runtimeNames].sort())

    const fixtureDir = await mkdtemp(join(process.cwd(), '.projection-types-'))
    try {
      const fixture = join(fixtureDir, 'consumer.ts')
      await writeFile(fixture, [
        "import { diffMemoryProjections, projectMemoryRecordToJson, projectMemoryRecordToMarkdown, projectMemoryRecordV1, type MemoryProjectionDiffV1, type MemoryProjectionProfileV1, type MemoryProjectionRequestV1, type MemoryProjectionV1 } from '@dzupagent/memory/projections'",
        '// @ts-expect-error projection contracts are intentionally subpath-only',
        "import { projectMemoryRecordV1 as rootProject } from '@dzupagent/memory'",
        'declare const request: MemoryProjectionRequestV1',
        'declare const profile: MemoryProjectionProfileV1',
        'const projection: MemoryProjectionV1 = projectMemoryRecordV1(request)',
        'const diff: MemoryProjectionDiffV1 = diffMemoryProjections(projection, projection)',
        'void projectMemoryRecordToJson(request)',
        'void projectMemoryRecordToMarkdown(request)',
        'void [profile, diff, rootProject]',
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
