import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import * as toolResultsSurface from '../tool-results/index.js'

const runtimeNames = ['compactCompletedToolResults']
const declarationNames = [
  'CompletedToolCompactionProfileV1',
  'CompletedToolCompactionResultV1',
  'compactCompletedToolResults',
]
const execFileAsync = promisify(execFile)

describe('@dzupagent/context/tool-results export', () => {
  it('declares exactly the admitted three-name compaction surface', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(packageJson.exports['./tool-results']).toEqual({
      import: './dist/tool-results/index.js',
      types: './dist/tool-results/index.d.ts',
    })
    expect(Object.keys(toolResultsSurface).sort()).toEqual(runtimeNames)

    const index = await readFile(join(process.cwd(), 'src/tool-results/index.ts'), 'utf8')
    for (const name of declarationNames) expect(index).toContain(name)
  })

  it('does not widen the context root barrel', async () => {
    const rootIndex = await readFile(join(process.cwd(), 'src/index.ts'), 'utf8')
    expect(rootIndex).not.toContain('compactCompletedToolResults')
    try {
      await access(join(process.cwd(), 'dist/index.js'))
    } catch {
      return
    }
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "console.log(JSON.stringify(Object.keys(await import('@dzupagent/context')).sort()))",
    ], { cwd: process.cwd() })
    const builtRootNames = JSON.parse(stdout) as string[]
    for (const name of runtimeNames) expect(builtRootNames).not.toContain(name)
  })

  it('resolves the built JavaScript and external declaration contract', async () => {
    try {
      await access(join(process.cwd(), 'dist/tool-results/index.js'))
      await access(join(process.cwd(), 'dist/tool-results/index.d.ts'))
    } catch {
      return
    }
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "console.log(JSON.stringify(Object.keys(await import('@dzupagent/context/tool-results')).sort()))",
    ], { cwd: process.cwd() })
    expect(JSON.parse(stdout)).toEqual(runtimeNames)

    const fixtureDir = await mkdtemp(join(process.cwd(), '.tool-results-types-'))
    try {
      const fixture = join(fixtureDir, 'consumer.ts')
      await writeFile(fixture, [
        "import { compactCompletedToolResults, type CompletedToolCompactionProfileV1, type CompletedToolCompactionResultV1 } from '@dzupagent/context/tool-results'",
        "import type { BaseMessage } from '@langchain/core/messages'",
        '// @ts-expect-error compaction contracts are intentionally subpath-only',
        "import { compactCompletedToolResults as rootCompact } from '@dzupagent/context'",
        'declare const messages: BaseMessage[]',
        'declare const profile: CompletedToolCompactionProfileV1',
        'const result: CompletedToolCompactionResultV1 = compactCompletedToolResults(messages, profile)',
        'void result',
        'void rootCompact',
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
