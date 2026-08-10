import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  listBuildPackageDirs,
  ROOT_BUILD_INPUTS,
} from '../build-artifact-integrity.mjs'
import {
  packageLintTarget,
  parseLintArguments,
} from '../run-package-lint.mjs'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

test('every build workspace publishes and verifies a completion manifest', async () => {
  const packageDirs = await listBuildPackageDirs(repoRoot)
  assert.equal(packageDirs.length > 0, true)
  for (const packageDir of packageDirs) {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, packageDir, 'package.json'), 'utf8'),
    )
    assert.match(
      packageJson.scripts.build,
      /^node \.\.\/\.\.\/scripts\/run-with-build-custody\.mjs --shell "node \.\.\/\.\.\/scripts\/prepare-build-artifact-manifest\.mjs && .+ && node \.\.\/\.\.\/scripts\/write-build-artifact-manifest\.mjs"$/,
      packageJson.name,
    )
    assert.equal(
      packageJson.scripts['build:verify'],
      'node ../../scripts/run-with-build-custody.mjs node ../../scripts/check-build-artifact-integrity.mjs',
      packageJson.name,
    )
    assert.equal(
      packageJson.scripts.lint,
      'node ../../scripts/run-package-lint.mjs',
      packageJson.name,
    )
  }
})

test('Turbo verifies restored dependencies and suppresses replayed cache logs', () => {
  const turbo = JSON.parse(readFileSync(path.join(repoRoot, 'turbo.json'), 'utf8'))
  assert.deepEqual(
    [...turbo.globalDependencies].sort(),
    [...ROOT_BUILD_INPUTS].sort(),
    'Turbo cache keys must bind the exact root inputs retained in artifact manifests',
  )
  assert.equal(
    turbo.globalDependencies.includes('scripts/build-artifact-integrity.mjs'),
    true,
  )
  assert.equal(turbo.globalDependencies.includes('scripts/build-custody.mjs'), true)
  assert.equal(
    turbo.globalDependencies.includes('scripts/run-with-build-custody.mjs'),
    true,
  )
  assert.deepEqual(turbo.globalPassThroughEnv, ['DZUP_BUILD_CUSTODY_TOKEN'])
  assert.deepEqual(turbo.tasks['build:verify'].dependsOn, ['build'])
  assert.equal(turbo.tasks['build:verify'].cache, false)
  for (const taskName of ['build', 'typecheck', 'lint', 'test']) {
    assert.equal(turbo.tasks[taskName].outputLogs, 'new-only', taskName)
  }
  assert.equal(turbo.tasks.typecheck.dependsOn.includes('^build:verify'), true)
  assert.equal(turbo.tasks.test.dependsOn.includes('^build:verify'), true)
  assert.equal(JSON.stringify(turbo).includes('"^build"'), false)
  for (const [taskName, task] of Object.entries(turbo.tasks)) {
    if (!taskName.endsWith('#build')) continue
    assert.deepEqual(task.outputs, ['dist/**'], `${taskName} cache outputs`)
  }
})

test('root artifact readers and graph commands hold build custody', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  )
  for (const scriptName of ['build', 'typecheck', 'test']) {
    assert.match(
      packageJson.scripts[scriptName],
      /^node scripts\/run-with-build-custody\.mjs turbo run /,
      scriptName,
    )
  }
  for (const scriptName of [
    'check:build-artifact-integrity',
    'check:package-export-artifacts',
    'check:dts-budgets',
  ]) {
    assert.match(
      packageJson.scripts[scriptName],
      /^node scripts\/run-with-build-custody\.mjs node scripts\//,
      scriptName,
    )
  }
  assert.equal(
    packageJson.scripts['test:build-cache'],
    'node scripts/run-with-build-custody.mjs node scripts/qualify-build-cache-artifacts.mjs',
  )
  assert.equal(
    packageJson.scripts['test:build-cache:root-input-drift'],
    'node scripts/qualify-build-root-input-cache-drift.mjs',
  )
})

test('package lint uses its own cwd while resolving ESLint from root tooling', () => {
  const packageDir = path.join(repoRoot, 'packages/context')
  assert.equal(packageLintTarget(repoRoot, packageDir), 'src/')
  assert.deepEqual(parseLintArguments(['--fix', '--max-warnings=2']), {
    fix: true,
    quiet: false,
    maxWarnings: 2,
  })
  assert.throws(
    () => packageLintTarget(repoRoot, repoRoot),
    /direct packages\/\* workspace/,
  )
})
