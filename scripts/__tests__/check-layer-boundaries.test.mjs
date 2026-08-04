import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const scriptPath = join(repoRoot, 'scripts', 'check-layer-boundaries.mjs')
const packageJsonPath = join(repoRoot, 'package.json')

function createRepo({ adapterSource }) {
  const root = mkdtempSync(join(tmpdir(), 'layer-boundaries-'))
  mkdirSync(join(root, 'packages', 'agent-adapters', 'src'), { recursive: true })
  mkdirSync(join(root, 'packages', 'agent', 'src'), { recursive: true })
  writeFileSync(join(root, 'packages', 'agent-adapters', 'src', 'index.ts'), adapterSource, 'utf8')
  writeFileSync(join(root, 'packages', 'agent', 'src', 'internal.ts'), 'export const internal = true\n', 'utf8')
  return root
}

function runLayerBoundaryCheck(root) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('fails on a seeded agent-adapters relative import into agent/src', () => {
  const root = createRepo({
    adapterSource: "import { internal } from '../../agent/src/internal'\nvoid internal\n",
  })

  try {
    const result = runLayerBoundaryCheck(root)
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /LAYER BOUNDARY VIOLATIONS DETECTED/)
    assert.match(result.stderr, /packages\/agent-adapters\/src\/index\.ts:1/)
    assert.match(result.stderr, /\.\.\/\.\.\/agent\/src\/internal/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('strict verification scripts run the layer boundary checker', () => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

  assert.match(packageJson.scripts['check:layer-boundaries'], /scripts\/check-layer-boundaries\.mjs/)
  assert.match(packageJson.scripts['verify:strict'], /yarn check:layer-boundaries/)
  assert.match(packageJson.scripts['verify:strict:no-circular'], /yarn check:layer-boundaries/)
  assert.match(packageJson.scripts['verify:strict:ci:no-circular'], /yarn check:layer-boundaries/)
})
