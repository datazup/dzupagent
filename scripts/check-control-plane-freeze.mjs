/**
 * check-control-plane-freeze.mjs
 *
 * MC-5 (ARCH-H-01) — Server control-plane contraction hard gate.
 *
 * `ForgeControlPlaneRouteFamilyConfig` is the frozen compatibility surface for
 * server-hosted control-plane stores (prompts, personas, presets, marketplace,
 * reflections, mailbox, clusters, learning, approval, …). Per the contraction
 * schedule in packages/server/src/composition/CONTROL-PLANE-CONTRACTION.md, its
 * field set may only SHRINK as families are extracted to consuming apps. Adding
 * a new field smuggles product control plane back into packages/server.
 *
 * This gate fails CI when:
 *   1. The contraction schedule doc is missing.
 *   2. The freeze baseline in config/architecture-boundaries.json is missing or
 *      malformed.
 *   3. A baseline source file is missing or the interface is not found in it.
 *   4. The interface's actual fields drift from the baseline in EITHER direction
 *      (added fields = regression; removed fields = a legitimate contraction
 *      that must be recorded by updating the baseline + the schedule).
 *   5. The two mirrored source files disagree on the field set.
 *
 * This is complementary to check-domain-boundaries.mjs, which keeps the
 * forgeServerConfigRouteFamilies name manifest in sync. This gate additionally
 * FREEZES the field count and ties any change to the written schedule.
 *
 * Usage:
 *   node scripts/check-control-plane-freeze.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const architectureConfigPath = join(repoRoot, 'config', 'architecture-boundaries.json')

/**
 * Extract the brace-balanced body of `export interface <name> { … }`.
 * Mirrors scripts/check-domain-boundaries.mjs so both gates parse identically.
 */
function readInterfaceBody(source, interfaceName) {
  const match = new RegExp(`\\bexport\\s+interface\\s+${interfaceName}\\b`).exec(source)
  if (!match) return null

  const start = source.indexOf('{', match.index)
  if (start === -1) return null

  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start + 1, index)
    }
  }
  return null
}

/** Collect top-level property names of an interface, sorted. */
function collectInterfacePropertyNames(source, interfaceName) {
  const body = readInterfaceBody(source, interfaceName)
  if (body === null) return null

  const props = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const match = /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(line)
      if (match) props.push(match[1])
    }
    for (const char of line) {
      if (char === '{') depth += 1
      if (char === '}') depth = Math.max(0, depth - 1)
    }
  }
  return props.sort()
}

function fail(messages) {
  console.error('CONTROL-PLANE FREEZE VIOLATION (MC-5 / ARCH-H-01)')
  console.error('')
  for (const line of messages) console.error(`  - ${line}`)
  console.error('')
  console.error('ForgeControlPlaneRouteFamilyConfig is a frozen compatibility surface.')
  console.error('Its field set may only SHRINK as control-plane families are extracted')
  console.error('to consuming apps. See:')
  console.error('  packages/server/src/composition/CONTROL-PLANE-CONTRACTION.md')
  console.error('')
  console.error('To legitimately change it:')
  console.error('  - REMOVING a field (contraction): update both source files, the')
  console.error('    contraction schedule, and the controlPlaneFreezeBaseline + the')
  console.error('    forgeServerConfigRouteFamilies manifest in')
  console.error('    config/architecture-boundaries.json.')
  console.error('  - ADDING a field: not permitted without an approved RFC. New product')
  console.error('    control plane belongs in the consuming app via routePlugins.')
  process.exit(1)
}

if (!existsSync(architectureConfigPath)) {
  fail([`Missing config file: ${architectureConfigPath}`])
}

let architectureConfig
try {
  architectureConfig = JSON.parse(readFileSync(architectureConfigPath, 'utf8'))
} catch (err) {
  fail([`Could not parse config/architecture-boundaries.json: ${err.message}`])
}

const baseline = architectureConfig?.serverRouteBoundaries?.controlPlaneFreezeBaseline
if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
  fail([
    'serverRouteBoundaries.controlPlaneFreezeBaseline is missing or malformed in',
    'config/architecture-boundaries.json.',
  ])
}

const interfaceName = baseline.interface
if (typeof interfaceName !== 'string' || interfaceName.length === 0) {
  fail(['controlPlaneFreezeBaseline.interface must be a non-empty string.'])
}

const sourceFiles = baseline.sourceFiles
if (!Array.isArray(sourceFiles) || sourceFiles.length === 0 || !sourceFiles.every((f) => typeof f === 'string')) {
  fail(['controlPlaneFreezeBaseline.sourceFiles must be a non-empty string array.'])
}

const declaredFields = baseline.fields
if (!Array.isArray(declaredFields) || !declaredFields.every((f) => typeof f === 'string')) {
  fail(['controlPlaneFreezeBaseline.fields must be a string array.'])
}

if (typeof baseline.fieldCount !== 'number') {
  fail(['controlPlaneFreezeBaseline.fieldCount must be a number.'])
}

// 1. Contraction schedule doc must exist.
const scheduleRel =
  typeof baseline.contractionSchedule === 'string'
    ? baseline.contractionSchedule
    : 'packages/server/src/composition/CONTROL-PLANE-CONTRACTION.md'
const schedulePath = join(repoRoot, scheduleRel)
if (!existsSync(schedulePath)) {
  fail([`Contraction schedule doc is missing: ${scheduleRel}`])
}

// 2. Baseline self-consistency: declared count must match declared field list.
const declaredSorted = [...declaredFields].sort()
if (baseline.fieldCount !== declaredSorted.length) {
  fail([
    `controlPlaneFreezeBaseline.fieldCount (${baseline.fieldCount}) does not match`,
    `the number of baseline fields (${declaredSorted.length}). Keep them in sync.`,
  ])
}

// 3+4+5. Compare baseline against every mirrored source file.
let referenceFields = null
let referenceFile = null

for (const sourceRel of sourceFiles) {
  const sourcePath = join(repoRoot, sourceRel)
  if (!existsSync(sourcePath)) {
    fail([`Baseline source file is missing: ${sourceRel}`])
  }

  const source = readFileSync(sourcePath, 'utf8')
  const actualFields = collectInterfacePropertyNames(source, interfaceName)
  if (actualFields === null) {
    fail([`Interface ${interfaceName} not found in ${sourceRel}`])
  }

  // Mirrored files must agree with each other.
  if (referenceFields === null) {
    referenceFields = actualFields
    referenceFile = sourceRel
  } else {
    const onlyHere = actualFields.filter((f) => !referenceFields.includes(f))
    const onlyThere = referenceFields.filter((f) => !actualFields.includes(f))
    if (onlyHere.length > 0 || onlyThere.length > 0) {
      fail([
        `Mirrored source files disagree on ${interfaceName} fields.`,
        `${referenceFile} has fields not in ${sourceRel}: [${onlyThere.join(', ') || 'none'}]`,
        `${sourceRel} has fields not in ${referenceFile}: [${onlyHere.join(', ') || 'none'}]`,
      ])
    }
  }

  // Drift vs frozen baseline (both directions).
  const added = actualFields.filter((f) => !declaredSorted.includes(f))
  const removed = declaredSorted.filter((f) => !actualFields.includes(f))
  if (added.length > 0 || removed.length > 0) {
    const messages = [`${interfaceName} in ${sourceRel} drifted from the frozen baseline.`]
    if (added.length > 0) {
      messages.push(
        `ADDED (forbidden — new control-plane field): [${added.join(', ')}]`,
      )
    }
    if (removed.length > 0) {
      messages.push(
        `REMOVED (contraction — record it in the baseline + schedule): [${removed.join(', ')}]`,
      )
    }
    messages.push(
      `Baseline fieldCount=${baseline.fieldCount}, actual=${actualFields.length}.`,
    )
    fail(messages)
  }
}

console.log(
  `Control-plane freeze check passed — ${interfaceName} is frozen at ` +
    `${baseline.fieldCount} fields across ${sourceFiles.length} mirrored source ` +
    `file(s), matching the baseline and contraction schedule.`,
)
