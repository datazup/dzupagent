import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const turboConfigPath = new URL('../turbo.json', import.meta.url)
const packageJsonPath = new URL('../package.json', import.meta.url)

const AGENT_ADAPTERS_DEPENDENCY_BUILDS = [
  '@dzupagent/adapter-rules#build:verify',
  '@dzupagent/adapter-types#build:verify',
  '@dzupagent/agent#build:verify',
  '@dzupagent/agent-types#build:verify',
  '@dzupagent/core#build:verify',
  '@dzupagent/runtime-contracts#build:verify',
  '@dzupagent/security#build:verify',
  '@dzupagent/subagents#build:verify',
]

/**
 * Tasks that read a dependency's BUILD OUTPUT (dist/*.d.ts) rather than its
 * source. Every one of them must be ordered after `^build:verify`, or it
 * silently measures whatever stale or absent `dist/` happens to be on disk.
 *
 * This is not hypothetical. `dist/` is gitignored, and each package emits its
 * declarations in a separate `tsc --emitDeclarationOnly` step that runs AFTER
 * tsup — so a half-finished build leaves `.js` with no `.d.ts`, every named
 * import through it resolves to nothing, and the type errors cascade into
 * TS7016. A 2026-08-12 sweep measured 3,795 raw errors of which 1,098 were
 * this artifact, and the same staleness manufactured a convincing false
 * "LoweredPorts was deleted" regression that traced to a `dist/index.d.ts`
 * 2.7 days older than the source still exporting it.
 */
const BUILD_ORDERED_TASKS = ['typecheck', 'test', 'test:integration', 'test:coverage']

function isBuildEdge(dependency) {
  return typeof dependency === 'string' && dependency.endsWith('build:verify')
}

/**
 * A package-scoped override REPLACES the generic task entry rather than
 * merging with it, so an override that lists only its own extra edge quietly
 * discards `^build:verify` for every other dependency. That is how
 * `@dzupagent/memory#typecheck` came to typecheck against unbuilt siblings.
 * An override is accepted if it keeps `^build:verify`, or if it enumerates
 * explicit `<pkg>#build:verify` edges deliberately.
 */
export function checkBuildOrdering(turboConfig) {
  const messages = []
  const tasks = turboConfig?.tasks ?? {}

  for (const [taskId, definition] of Object.entries(tasks)) {
    const taskName = taskId.includes('#') ? taskId.slice(taskId.indexOf('#') + 1) : taskId
    if (!BUILD_ORDERED_TASKS.includes(taskName)) continue

    const dependsOn = definition?.dependsOn
    if (!Array.isArray(dependsOn)) {
      messages.push(`turbo.tasks["${taskId}"].dependsOn must be an array declaring its build order`)
      continue
    }
    if (!dependsOn.some(isBuildEdge)) {
      messages.push(
        `turbo.tasks["${taskId}"].dependsOn declares no "*build:verify" edge — it will run ` +
          `against whatever stale or missing dist/ is on disk`,
      )
    }
  }

  return messages
}

/**
 * Root tasks (`//#name`) CANNOT use `^` dependencies. The root package has no
 * workspace dependencies in Turbo's graph, so `"dependsOn": ["^build:verify"]`
 * on a root task resolves to ZERO dependencies and fails silently — a dry run
 * reports the task with 0 deps rather than erroring. Verified against Turbo
 * 2.10.0. A root task must name its edges explicitly (`<pkg>#build:verify`),
 * or the ordering must live in the npm script instead.
 */
export function checkNoTopologicalDepsOnRootTasks(turboConfig) {
  const messages = []
  for (const [taskId, definition] of Object.entries(turboConfig?.tasks ?? {})) {
    if (!taskId.startsWith('//#')) continue
    for (const dependency of definition?.dependsOn ?? []) {
      if (typeof dependency === 'string' && dependency.startsWith('^')) {
        messages.push(
          `turbo.tasks["${taskId}"].dependsOn uses "${dependency}"; "^" on a root task ` +
            `resolves to no dependencies at all. Name the package task explicitly.`,
        )
      }
    }
  }
  return messages
}

/**
 * `check:test-typecheck` is a plain root script, not a Turbo task — no package
 * declares it, so no turbo.json entry can order it. Its build ordering
 * therefore lives in the npm script itself and is asserted here: the build must
 * appear before the gate in the command string.
 */
export function checkGateScriptOrdering(packageJson) {
  const messages = []
  const scripts = packageJson?.scripts ?? {}

  const gate = scripts['check:test-typecheck']
  if (typeof gate !== 'string') {
    messages.push('package.json scripts["check:test-typecheck"] is missing')
  } else {
    const buildAt = gate.indexOf('build:verify')
    const gateAt = gate.indexOf('check-test-typecheck.mjs')
    if (buildAt === -1 || gateAt === -1 || buildAt > gateAt) {
      messages.push(
        'package.json scripts["check:test-typecheck"] must run "turbo run build:verify" BEFORE ' +
          'scripts/check-test-typecheck.mjs, or the gate measures a stale dist/',
      )
    }
  }

  // TEST-M-01: the coverage gate only READS coverage/coverage-summary.json. If
  // nothing in the chain produces one, all 35 tracked packages report "missing"
  // and the gate exits 1 — which is why verify:strict never reached a coverage
  // verdict.
  for (const chain of ['verify:strict', 'verify:strict:no-circular']) {
    const value = scripts[chain]
    if (typeof value !== 'string') continue
    const gateAt = value.indexOf('check:workspace:coverage')
    if (gateAt === -1) continue
    const producerAt = value.indexOf('test:coverage')
    if (producerAt === -1 || producerAt > gateAt) {
      messages.push(
        `package.json scripts["${chain}"] runs check:workspace:coverage without ever running ` +
          `test:coverage first, so no coverage summary exists for it to read`,
      )
    }
  }

  return messages
}

export function checkTurboTypecheckOrder(turboConfig, packageJson) {
  const messages = []

  const typecheckDependsOn = turboConfig?.tasks?.typecheck?.dependsOn
  if (!Array.isArray(typecheckDependsOn)) {
    messages.push('turbo.tasks.typecheck.dependsOn must be an array')
  } else if (!typecheckDependsOn.includes('^build:verify')) {
    messages.push('Expected turbo.tasks.typecheck.dependsOn to include "^build:verify"')
  }

  const agentAdaptersTypecheck =
    turboConfig?.tasks?.['@dzupagent/agent-adapters#typecheck']?.dependsOn
  if (!Array.isArray(agentAdaptersTypecheck)) {
    messages.push(
      'turbo.tasks["@dzupagent/agent-adapters#typecheck"].dependsOn must be an array',
    )
  } else {
    for (const dependencyBuild of AGENT_ADAPTERS_DEPENDENCY_BUILDS) {
      if (!agentAdaptersTypecheck.includes(dependencyBuild)) {
        messages.push(
          `Expected @dzupagent/agent-adapters#typecheck dependsOn to include ${dependencyBuild}`,
        )
      }
    }
  }

  messages.push(...checkBuildOrdering(turboConfig))
  messages.push(...checkNoTopologicalDepsOnRootTasks(turboConfig))
  if (packageJson !== undefined) {
    messages.push(...checkGateScriptOrdering(packageJson))
  }

  return {
    ok: messages.length === 0,
    messages,
  }
}

function main() {
  const turboConfig = JSON.parse(readFileSync(turboConfigPath, 'utf8'))
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const result = checkTurboTypecheckOrder(turboConfig, packageJson)
  if (!result.ok) {
    throw new Error(result.messages.join('\n'))
  }
  console.log(
    'OK: every dist-consuming turbo task is ordered after ^build:verify, no root task relies on ' +
      '"^", and check:test-typecheck / test:coverage run after the artifacts they read',
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
