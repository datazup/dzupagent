import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('pins provider build inputs to the supported LangChain core line', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  const adapterManifest = JSON.parse(
    await readFile(new URL('../../packages/agent-adapters/package.json', import.meta.url), 'utf8'),
  )

  assert.deepEqual(
    {
      '@langchain/anthropic': manifest.resolutions?.['@langchain/anthropic'],
      '@langchain/core': manifest.resolutions?.['@langchain/core'],
      '@langchain/openai': manifest.resolutions?.['@langchain/openai'],
    },
    {
      '@langchain/anthropic': '1.3.23',
      '@langchain/core': '1.1.48',
      '@langchain/openai': '1.4.3',
    },
  )
  assert.equal(manifest.resolutions?.['@anthropic-ai/sdk'], undefined)
  assert.equal(adapterManifest.optionalDependencies?.['@anthropic-ai/sdk'], '0.103.0')
})
