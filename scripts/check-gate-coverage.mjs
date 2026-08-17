#!/usr/bin/env node
/**
 * check-gate-coverage.mjs
 *
 * Fails when a gate-like package.json script is reachable from nothing — no
 * other script invokes it and no GitHub workflow runs it — unless it carries an
 * annotated allowlist entry saying why.
 *
 * Why this exists
 * ---------------
 * `compareProfileToChain` in run-gates.mjs closed one drift class: a gate that
 * sits in the `verify:strict:ci:no-circular` chain but not in the `strict-ci`
 * profile CI actually executes. It cannot see the class one level out — a gate
 * that is in NEITHER. A `check:*` script can be written, reviewed, merged and
 * then referenced by nothing at all. It runs on no machine, ever, and the only
 * evidence of the problem is a line in package.json that looks exactly like the
 * 24 lines around it that do run.
 *
 * That is not hypothetical. The first run of this scanner found fifteen
 * unreferenced gate-like scripts, of which three were rotted red:
 *
 *   - check:security-audit-status reads docs/SECURITY-AUDIT.md, which commit
 *     4f2301b2 deleted. The document was retired; the gate was not. It cannot
 *     pass in any tree and nobody noticed, because nothing ran it.
 *   - check:flow-conformance compares against a matrix artifact last refreshed
 *     on 07-11 while the flow-* packages changed through 08-17.
 *   - check:flow-corpus-losslessness:required is GREEN, and is the strictly
 *     stronger half of a pair whose WEAKER half is the one wired into CI.
 *
 * A guard nobody runs is worse than no guard: it reads as coverage in review
 * and provides none.
 *
 * Two things this scanner had to get right, both found by measurement
 * -------------------------------------------------------------------
 * 1. A mention in a COMMENT is not an invocation. `verify:strict:ci:no-circular`
 *    — the chain that is the human-readable source of truth for CI — appears in
 *    exactly one place outside package.json: a YAML comment in
 *    .github/workflows/verify-strict.yml. A naive substring scan calls that
 *    "wired" and the guard silently loses its most important subject. Whole-line
 *    YAML comments are stripped before scanning. Trailing `#` is deliberately
 *    NOT stripped: security.yml and coverage-gate.yml both contain `#` inside
 *    shell parameter expansions and quoted strings, where cutting the line would
 *    corrupt a real command.
 *
 * 2. Reachability is by SCRIPT NAME, never by the file the script runs. Three
 *    pairs in this repo share one .mjs file between an enforcing variant and a
 *    report-only or writer variant — check:test-typecheck vs
 *    check-test-typecheck.mjs --report-only, check:flow-conformance vs
 *    docs:flow-conformance, check:workspace:coverage vs
 *    test:coverage:workspace:report. File-level reachability would mark every
 *    dead half alive because its live sibling shares the file.
 *
 * Name matching is boundary-anchored for the same reason: `check:test-typecheck`
 * must not count as referenced because `check:test-typecheck:update-baseline`
 * appears somewhere, and `check:flow-corpus-losslessness` must not be satisfied
 * by a reference to `...:required`. A script name may only be preceded and
 * followed by a character that cannot continue a script name.
 *
 * The second invariant: chain nesting
 * -----------------------------------
 * The same defect class exists one level up. Three verify chains are supposed to
 * be nested supersets — ci:no-circular ⊆ no-circular ⊆ strict — so that anything
 * CI runs also runs locally. Nothing asserted that, so a gate added to
 * `verify:strict` alone would never run in CI and a gate quietly dropped from
 * the CI chain would leave the local chains looking unchanged.
 * `checkChainNesting` asserts the nesting and pins the local-only delta to an
 * annotated list, so both directions of that drift fail loudly.
 *
 * How this reaches CI
 * -------------------
 * It does not need a package.json script. `scripts/__tests__/*.test.mjs` is run
 * by `test:scripts`, which is gate 18 of both the CI chain and the strict-ci
 * profile, so the accompanying test file is itself the gate. That matters here
 * more than usual: package.json is digest-pinned by
 * docs/generated/MEMORY_CONFORMANCE_BASELINE.v1.json (`source.files[]`), so
 * adding a script would force an unrelated artifact re-pin.
 *
 * Known limit: reachability is ONE HOP. A gate referenced only by another gate
 * that is itself dead reads as reachable. Closing that needs a walk from a root
 * set, and this repo has no single root (workflows, humans and release tooling
 * all invoke scripts directly). The shallow rule is what the population
 * actually needs today; it is written down so the next reader does not mistake
 * it for an oversight.
 *
 * Usage:
 *   node scripts/check-gate-coverage.mjs
 *
 * Exit codes:
 *   0 — every gate-like script is reachable or explained, and the chains nest
 *   1 — an unexplained orphan, a stale/invalid allowlist entry, or broken nesting
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseChainGates } from './run-gates.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const WORKFLOW_DIR = join(ROOT, '.github', 'workflows')
const PACKAGE_JSON = join(ROOT, 'package.json')

/**
 * Scope. `check:` alone would miss the verify chains and the lint/test/audit
 * gates, which fail the same way. Widening past these five is measurably worse,
 * not better: all 77 scripts yield 27 unreferenced names, and the 12 extra are
 * `docs:*`, `bench*`, `release:status` and similar developer commands that are
 * SUPPOSED to be hand-run. An allowlist where most entries say "this is a
 * developer command" trains reviewers to rubber-stamp the ones that matter.
 */
export const GATE_PREFIXES = ['check:', 'verify:', 'test:', 'lint:', 'audit:']

/**
 * Categories exist so the allowlist can be triaged without reading every reason.
 * `pending-*` entries are debt with an owner; `manual-utility` and
 * `chain-definition` are permanent and correct.
 */
export const ORPHAN_CATEGORIES = {
  'chain-definition': 'a verify chain — invoked by humans and by the run-gates profile, not by name',
  'manual-utility': 'a report-only or baseline-writing variant that is correct to run by hand',
  'pending-operator-decision': 'red and blocked on an operator choice (restore the gate or retire it)',
  'pending-wiring': 'green and should run, but wiring it is blocked on something out of scope',
}

/**
 * A reason shorter than this is a rubber stamp, not an explanation. The point of
 * the allowlist is that the next reader can tell "deliberately manual" from
 * "forgotten"; "manual" as a reason cannot carry that.
 */
export const MIN_REASON_LENGTH = 40

/**
 * Every gate-like script that nothing invokes, with why that is acceptable.
 * Adding an entry here is the act of accepting the debt — keep the reason
 * specific enough that a reviewer can disagree with it.
 */
export const ORPHAN_ALLOWLIST = {
  'verify:strict': {
    category: 'chain-definition',
    reason:
      'Top-level local chain (28 gates). Nothing invokes it by name: CI runs the strict-ci profile via `verify:gates`, and humans run this by hand. Its contents are load-bearing — checkChainNesting asserts the CI chain is a subset of it.',
  },
  'verify:strict:no-circular': {
    category: 'chain-definition',
    reason:
      'Local chain (26 gates) for trees where the inline circular-import scan is too slow to tolerate. Same status as verify:strict; its contents are asserted by checkChainNesting.',
  },
  'verify:strict:ci:no-circular': {
    category: 'chain-definition',
    reason:
      'THE CI chain (24 gates) — the human-readable source of truth that scripts/__tests__/run-gates.test.mjs compares the strict-ci profile against. CI executes the profile, so nothing invokes this by name; its only mention outside package.json is a YAML comment, which is exactly why this scanner strips comments before deciding reachability.',
  },
  'lint:baseline:update': {
    category: 'manual-utility',
    reason:
      'Writer: rewrites eslint.baseline.js. Must never run in CI — it would ratchet the baseline up to whatever the branch happens to contain and erase the regression it exists to catch.',
  },
  'lint:baseline:check': {
    category: 'manual-utility',
    reason:
      'The `--dry-run` companion of lint:baseline:update; reports baseline drift without writing. Enforcement happens in `yarn lint`, which passes --max-warnings=baseline to every package.',
  },
  'test:inventory:capability': {
    category: 'manual-utility',
    reason:
      'The `--capability-report` variant of check-runtime-test-inventory.mjs. The enforcing variant, test:inventory:runtime:strict, is gate 2 of the CI chain.',
  },
  'test:coverage:workspace:report': {
    category: 'manual-utility',
    reason:
      'The `--report-only` variant of check-workspace-coverage.mjs. The enforcing variant runs in CI as `yarn test:coverage:workspace` in .github/workflows/coverage-gate.yml.',
  },
  'test:policy:fallback:audit': {
    category: 'manual-utility',
    reason:
      'Hand-run audit that re-runs six named policy/fallback suites in core and agent-adapters. Those suites are already inside the workspace `test` task that the build gate runs; this script exists to run just them, quickly, while working on that area.',
  },
  'verify:gates:list': {
    category: 'manual-utility',
    reason:
      'Passes --list to run-gates.mjs: prints the strict-ci profile and executes no gate. Wiring it into CI would assert nothing.',
  },
  'check:test-typecheck:update-baseline': {
    category: 'manual-utility',
    reason:
      'Writer: rewrites scripts/check-test-typecheck.baseline.json. Must never run in CI — it would accept whatever type errors the branch introduced as the new floor.',
  },
  'check:test-typecheck:report': {
    category: 'manual-utility',
    reason:
      'The `--report-only` variant, which prints counts and exits 0 by design. check:test-typecheck, gate 17 of the CI chain, is the enforcing one.',
  },
  'audit:deps:summary': {
    category: 'manual-utility',
    reason:
      'The `--json` variant of audit:deps, for tooling that wants to parse the advisory list. Note audit:deps itself is not in the CI chain either — see CHAIN_DELTA_ALLOWLIST, which records what CI does instead.',
  },
  'check:security-audit-status': {
    category: 'pending-operator-decision',
    reason:
      'RED and unfixable in any tree: it requires docs/SECURITY-AUDIT.md, which commit 4f2301b2 ("consolidate architecture docs and retire audits") deleted. The document was retired and the gate was not. Restore-or-retire is an operator decision — brief at workspace-docs/repos/workspace-root/docs/decisions/OPERATOR_DECISION_BRIEF_2026-08-17-two-gates-that-run-nowhere.md. Verified red 2026-08-17.',
  },
  'check:flow-conformance': {
    category: 'pending-operator-decision',
    reason:
      'RED: docs/generated/FLOW_NODE_CONFORMANCE_MATRIX.{md,json} are stale, last refreshed 07-11 while the flow-* packages changed through 08-17. Not a mechanical fix — the matrix has to be regenerated from a quiescent flow-* tree, and whether it is still worth carrying is an operator decision. Same brief as check:security-audit-status. Verified red 2026-08-17.',
  },
  'check:flow-corpus-losslessness:required': {
    category: 'pending-wiring',
    reason:
      'GREEN (26/26, floor 26) and strictly stronger than check:flow-corpus-losslessness, which IS gate 20 of the CI chain: this variant passes --require-corpus, so it fails when the corpus is missing instead of vacuously passing over zero documents. CI therefore runs the weaker half of the pair. Swapping them edits the root package.json chain, and package.json is digest-pinned by docs/generated/MEMORY_CONFORMANCE_BASELINE.v1.json (source.files[]), forcing an artifact re-pin. Deliberately deferred. Verified green 2026-08-17.',
  },
}

/** The chain CI executes, via the run-gates strict-ci profile. */
export const CI_CHAIN = 'verify:strict:ci:no-circular'

/** Chains a human runs locally. Each must be a superset of the CI chain. */
export const LOCAL_CHAINS = ['verify:strict:no-circular', 'verify:strict']

/**
 * Gates present in a local chain and absent from the CI chain, with what CI does
 * about each instead.
 *
 * The naive reading of this delta — "four gates never run in CI" — is wrong for
 * three of the four, and getting that wrong in either direction is expensive: it
 * either provokes a pointless chain edit or hides a real hole. Each entry states
 * where the capability is covered, or says plainly that it is not.
 */
export const CHAIN_DELTA_ALLOWLIST = {
  'check:circular-deps':
    'COVERED IN CI, elsewhere: .github/workflows/verify-strict.yml runs the same scan as its own 4-way sharded `circular-deps` job, invoking scripts/check-circular-deps.mjs directly. That is why the CI chain is named "no-circular" — the work moved to a parallel job, it was not dropped.',
  'test:coverage':
    'COVERED IN CI, elsewhere: coverage runs as its own workflow, .github/workflows/coverage-gate.yml, per-workspace in a matrix. Running it inline would roughly double the strict lane for no extra signal.',
  'check:workspace:coverage':
    'COVERED IN CI, under a different name: this and test:coverage:workspace are two script names for one file, scripts/check-workspace-coverage.mjs, and coverage-gate.yml enforces it as `yarn test:coverage:workspace`.',
  'audit:deps':
    'NOT covered in CI under this name. .github/workflows/security.yml has a dependency-audit job, but it runs `yarn audit --level moderate` inline — Yarn Classic syntax, while this repo is on Yarn 4 where the command is `yarn npm audit`. Whether that job can fail on a real advisory has not been established; flagged here rather than fixed, because editing the security workflow is outside this guard.',
}

/**
 * A script name is only a reference when it stands alone. `check:test-typecheck`
 * appearing inside `check:test-typecheck:update-baseline` is a different script,
 * and treating it as a reference would let the enforcing half of a pair look
 * wired because its writer half is mentioned somewhere.
 * @param {string} name
 * @param {string} haystack
 * @returns {boolean}
 */
export function referencesScript(name, haystack) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w:.-])${escaped}(?![\\w:.-])`).test(haystack)
}

/**
 * Drops whole-line YAML comments. See the header: a gate named only in a comment
 * is not wired, and this repo's most important chain is in exactly that state.
 * Trailing `#` is left alone on purpose — it appears inside `${var#prefix}` and
 * inside quoted grep patterns in the real workflows.
 * @param {string} text
 * @returns {string}
 */
export function stripYamlComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

/**
 * Reads .github/workflows/*.yml|yaml from disk. Never hardcode the list: a
 * workflow added tomorrow has to count as reachability the day it lands.
 * @param {string} [dir]
 * @returns {{ name: string, text: string }[]}
 */
export function readWorkflows(dir = WORKFLOW_DIR) {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}

/** @param {string} name @returns {boolean} */
export function isGateLike(name) {
  return GATE_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * Every place a script name is invoked, described well enough to put in an error
 * message. A script mentioning its own name is not reachability.
 * @param {string} name
 * @param {{ scripts: Record<string, string>, workflows: { name: string, text: string }[] }} sources
 * @returns {string[]}
 */
export function referenceSites(name, { scripts, workflows }) {
  const sites = []

  for (const [script, command] of Object.entries(scripts)) {
    if (script === name) continue
    if (referencesScript(name, command)) sites.push(`package.json script "${script}"`)
  }

  for (const workflow of workflows) {
    if (referencesScript(name, stripYamlComments(workflow.text))) {
      sites.push(`.github/workflows/${workflow.name}`)
    }
  }

  return sites
}

const orphanMessage = (name) =>
  `gate script "${name}" is reachable from nothing — no other package.json script invokes it and no .github/workflows/*.yml file runs it, so it never executes on any machine. Two ways out: wire it into a chain (${CI_CHAIN} is what CI runs, via the run-gates strict-ci profile), or add an entry to ORPHAN_ALLOWLIST in scripts/check-gate-coverage.mjs carrying a category and a reason that says why it is correct for this gate to run nowhere.`

/**
 * @param {{
 *   scripts: Record<string, string>,
 *   workflows: { name: string, text: string }[],
 *   allowlist?: Record<string, { category: string, reason: string }>,
 * }} input
 * @returns {{
 *   ok: boolean, orphans: string[], unexplained: string[],
 *   allowlisted: { script: string, category: string, reason: string }[],
 *   stale: { script: string, problem: string }[],
 *   invalid: { script: string, problem: string }[],
 *   messages: string[],
 * }}
 */
export function findOrphanedGates({ scripts, workflows, allowlist = ORPHAN_ALLOWLIST }) {
  const orphans = []
  const unexplained = []
  const allowlisted = []
  const stale = []
  const invalid = []
  const messages = []

  for (const name of Object.keys(scripts).filter(isGateLike).sort()) {
    if (referenceSites(name, { scripts, workflows }).length > 0) continue
    orphans.push(name)

    const entry = allowlist[name]
    if (!entry) {
      unexplained.push(name)
      messages.push(orphanMessage(name))
      continue
    }
    allowlisted.push({ script: name, ...entry })
  }

  // The allowlist has to stay as honest as the scan. An entry that outlives its
  // orphan is not harmless: it pre-approves the next script to take that name,
  // and it makes the debt list read as longer than it is.
  for (const [name, entry] of Object.entries(allowlist)) {
    if (!Object.hasOwn(scripts, name)) {
      const problem = `is allowlisted but is not a script in package.json — it was renamed or removed; delete the entry`
      stale.push({ script: name, problem })
      messages.push(`"${name}" ${problem}.`)
      continue
    }
    if (!isGateLike(name)) {
      const problem = `is allowlisted but does not start with a gate prefix (${GATE_PREFIXES.join(', ')}), so it is never scanned and the entry asserts nothing — delete it, or widen GATE_PREFIXES`
      stale.push({ script: name, problem })
      messages.push(`"${name}" ${problem}.`)
      continue
    }

    const sites = referenceSites(name, { scripts, workflows })
    if (sites.length > 0) {
      const problem = `is allowlisted as running nowhere, but is now reachable via ${sites.join(', ')} — delete the entry`
      stale.push({ script: name, problem })
      messages.push(`"${name}" ${problem}.`)
      continue
    }

    if (!Object.hasOwn(ORPHAN_CATEGORIES, entry.category)) {
      const problem = `has unknown category "${entry.category}" — use one of: ${Object.keys(ORPHAN_CATEGORIES).join(', ')}`
      invalid.push({ script: name, problem })
      messages.push(`"${name}" ${problem}.`)
      continue
    }
    if (!entry.reason || entry.reason.trim().length < MIN_REASON_LENGTH) {
      const problem = `has a reason shorter than ${MIN_REASON_LENGTH} characters — say why this gate is correct to run nowhere, not that it is`
      invalid.push({ script: name, problem })
      messages.push(`"${name}" ${problem}.`)
    }
  }

  return { ok: messages.length === 0, orphans, unexplained, allowlisted, stale, invalid, messages }
}

/**
 * Asserts ci:no-circular ⊆ no-circular ⊆ strict, and that the local-only delta
 * is exactly the annotated set. Reuses run-gates.mjs's parseChainGates rather
 * than re-deriving it: a second hand-written parser is the same
 * hand-transcribed-copy defect that made this family of guards necessary.
 * @param {{ scripts: Record<string, string>, delta?: Record<string, string> }} input
 * @returns {{ ok: boolean, messages: string[], ciGates: string[], localOnly: string[] }}
 */
export function checkChainNesting({ scripts, delta = CHAIN_DELTA_ALLOWLIST }) {
  const messages = []

  if (!scripts[CI_CHAIN]) {
    return {
      ok: false,
      messages: [`the CI chain "${CI_CHAIN}" is not a script in package.json`],
      ciGates: [],
      localOnly: [],
    }
  }

  const ciGates = parseChainGates(scripts[CI_CHAIN])
  const localOnly = new Set()

  for (const chain of LOCAL_CHAINS) {
    if (!scripts[chain]) {
      messages.push(`the local chain "${chain}" is not a script in package.json`)
      continue
    }
    const gates = parseChainGates(scripts[chain])

    for (const gate of ciGates) {
      if (!gates.includes(gate)) {
        messages.push(
          `gate "${gate}" is in the CI chain "${CI_CHAIN}" but missing from "${chain}" — the chains are supposed to nest (${CI_CHAIN} ⊆ ${LOCAL_CHAINS.join(' ⊆ ')}), so a developer running the local chain would not reproduce a CI failure`
        )
      }
    }
    for (const gate of gates) {
      if (!ciGates.includes(gate)) localOnly.add(gate)
    }
  }

  for (const gate of [...localOnly].sort()) {
    const reason = delta[gate]
    if (!reason) {
      messages.push(
        `gate "${gate}" is in a local verify chain but NOT in the CI chain "${CI_CHAIN}", so it never runs in CI. Either add it to the CI chain, or add an entry to CHAIN_DELTA_ALLOWLIST in scripts/check-gate-coverage.mjs stating where CI covers it instead — or that it is not covered at all.`
      )
      continue
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      messages.push(
        `gate "${gate}" has a CHAIN_DELTA_ALLOWLIST reason shorter than ${MIN_REASON_LENGTH} characters — name the workflow or job that covers it, or say it is uncovered.`
      )
    }
  }

  for (const gate of Object.keys(delta)) {
    if (!localOnly.has(gate)) {
      messages.push(
        `"${gate}" is in CHAIN_DELTA_ALLOWLIST but is no longer a local-only gate — it was either wired into "${CI_CHAIN}" or dropped from every local chain. Delete the entry.`
      )
    }
  }

  return { ok: messages.length === 0, messages, ciGates, localOnly: [...localOnly].sort() }
}

function main() {
  const scripts = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).scripts ?? {}
  const workflows = readWorkflows()

  const coverage = findOrphanedGates({ scripts, workflows })
  const nesting = checkChainNesting({ scripts })

  console.log('\n=== Gate Coverage Check ===\n')
  console.log(
    `Scanned ${Object.keys(scripts).length} scripts (${
      Object.keys(scripts).filter(isGateLike).length
    } gate-like) against ${workflows.length} workflow file(s).`
  )
  console.log(
    `${coverage.orphans.length} run nowhere; ${coverage.allowlisted.length} of those are explained.\n`
  )

  const byCategory = new Map()
  for (const entry of coverage.allowlisted) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, [])
    byCategory.get(entry.category).push(entry.script)
  }
  for (const [category, names] of [...byCategory].sort()) {
    console.log(`  ${category} (${names.length}): ${names.join(', ')}`)
  }

  console.log(
    `\nLocal-only gates (in a local chain, not in ${CI_CHAIN}): ${
      nesting.localOnly.join(', ') || 'none'
    }`
  )

  const messages = [...coverage.messages, ...nesting.messages]
  if (messages.length > 0) {
    console.error(`\nFAIL: ${messages.length} problem(s).\n`)
    for (const message of messages) console.error(`  - ${message}\n`)
    process.exit(1)
  }

  console.log('\nOK: every gate-like script runs somewhere or is explained, and the chains nest.')
}

// Entry guard, not decoration. A sibling script here called main() at module
// scope; importing it for a unit test therefore ran an 86-second 18-package
// typecheck as an import side effect and set process.exitCode from an unrelated
// failure, turning `yarn test:scripts` red for a reason no script test caused.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
