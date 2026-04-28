import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('../check-domain-boundaries.mjs', import.meta.url))

function createRepo({ alphaPackageJson = {}, alphaSource = '' } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'domain-boundaries-'))
  mkdirSync(join(repoRoot, 'config'), { recursive: true })
  mkdirSync(join(repoRoot, 'packages', 'alpha', 'src'), { recursive: true })
  mkdirSync(join(repoRoot, 'packages', 'beta', 'src'), { recursive: true })

  writeFileSync(
    join(repoRoot, 'config', 'package-tiers.json'),
    JSON.stringify(
      {
        '@dzupagent/alpha': { tier: 1, status: 'supported', roadmapDriver: true, owners: ['test'] },
        '@dzupagent/beta': { tier: 1, status: 'supported', roadmapDriver: true, owners: ['test'] },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(repoRoot, 'config', 'architecture-boundaries.json'),
    JSON.stringify(
      {
        layerGraph: {
          layers: [
            { id: 1, name: 'base', packages: ['beta'] },
            { id: 2, name: 'feature', packages: ['alpha'] },
          ],
          rules: { allowSameLayerEdges: false },
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(repoRoot, 'packages', 'alpha', 'package.json'),
    JSON.stringify(
      {
        name: '@dzupagent/alpha',
        private: true,
        ...alphaPackageJson,
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(repoRoot, 'packages', 'beta', 'package.json'),
    JSON.stringify({ name: '@dzupagent/beta', private: true }, null, 2),
  )
  writeFileSync(join(repoRoot, 'packages', 'alpha', 'src', 'index.ts'), alphaSource, 'utf8')

  return repoRoot
}

function runDomainBoundaryCheck(repoRoot) {
  return execFileSync('node', [scriptPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('fails when a production source import is missing from supported manifest fields', () => {
  const repoRoot = createRepo({
    alphaSource: "import { thing } from '@dzupagent/beta'\nvoid thing\n",
  })

  try {
    assert.throws(() => runDomainBoundaryCheck(repoRoot))
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('allows production source imports declared in optionalDependencies', () => {
  const repoRoot = createRepo({
    alphaPackageJson: { optionalDependencies: { '@dzupagent/beta': '0.2.0' } },
    alphaSource: "const beta = await import('@dzupagent/beta')\nvoid beta\n",
  })

  try {
    assert.doesNotThrow(() => runDomainBoundaryCheck(repoRoot))
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('does not exempt type-only production imports from manifest declarations', () => {
  const repoRoot = createRepo({
    alphaSource: "import type { Thing } from '@dzupagent/beta'\nexport type Wrapped = Thing\n",
  })

  try {
    assert.throws(() => runDomainBoundaryCheck(repoRoot))
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('ignores scaffold template strings that contain generated imports', () => {
  const repoRoot = createRepo({
    alphaSource: "export const template = `import { thing } from '@dzupagent/beta'\\nvoid thing\\n`\n",
  })

  try {
    assert.doesNotThrow(() => runDomainBoundaryCheck(repoRoot))
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
