import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'

import {
  buildMemoryApiCensus,
  extractExportsFromSource,
  scanWorkspaceMemoryConsumers,
} from '../generate-memory-api-census.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const temporaryRoots = []

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

test('extractExportsFromSource keeps aliases, type-only exports, namespaces, and local declarations', () => {
  const exports = extractExportsFromSource(`
    export { RuntimeThing as PublicThing, type InlineType } from './runtime.js'
    export type { SourceType as PublicType } from './types.js'
    export * as Helpers from './helpers.js'
    export interface LocalContract { value: string }
    export const VERSION = 'v1'
  `)

  assert.deepEqual(
    exports.map(item => [item.symbol, item.kind, item.sourceModule, item.sourceSymbol]),
    [
      ['Helpers', 'namespace', './helpers.js', 'Helpers'],
      ['InlineType', 'type', './runtime.js', 'InlineType'],
      ['LocalContract', 'type', '<local>:LocalContract', 'LocalContract'],
      ['PublicThing', 'value', './runtime.js', 'RuntimeThing'],
      ['PublicType', 'type', './types.js', 'SourceType'],
      ['VERSION', 'value', '<local>:VERSION', 'VERSION'],
    ],
  )
})

test('MEM-P000 census is deterministic and dispositions every current and planned surface', () => {
  const first = buildMemoryApiCensus(REPO_ROOT)
  const second = buildMemoryApiCensus(REPO_ROOT)

  assert.deepEqual(first, second)
  assert.equal(first.schema, 'datazup.memory.api-census/v1')
  assert.ok(first.currentSurfaces.length > 600)
  assert.ok(first.plannedSurfaces.length > 50)
  assert.ok(first.capabilities.length >= 8)
  assert.equal(
    first.currentSurfaces.every(item => ['reuse', 'extend', 'deprecate', 'new'].includes(item.disposition)),
    true,
  )
  assert.equal(
    first.plannedSurfaces.every(item => ['reuse', 'extend', 'deprecate', 'new'].includes(item.disposition)),
    true,
  )
  assert.deepEqual(
    first.currentSurfaces.filter(item => item.apiClass.startsWith('unclassified')),
    [],
  )
  assert.equal(
    first.currentDecisions.some(item => item.symbol === 'StagedWriter' && item.disposition === 'deprecate'),
    true,
  )
  const p007 = first.plannedSurfaces.filter(item => item.packet.startsWith('MEM-P007'))
  assert.deepEqual(
    p007.filter(item => item.packet === 'MEM-P007-A').map(item => item.symbol).sort(),
    [
      'MemoryProjectionDiffV1',
      'MemoryProjectionProfileV1',
      'MemoryProjectionRequestV1',
      'MemoryProjectionV1',
      'diffMemoryProjections',
      'projectMemoryRecordToJson',
      'projectMemoryRecordToMarkdown',
      'projectMemoryRecordV1',
    ],
  )
  assert.deepEqual(
    p007.filter(item => item.packet === 'MEM-P007-B').map(item => item.symbol),
    ['GitMemoryProjectionAdapter'],
  )
  assert.deepEqual(
    first.sourceIdentity.inputs.find(item => item.path === 'config/public-api-allowlists.json')?.selection,
    {
      packageNames: [
        '@dzupagent/agent',
        '@dzupagent/agent-types',
        '@dzupagent/context',
        '@dzupagent/memory',
        '@dzupagent/memory-ipc',
      ],
    },
  )
})

test('workspace consumer census records source and test imports and excludes vendored or documented copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-consumer-census-'))
  temporaryRoots.push(root)
  write(join(root, 'apps/demo/package.json'), JSON.stringify({ name: '@datazup/demo' }))
  write(
    join(root, 'apps/demo/src/runtime.ts'),
    "import { MemoryService } from '@dzupagent/memory'\nimport type { MemoryRecord } from '@dzupagent/agent-types'\n",
  )
  write(
    join(root, 'apps/demo/src/unrelated.ts'),
    "import type { RunStatus } from '@dzupagent/agent-types/run'\n",
  )
  write(
    join(root, 'apps/demo/src/runtime.test.ts'),
    "import { autoCompress } from '@dzupagent/context'\n",
  )
  write(
    join(root, 'apps/demo/vendor/copied.ts'),
    "import { IpcMemoryClient } from '@dzupagent/memory-ipc'\n",
  )
  write(join(root, 'shared-kit/package.json'), JSON.stringify({ name: '@datazup/shared-kit' }))
  write(
    join(root, 'shared-kit/src/index.ts'),
    "export type { MemoryScope } from '@dzupagent/agent-types'\n",
  )

  const result = scanWorkspaceMemoryConsumers(root, {
    roots: ['apps', 'shared-kit'],
    packagePrefixes: [
      '@dzupagent/agent-types',
      '@dzupagent/memory',
      '@dzupagent/context',
      '@dzupagent/memory-ipc',
    ],
    packageSymbolAllowlist: {
      '@dzupagent/agent-types': ['MemoryRecord', 'MemoryScope'],
    },
    excludedDirectoryNames: ['vendor'],
  })

  assert.equal(result.summary.importDeclarationCount, 4)
  assert.equal(result.summary.consumerFileCount, 3)
  assert.equal(result.summary.byUseClass.runtime, 3)
  assert.equal(result.summary.byUseClass.test, 1)
  assert.equal(result.imports.some(item => item.file.includes('/vendor/')), false)
  assert.equal(result.imports.some(item => item.file.endsWith('/unrelated.ts')), false)
  assert.deepEqual(
    result.imports.map(item => [item.file, item.package, item.useClass]),
    [
      ['apps/demo/src/runtime.test.ts', '@dzupagent/context', 'test'],
      ['apps/demo/src/runtime.ts', '@dzupagent/agent-types', 'runtime'],
      ['apps/demo/src/runtime.ts', '@dzupagent/memory', 'runtime'],
      ['shared-kit/src/index.ts', '@dzupagent/agent-types', 'runtime'],
    ],
  )
})
