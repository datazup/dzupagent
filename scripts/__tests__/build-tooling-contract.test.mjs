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

// Every build workspace must verify its completion manifest under build custody,
// and must do it FIRST -- an integrity check placed behind another command is
// skipped whenever that command exits non-zero.
const REQUIRED_BUILD_VERIFY =
  'node ../../scripts/run-with-build-custody.mjs node ../../scripts/check-build-artifact-integrity.mjs'

// A package may append its own extra gates (agent-types chains an implementation
// deprecation check). Demanding exact equality made the shared contract and a
// legitimate package-local gate mutually exclusive. Anchoring the required
// command as a prefix keeps the guard load-bearing: replacing it, dropping
// custody, or demoting it behind another command all still fail.
function isContractualBuildVerify(value) {
  if (typeof value !== 'string') return false
  return (
    value === REQUIRED_BUILD_VERIFY ||
    value.startsWith(`${REQUIRED_BUILD_VERIFY} && `)
  )
}

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
      isContractualBuildVerify(packageJson.scripts['build:verify']),
      true,
      `${packageJson.name}: build:verify must run the custody-held integrity check first, optionally followed by "&& " package-local gates; got: ${packageJson.scripts['build:verify']}`,
    )
    assert.equal(
      packageJson.scripts.lint,
      'node ../../scripts/run-package-lint.mjs',
      packageJson.name,
    )
  }
})

test('the build:verify contract accepts appended gates and nothing else', () => {
  // Two-way pin. Without the reject cases the relaxed prefix rule could rot into
  // "starts with node" and still look green.
  for (const accepted of [
    REQUIRED_BUILD_VERIFY,
    `${REQUIRED_BUILD_VERIFY} && node ../../scripts/check-agent-types-implementation-deprecation.mjs`,
    `${REQUIRED_BUILD_VERIFY} && node ../../scripts/a.mjs && node ../../scripts/b.mjs`,
  ]) {
    assert.equal(isContractualBuildVerify(accepted), true, `must accept: ${accepted}`)
  }

  for (const rejected of [
    undefined,
    '',
    // integrity check demoted behind another gate -- skipped when that gate fails
    `node ../../scripts/check-agent-types-implementation-deprecation.mjs && ${REQUIRED_BUILD_VERIFY}`,
    // custody dropped
    'node ../../scripts/check-build-artifact-integrity.mjs',
    // integrity check swapped out
    'node ../../scripts/run-with-build-custody.mjs node ../../scripts/something-else.mjs',
    // chained without the separator the contract requires
    `${REQUIRED_BUILD_VERIFY} ; node ../../scripts/x.mjs`,
    `${REQUIRED_BUILD_VERIFY}--quiet`,
  ]) {
    assert.equal(isContractualBuildVerify(rejected), false, `must reject: ${rejected}`)
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
