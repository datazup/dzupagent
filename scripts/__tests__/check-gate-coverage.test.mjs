import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CHAIN_DELTA_ALLOWLIST,
  CI_CHAIN,
  ORPHAN_ALLOWLIST,
  ORPHAN_CATEGORIES,
  checkChainNesting,
  findOrphanedGates,
  isGateLike,
  readWorkflows,
  referenceSites,
} from '../check-gate-coverage.mjs'

const SCRIPT = fileURLToPath(new URL('../check-gate-coverage.mjs', import.meta.url))
const SPAWN_TIMEOUT_MS = 20_000

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
)
const realScripts = packageJson.scripts
const realWorkflows = readWorkflows()

/** A workflow fixture. Reachability reads the raw text, so this is all one needs. */
const workflow = (text, name = 'ci.yml') => [{ name, text }]

/** A reason long enough to clear MIN_REASON_LENGTH, so length is not what a test proves. */
const REASON = 'deliberately manual because it writes a baseline file that CI must never rewrite'

// --- the real repository ---------------------------------------------------

test('every gate-like script in package.json runs somewhere, or says why it does not', () => {
  // The drift guard. compareProfileToChain already stops a gate from sitting in
  // the chain but not the profile; nothing stopped a gate from being in neither,
  // which is how check:security-audit-status stayed red and unrun after the
  // document it reads was deleted.
  const result = findOrphanedGates({ scripts: realScripts, workflows: realWorkflows })

  assert.deepEqual(result.unexplained, [], 'a gate-like script runs nowhere and is not explained')
  assert.deepEqual(result.stale, [], 'an allowlist entry no longer describes reality')
  assert.deepEqual(result.invalid, [], 'an allowlist entry is missing a category or a real reason')
  assert.equal(result.ok, true)
})

test('the scan found the known orphan population, not an empty set', () => {
  // Without this, the test above passes just as well when the scanner is broken
  // and returns nothing: "no unexplained orphans" and "I scanned nothing" are
  // the same observation. Pin the population, and pin that the allowlist is
  // describing gates that really are unreachable rather than decorating gates
  // that are fine.
  const result = findOrphanedGates({ scripts: realScripts, workflows: realWorkflows })
  const allowlisted = Object.keys(ORPHAN_ALLOWLIST).sort()

  assert.ok(allowlisted.length > 0, 'the allowlist is empty, so it explains nothing')
  assert.deepEqual(result.orphans, allowlisted)
  assert.equal(result.allowlisted.length, allowlisted.length)

  for (const name of allowlisted) {
    assert.ok(isGateLike(name), `${name} is allowlisted but is not even scanned`)
    assert.deepEqual(
      referenceSites(name, { scripts: realScripts, workflows: realWorkflows }),
      [],
      `${name} is allowlisted as running nowhere but something invokes it`
    )
    assert.ok(
      Object.hasOwn(ORPHAN_CATEGORIES, ORPHAN_ALLOWLIST[name].category),
      `${name} carries an unknown category`
    )
  }
})

test('a gate wired only by a GitHub workflow counts as reachable', () => {
  // check:publish-metadata is the live proof that scanning workflows is
  // load-bearing: a package.json-only scan calls it an orphan, but
  // .github/workflows/publish.yml runs it on every push to main. Vary exactly
  // one input -- the workflow list -- and the verdict flips.
  const withWorkflows = findOrphanedGates({ scripts: realScripts, workflows: realWorkflows })
  const withoutWorkflows = findOrphanedGates({ scripts: realScripts, workflows: [] })

  assert.ok(
    !withWorkflows.orphans.includes('check:publish-metadata'),
    'check:publish-metadata is wired by publish.yml and must not be reported'
  )
  assert.ok(
    withoutWorkflows.orphans.includes('check:publish-metadata'),
    'dropping the workflow scan must change the verdict, or the scan proves nothing'
  )
  assert.deepEqual(
    referenceSites('check:publish-metadata', {
      scripts: realScripts,
      workflows: realWorkflows,
    }),
    ['.github/workflows/publish.yml']
  )
})

test('readWorkflows reads the workflow directory from disk', () => {
  // Hardcoding the list would make the guard go stale the first time a workflow
  // is added, and would let every workflow-reachability test above pass against
  // a fiction.
  assert.ok(realWorkflows.length > 1, 'no workflow files were read')
  const publish = realWorkflows.find((w) => w.name === 'publish.yml')
  assert.ok(publish, 'publish.yml was not read')
  assert.match(publish.text, /yarn check:publish-metadata/)
})

test('a new unexplained orphan in the real script set fails the guard', () => {
  // The fixture is the real package.json plus one synthetic gate, so this
  // asserts the shipping configuration would catch tomorrow's dead gate --
  // not that some hand-built object would.
  const scripts = { ...realScripts, 'check:synthetic-orphan': 'node scripts/nowhere.mjs' }
  const result = findOrphanedGates({ scripts, workflows: realWorkflows })

  assert.equal(result.ok, false)
  assert.deepEqual(result.unexplained, ['check:synthetic-orphan'])

  const [message] = result.messages
  assert.match(message, /check:synthetic-orphan/, 'the message must name the gate')
  assert.match(message, /never executes on any machine/, 'the message must say it runs nowhere')
  assert.match(message, new RegExp(CI_CHAIN), 'the message must name the chain to wire it into')
  assert.match(message, /ORPHAN_ALLOWLIST/, 'the message must name the other way out')
})

// --- chain nesting ---------------------------------------------------------

test('the CI chain is a subset of both local chains, and the delta is annotated', () => {
  // ci:no-circular is meant to be the smallest of three nested chains. Nothing
  // asserted that, so a gate added to verify:strict alone would never run in CI.
  const result = checkChainNesting({ scripts: realScripts })
  const annotated = Object.keys(CHAIN_DELTA_ALLOWLIST).sort()

  assert.deepEqual(result.messages, [])
  assert.equal(result.ok, true)
  assert.ok(annotated.length > 0, 'the delta allowlist is empty, so it explains nothing')
  assert.deepEqual(result.localOnly, annotated)
  assert.ok(result.ciGates.length > 20, `only ${result.ciGates.length} CI gates were parsed`)
})

test('a gate added to a local chain but not the CI chain is reported', () => {
  const scripts = {
    ...realScripts,
    'verify:strict': `${realScripts['verify:strict']} && yarn check:local-only-newcomer`,
  }
  const result = checkChainNesting({ scripts })

  assert.equal(result.ok, false)
  assert.ok(result.localOnly.includes('check:local-only-newcomer'))
  const message = result.messages.find((m) => m.includes('check:local-only-newcomer'))
  assert.match(message, /never runs in CI/)
  assert.match(message, /CHAIN_DELTA_ALLOWLIST/)
})

test('a gate dropped from a local chain while still in the CI chain is reported', () => {
  // The opposite direction: the local chains must stay supersets, or running
  // them locally stops reproducing CI.
  const scripts = {
    ...realScripts,
    'verify:strict': realScripts['verify:strict'].replace('yarn check:package-tiers && ', ''),
  }
  const result = checkChainNesting({ scripts })

  assert.equal(result.ok, false)
  const message = result.messages.find((m) => m.includes('check:package-tiers'))
  assert.match(message, /missing from "verify:strict"/)
  assert.match(message, /nest/)
})

test('a delta entry for a gate that is no longer local-only is reported', () => {
  const result = checkChainNesting({
    scripts: realScripts,
    delta: { ...CHAIN_DELTA_ALLOWLIST, 'check:package-tiers': REASON },
  })

  assert.equal(result.ok, false)
  const message = result.messages.find((m) => m.includes('check:package-tiers'))
  assert.match(message, /no longer a local-only gate/)
})

// --- reachability semantics (fixtures) -------------------------------------

test('a longer script name does not satisfy the shorter one it starts with', () => {
  // check:flow-corpus-losslessness and ...:required differ only by a suffix, and
  // the weaker one is the one CI runs. A substring scan would let a reference to
  // either mark both alive, hiding whichever half is actually dead.
  const shadowed = findOrphanedGates({
    scripts: {
      'check:foo': 'node foo.mjs',
      'check:foo:required': 'node foo.mjs --required',
      ci: 'yarn check:foo:required',
    },
    workflows: [],
    allowlist: {},
  })
  assert.deepEqual(shadowed.orphans, ['check:foo'])

  // Vary only which name the wrapper invokes; the orphan must move with it.
  const mirrored = findOrphanedGates({
    scripts: {
      'check:foo': 'node foo.mjs',
      'check:foo:required': 'node foo.mjs --required',
      ci: 'yarn check:foo',
    },
    workflows: [],
    allowlist: {},
  })
  assert.deepEqual(mirrored.orphans, ['check:foo:required'])
})

test('a script mentioning its own name is still an orphan', () => {
  const scripts = { 'check:loop': 'echo running check:loop', ci: 'echo unrelated' }
  assert.deepEqual(findOrphanedGates({ scripts, workflows: [], allowlist: {} }).orphans, [
    'check:loop',
  ])

  const wired = { ...scripts, ci: 'yarn check:loop' }
  assert.deepEqual(findOrphanedGates({ scripts: wired, workflows: [], allowlist: {} }).orphans, [])
})

test('a gate named only in a YAML comment is not wired', () => {
  // Not hypothetical: verify:strict:ci:no-circular -- the chain that defines
  // what CI runs -- appears outside package.json only in a comment in
  // verify-strict.yml. A scanner that counts comments loses its main subject.
  const result = findOrphanedGates({
    scripts: { 'check:commented': 'node a.mjs', 'check:live': 'node b.mjs' },
    workflows: workflow(
      ['jobs:', '  verify:', '    steps:', '      # see yarn check:commented', '      - run: yarn check:live'].join(
        '\n'
      )
    ),
    allowlist: {},
  })

  assert.deepEqual(result.orphans, ['check:commented'])
})

test('only gate-like prefixes are scanned', () => {
  // Deliberate scope: docs:*, bench* and release:* are hand-run developer
  // commands. Reporting them would make the allowlist mostly noise and train
  // reviewers to wave the real entries through.
  const result = findOrphanedGates({
    scripts: { 'docs:dead': 'node d.mjs', 'check:dead': 'node c.mjs' },
    workflows: [],
    allowlist: {},
  })

  assert.deepEqual(result.orphans, ['check:dead'])
})

// --- allowlist hygiene (fixtures) ------------------------------------------

test('an allowlist entry for a script that became reachable is reported stale', () => {
  // A stale entry is not harmless: it pre-approves the next gate to take that
  // name, and inflates the debt list so the real entries stop being read.
  const result = findOrphanedGates({
    scripts: { 'check:wired': 'node a.mjs', ci: 'yarn check:wired' },
    workflows: [],
    allowlist: { 'check:wired': { category: 'manual-utility', reason: REASON } },
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.unexplained, [])
  assert.equal(result.stale.length, 1)
  assert.match(result.stale[0].problem, /now reachable via package\.json script "ci"/)
})

test('an allowlist entry for a script that no longer exists is reported stale', () => {
  const result = findOrphanedGates({
    scripts: { 'check:live': 'node a.mjs', ci: 'yarn check:live' },
    workflows: [],
    allowlist: { 'check:renamed-away': { category: 'manual-utility', reason: REASON } },
  })

  assert.equal(result.ok, false)
  assert.match(result.stale[0].problem, /not a script in package\.json/)
})

test('an allowlist entry for a name outside the scanned prefixes is reported stale', () => {
  const result = findOrphanedGates({
    scripts: { 'docs:thing': 'node a.mjs' },
    workflows: [],
    allowlist: { 'docs:thing': { category: 'manual-utility', reason: REASON } },
  })

  assert.equal(result.ok, false)
  assert.match(result.stale[0].problem, /never scanned/)
})

test('an allowlist entry with an unknown category fails', () => {
  const result = findOrphanedGates({
    scripts: { 'check:dead': 'node a.mjs' },
    workflows: [],
    allowlist: { 'check:dead': { category: 'because-i-said-so', reason: REASON } },
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.unexplained, [], 'the gate is explained; the explanation is not valid')
  assert.equal(result.invalid.length, 1)
  assert.match(result.invalid[0].problem, /unknown category/)
})

test('an allowlist entry whose reason is a rubber stamp fails', () => {
  // The category alone is cheap to type. The reason is the part a reviewer can
  // disagree with, so it has to actually be one.
  const result = findOrphanedGates({
    scripts: { 'check:dead': 'node a.mjs' },
    workflows: [],
    allowlist: { 'check:dead': { category: 'manual-utility', reason: 'manual' } },
  })

  assert.equal(result.ok, false)
  assert.equal(result.invalid.length, 1)
  assert.match(result.invalid[0].problem, /shorter than/)

  // Control: the same entry with a real reason passes, so length is the only
  // thing that moved.
  const accepted = findOrphanedGates({
    scripts: { 'check:dead': 'node a.mjs' },
    workflows: [],
    allowlist: { 'check:dead': { category: 'manual-utility', reason: REASON } },
  })
  assert.equal(accepted.ok, true)
})

// --- process-level behaviour ------------------------------------------------

test('importing the module does not run the guard', () => {
  // A sibling script called main() at module scope; importing it for its unit
  // tests ran an 86-second 18-package typecheck as a side effect and set
  // process.exitCode from an unrelated failure. Silence on import is the
  // contract, so assert stdout, not just the status.
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(SCRIPT)})`],
    { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS }
  )

  assert.equal(result.signal, null)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '', 'importing the module printed a report, so main() ran')
})

test('invoking the script directly runs the guard and reports', () => {
  // The positive half of the entry-guard contract: guarding main() must not
  // stop it running when this file IS the entry point.
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  })

  assert.equal(result.signal, null)
  assert.match(result.stdout, /=== Gate Coverage Check ===/)
  assert.equal(result.status, 0, result.stderr)
})
