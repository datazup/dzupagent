import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import * as serviceSurface from '../service/index.js'

const runtimeNames = [
  'InMemoryMemoryLifecycleAdapter',
  'MemoryLifecycleService',
]
const methodNames = [
  'correct', 'explain', 'forget', 'queryLifecycle', 'remember', 'revoke',
]
const declarationNames = [
  'InMemoryMemoryLifecycleAdapter',
  'MemoryAdapterCapabilitiesV1',
  'MemoryInvalidationPort',
  'MemoryLifecycleService',
  'MemoryLifecycleStorePort',
]
const execFileAsync = promisify(execFile)

describe('@dzupagent/memory/service export', () => {
  it('declares exactly the admitted 11-name class, method, and port surface', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(packageJson.exports['./service']).toEqual({
      import: './dist/service/index.js',
      types: './dist/service/index.d.ts',
    })
    expect(Object.keys(serviceSurface).sort()).toEqual(runtimeNames)
    expect(Object.getOwnPropertyNames(
      serviceSurface.MemoryLifecycleService.prototype,
    ).filter(name => name !== 'constructor').sort()).toEqual(methodNames)

    const index = await readFile(join(process.cwd(), 'src/service/index.ts'), 'utf8')
    for (const name of declarationNames) expect(index).toContain(name)
  })

  it('does not widen the compatibility root barrel', async () => {
    const rootIndex = await readFile(join(process.cwd(), 'src/index.ts'), 'utf8')
    expect(rootIndex).not.toContain('./service/')
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

  it('preserves lifecycle error identity across built public subpaths', async () => {
    try {
      await access(join(process.cwd(), 'dist/service/index.js'))
      await access(join(process.cwd(), 'dist/lifecycle/index.js'))
    } catch {
      return
    }
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      [
        "const { InMemoryMemoryLifecycleAdapter } = await import('@dzupagent/memory/service')",
        "const { MemoryTransitionError } = await import('@dzupagent/memory/lifecycle')",
        'let cause',
        "try { new InMemoryMemoryLifecycleAdapter({ appendFault: 'invalid' }) } catch (error) { cause = error }",
        'console.log(JSON.stringify({',
        'instance: cause instanceof MemoryTransitionError,',
        'name: cause?.constructor?.name,',
        'code: cause?.code,',
        '}))',
      ].join('\n'),
    ], { cwd: process.cwd() })
    expect(JSON.parse(stdout)).toEqual({
      instance: true,
      name: 'MemoryTransitionError',
      code: 'invalid-command',
    })
  })

  it('resolves the built JavaScript and exact external declaration contract', async () => {
    try {
      await access(join(process.cwd(), 'dist/service/index.js'))
      await access(join(process.cwd(), 'dist/service/index.d.ts'))
    } catch {
      return
    }
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      [
        "const surface = await import('@dzupagent/memory/service')",
        'console.log(JSON.stringify({',
        'exports: Object.keys(surface).sort(),',
        "methods: Object.getOwnPropertyNames(surface.MemoryLifecycleService.prototype).filter(name => name !== 'constructor').sort(),",
        '}))',
      ].join('\n'),
    ], { cwd: process.cwd() })
    expect(JSON.parse(stdout)).toEqual({ exports: runtimeNames, methods: methodNames })

    const fixtureDir = await mkdtemp(join(process.cwd(), '.service-types-'))
    try {
      const fixture = join(fixtureDir, 'consumer.ts')
      await writeFile(fixture, [
        "import { InMemoryMemoryLifecycleAdapter, MemoryLifecycleService, type MemoryAdapterCapabilitiesV1, type MemoryInvalidationPort, type MemoryLifecycleStorePort } from '@dzupagent/memory/service'",
        '// @ts-expect-error lifecycle service contracts are intentionally subpath-only',
        "import { MemoryLifecycleService as RootService } from '@dzupagent/memory'",
        'const capabilities: MemoryAdapterCapabilitiesV1 = {',
        "schema: 'datazup.memory.adapter-capabilities/v1', atomicCompareAndSwap: true, transactions: true, checkpoints: true, delete: false, purge: false, indexInvalidation: false, durableIdempotency: true, authenticatedCustody: true, limits: { records: 64, events: 96, receipts: 96, checkpoints: 2, tombstones: 32 },",
        '}',
        'const store: MemoryLifecycleStorePort = { capabilities, load: async () => null, append: async () => ({}), checkpoint: async () => ({}) }',
        'const invalidation: MemoryInvalidationPort = { invalidate: async input => ({ schema: "datazup.memory.invalidation-result/v1", status: "completed", outcomes: input.targets.map(target => ({ target, status: "completed" })) }) }',
        'const facade = new MemoryLifecycleService(store, { invalidationPort: invalidation })',
        'const adapter = new InMemoryMemoryLifecycleAdapter()',
        'declare const write: Parameters<MemoryLifecycleService["remember"]>[0]',
        'declare const query: Parameters<MemoryLifecycleService["queryLifecycle"]>[0]',
        'void facade.remember(write)',
        'void facade.correct(write)',
        'void facade.forget(write)',
        'void facade.revoke(write)',
        'void facade.queryLifecycle(query)',
        'void facade.explain(query)',
        'void adapter',
        'void (null as RootService | null)',
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
