import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildPublicAllowlistMarkdown,
  parseRootIndex,
} from '../server-api-surface-report.mjs'

test('root inventory includes export-star sources', () => {
  assert.deepEqual(
    parseRootIndex(`
      export { stableThing } from './stable.js'
      export * from './compat.js'
    `),
    [
      { source: './stable.js', exportNames: ['stableThing'] },
      { source: './compat.js', exportNames: ['*'] },
    ],
  )
})

test('public API documentation separates subpaths by lifecycle', () => {
  const markdown = buildPublicAllowlistMarkdown({
    generatedOn: '2026-08-18',
    packages: [
      {
        packageName: '@dzupagent/example',
        rootIndex: 'packages/example/src/index.ts',
        inventory: [],
        migrationWindow: 'Compatibility remains through 0.x.',
        subpaths: [
          { subpath: './stable', purpose: 'stable facade', lifecycle: 'stable' },
          {
            subpath: './compat',
            purpose: 'compatibility facade',
            lifecycle: 'deprecated-transitional',
          },
          {
            subpath: './preview',
            purpose: 'preview facade',
            lifecycle: 'experimental',
          },
        ],
      },
    ],
  })

  assert.match(markdown, /### Stable Subpaths[\s\S]*@dzupagent\/example\/stable/)
  assert.match(
    markdown,
    /### Deprecated Transitional Subpaths[\s\S]*@dzupagent\/example\/compat/,
  )
  assert.match(
    markdown,
    /### Experimental Subpaths[\s\S]*@dzupagent\/example\/preview/,
  )
})
