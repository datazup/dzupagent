import assert from 'node:assert/strict'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import {
  evaluateCorpusLosslessness,
  loadCorpusSources,
  resolveCorpusManifestPath,
} from '../check-flow-corpus-losslessness.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const EXAMPLES_SEGMENTS = ['docs', 'flow-dsl', 'examples']
const MANIFEST_NAME = 'qualification.manifest.json'
const REPO_EXAMPLES = join(REPO_ROOT, ...EXAMPLES_SEGMENTS)

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function inRepoManifest(root) {
  return join(root, ...EXAMPLES_SEGMENTS, MANIFEST_NAME)
}

function siblingManifest(workspaceRoot) {
  return join(
    workspaceRoot,
    'workspace-docs',
    'repos',
    'dzupagent',
    ...EXAMPLES_SEGMENTS,
    MANIFEST_NAME,
  )
}

function writeManifest(path, bytes) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

/** Copies this repository's docs/flow-dsl/examples/ into a fresh temporary root. */
function copyRepoCorpus(t) {
  const root = tempDir(t, 'flow-corpus-copy-')
  cpSync(REPO_EXAMPLES, join(root, ...EXAMPLES_SEGMENTS), { recursive: true })
  return root
}

/**
 * The `minLossless` floor shipped in c4106906 but nothing passed it, so a
 * fidelity regression stayed silent. This suite pins the verdict logic of the
 * script that arms it.
 *
 * Every fixture below holds all dimensions ACCEPTING except the one under
 * test. Two guards that both reject prove neither, so `passed: true` and a
 * clean summary are held constant while only the round-trip counters move.
 */
function createReport({
  lossless = 26,
  total = 26,
  belowMinLossless = false,
  passed = true,
  items = [],
  summary = {
    total: 26,
    ready: 26,
    changesRequired: 0,
    invalid: 0,
    hashMismatches: 0,
    compileReady: 25,
    compileFailed: 0,
    authoringOnly: 1,
  },
} = {}) {
  return {
    passed,
    summary,
    roundTrip: {
      total,
      lossless,
      lossy: total - lossless,
      notReparsable: 0,
      unparsableSource: 0,
      minLossless: 26,
      belowMinLossless,
    },
    items,
  }
}

test('accepts a corpus that meets the floor', () => {
  const verdict = evaluateCorpusLosslessness(createReport(), 26)

  assert.equal(verdict.ok, true)
  assert.equal(verdict.code, 'OK')
  assert.match(verdict.message, /26\/26 lossless/)
})

test('rejects a round-trip regression below the floor', () => {
  // ONLY the round-trip counters move; admission stays green, so nothing but
  // the ratchet can produce this verdict.
  const verdict = evaluateCorpusLosslessness(
    createReport({
      lossless: 25,
      belowMinLossless: true,
      items: [
        {
          path: '28-sdlc-batch-validation.dzupflow.yaml',
          roundTripStatus: 'lossy',
          roundTripLossPaths: ['document.meta.fragmentExpansions'],
        },
      ],
    }),
    26,
  )

  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'ROUND_TRIP_REGRESSED')
  assert.match(verdict.message, /REGRESSED: 25\/26 lossless, floor is 26/)
  // The offending document must be named — a bare "regressed" is not
  // actionable when the corpus has 26 entries.
  assert.ok(
    verdict.details.some((d) =>
      d.includes('28-sdlc-batch-validation.dzupflow.yaml'),
    ),
    'expected the lossy document to be named in the details',
  )
  assert.ok(
    verdict.details.some((d) =>
      d.includes('document.meta.fragmentExpansions'),
    ),
    'expected the lost field path to be reported',
  )
})

test('reports a non-round-trip admission failure distinctly', () => {
  // Fidelity is fine; admission is not. This must NOT be reported as a
  // round-trip regression, or a hash drift would be misdiagnosed as a
  // formatter defect.
  const verdict = evaluateCorpusLosslessness(
    createReport({
      passed: false,
      summary: {
        total: 26,
        ready: 26,
        changesRequired: 0,
        invalid: 0,
        hashMismatches: 1,
        compileReady: 25,
        compileFailed: 0,
        authoringOnly: 1,
      },
    }),
    26,
  )

  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'QUALIFICATION_FAILED')
  assert.ok(verdict.details.some((d) => d.includes('hashMismatches')))
})

test('round-trip regression outranks a concurrent admission failure', () => {
  // Both are wrong at once. The fidelity verdict must win, because it names
  // the specific documents; QUALIFICATION_FAILED only prints a summary.
  const verdict = evaluateCorpusLosslessness(
    createReport({
      lossless: 20,
      belowMinLossless: true,
      passed: false,
      items: [
        {
          path: 'x.dzupflow.yaml',
          roundTripStatus: 'not-reparsable',
          roundTripLossPaths: [],
        },
      ],
    }),
    26,
  )

  assert.equal(verdict.code, 'ROUND_TRIP_REGRESSED')
})

test('a document with no recorded loss paths still names the file', () => {
  const verdict = evaluateCorpusLosslessness(
    createReport({
      lossless: 25,
      belowMinLossless: true,
      items: [
        {
          path: 'y.dzupflow.yaml',
          roundTripStatus: 'not-reparsable',
          roundTripLossPaths: [],
        },
      ],
    }),
    26,
  )

  assert.ok(verdict.details.some((d) => d.includes('y.dzupflow.yaml')))
  // No trailing "(lost: )" noise when there is nothing to list.
  assert.ok(!verdict.details.some((d) => d.includes('(lost: )')))
})

test('lossless items are omitted from the failure details', () => {
  // Printing all 26 rows on every failure buries the one that matters.
  const verdict = evaluateCorpusLosslessness(
    createReport({
      lossless: 25,
      belowMinLossless: true,
      items: [
        { path: 'good.yaml', roundTripStatus: 'lossless', roundTripLossPaths: [] },
        { path: 'bad.yaml', roundTripStatus: 'lossy', roundTripLossPaths: ['a'] },
      ],
    }),
    26,
  )

  assert.ok(verdict.details.some((d) => d.includes('bad.yaml')))
  assert.ok(!verdict.details.some((d) => d.includes('good.yaml')))
})

test('explicit workspace root wins even for a non-repository path', async () => {
  const { resolveAuditWorkspaceRoot } = await import('../check-flow-corpus-losslessness.mjs')
  assert.equal(resolveAuditWorkspaceRoot('/missing/repository', '/explicit/workspace'), '/explicit/workspace')
})

test('a standalone non-repository path retains sibling-docs semantics', async () => {
  const { resolveAuditWorkspaceRoot } = await import('../check-flow-corpus-losslessness.mjs')
  assert.equal(resolveAuditWorkspaceRoot('/missing/standalone/repository', ''), '/missing/standalone')
})

test('repository discovery uses its Git common directory in linked worktrees', async (t) => {
  const { spawnSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const { dirname, resolve, join } = await import('node:path')
  const { resolveAuditWorkspaceRoot } = await import('../check-flow-corpus-losslessness.mjs')
  const root = resolve(import.meta.dirname, '../..')
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' })
  assert.equal(git.status, 0)
  const workspace = dirname(dirname(git.stdout.trim()))
  if (!existsSync(join(workspace, 'workspace-docs'))) {
    t.skip('standalone checkout has no canonical sibling workspace-docs')
    return
  }
  assert.equal(resolveAuditWorkspaceRoot(root, ''), workspace)
})

test('in-repo manifest wins', (t) => {
  const root = tempDir(t, 'flow-corpus-root-')
  const workspace = tempDir(t, 'flow-corpus-ws-')
  const bytes = readFileSync(join(REPO_EXAMPLES, MANIFEST_NAME))
  writeManifest(inRepoManifest(root), bytes)
  writeManifest(siblingManifest(workspace), bytes)

  assert.equal(
    resolveCorpusManifestPath(root, workspace),
    resolve(root, 'docs/flow-dsl/examples/qualification.manifest.json'),
  )
})

test('falls back to the workspace sibling', (t) => {
  const root = tempDir(t, 'flow-corpus-root-')
  const workspace = tempDir(t, 'flow-corpus-ws-')
  writeManifest(
    siblingManifest(workspace),
    readFileSync(join(REPO_EXAMPLES, MANIFEST_NAME)),
  )

  assert.equal(
    resolveCorpusManifestPath(root, workspace),
    resolve(
      workspace,
      'workspace-docs/repos/dzupagent/docs/flow-dsl/examples/qualification.manifest.json',
    ),
  )
})

test('drift between copies throws', (t) => {
  const root = tempDir(t, 'flow-corpus-root-')
  const workspace = tempDir(t, 'flow-corpus-ws-')
  const bytes = readFileSync(join(REPO_EXAMPLES, MANIFEST_NAME))
  const drifted = Buffer.from(bytes)
  drifted[drifted.length - 1] ^= 0x01
  writeManifest(inRepoManifest(root), bytes)
  writeManifest(siblingManifest(workspace), drifted)

  assert.throws(
    () => resolveCorpusManifestPath(root, workspace),
    (error) =>
      error.message.includes(resolve(inRepoManifest(root))) &&
      error.message.includes(resolve(siblingManifest(workspace))),
  )
})

test('missing both throws', (t) => {
  const root = tempDir(t, 'flow-corpus-root-')
  const workspace = tempDir(t, 'flow-corpus-ws-')

  assert.throws(
    () => resolveCorpusManifestPath(root, workspace),
    (error) => error.code === 'CORPUS_MANIFEST_NOT_FOUND',
  )
})

test('no workspace-docs', (t) => {
  // The real repository with an empty workspace root resolves to its own copy.
  const workspace = tempDir(t, 'flow-corpus-empty-ws-')

  assert.equal(
    resolveCorpusManifestPath(REPO_ROOT, workspace),
    join(REPO_EXAMPLES, MANIFEST_NAME),
  )
})

test('changed byte is rejected', (t) => {
  const root = copyRepoCorpus(t)
  const workspace = tempDir(t, 'flow-corpus-empty-ws-')
  const manifestPath = resolveCorpusManifestPath(root, workspace)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const target = manifest.entries[0].path
  const entryPath = join(root, ...EXAMPLES_SEGMENTS, target)
  const bytes = readFileSync(entryPath)
  bytes[0] ^= 0x01
  writeFileSync(entryPath, bytes)

  assert.throws(
    () => loadCorpusSources(manifestPath),
    (error) =>
      error.code === 'CORPUS_ENTRY_DIGEST_MISMATCH' &&
      error.message.includes(target),
  )
})

test('unchanged copy is accepted', (t) => {
  const root = copyRepoCorpus(t)
  const workspace = tempDir(t, 'flow-corpus-empty-ws-')
  const sources = loadCorpusSources(resolveCorpusManifestPath(root, workspace))

  assert.equal(sources.length, 26)
  assert.ok(sources.every((source) => typeof source.source === 'string'))
})

test('floor is 26', () => {
  const script = readFileSync(
    join(REPO_ROOT, 'scripts', 'check-flow-corpus-losslessness.mjs'),
    'utf8',
  )
  assert.match(script, /^const MIN_LOSSLESS = 26;$/m)
})

test('verify runs the gate', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const verify = pkg.scripts.verify

  assert.ok(
    verify.includes(
      'yarn test:packaging && yarn check:flow-corpus-losslessness && yarn check:build-artifact-integrity',
    ),
  )
  assert.equal(verify.split('yarn check:flow-corpus-losslessness').length - 1, 1)
  assert.equal(
    pkg.scripts['check:flow-corpus-losslessness'],
    'node scripts/check-flow-corpus-losslessness.mjs --require-corpus',
  )
})
