import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('../check-domain-boundaries.mjs', import.meta.url))

function createRepo({
  alphaPackageJson = {},
  alphaSource = '',
  packageBoundaryRules = [],
  serverRouteBoundaries,
  serverRouteFiles = [],
} = {}) {
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
        packageBoundaryRules,
        ...(serverRouteBoundaries ? { serverRouteBoundaries } : {}),
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

  for (const routeFile of serverRouteFiles) {
    const fullPath = join(repoRoot, routeFile)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, 'export const route = true\n', 'utf8')
  }

  return repoRoot
}

function runDomainBoundaryCheck(repoRoot) {
  return execFileSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function runDomainBoundaryCheckResult(repoRoot) {
  return spawnSync(process.execPath, [scriptPath], {
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

test('fails declared forbidden package pairs even when layer rules allow the source import', () => {
  const allowedRepoRoot = createRepo({
    alphaPackageJson: { dependencies: { '@dzupagent/beta': '0.2.0' } },
    alphaSource: "import { thing } from '@dzupagent/beta'\nvoid thing\n",
  })
  const repoRoot = createRepo({
    alphaPackageJson: { dependencies: { '@dzupagent/beta': '0.2.0' } },
    alphaSource: "import { thing } from '@dzupagent/beta'\nvoid thing\n",
    packageBoundaryRules: [{ importer: 'alpha', forbidden: ['beta'] }],
  })

  try {
    assert.doesNotThrow(() => runDomainBoundaryCheck(allowedRepoRoot))
    const result = runDomainBoundaryCheckResult(repoRoot)
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
  } finally {
    rmSync(allowedRepoRoot, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('fails newly added server route files without a boundary classification', () => {
  const repoRoot = createRepo({
    serverRouteFiles: ['packages/server/src/routes/projects.ts'],
    serverRouteBoundaries: {
      routeFileClassifications: {
        'framework-primitive': {
          rationale: 'Existing reusable framework route primitives.',
          files: [],
        },
      },
    },
  })

  try {
    const result = runDomainBoundaryCheckResult(repoRoot)
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('allows server route files with declared maintenance or framework rationale', () => {
  const repoRoot = createRepo({
    serverRouteFiles: ['packages/server/src/routes/runs.ts'],
    serverRouteBoundaries: {
      routeFileClassifications: {
        'framework-primitive': {
          rationale: 'Existing reusable framework route primitives.',
          files: ['packages/server/src/routes/runs.ts'],
        },
      },
    },
  })

  try {
    assert.doesNotThrow(() => runDomainBoundaryCheck(repoRoot))
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
