/**
 * End-to-end coverage for the step-output journal chain:
 *
 *   step.execute() -> WorkflowEvent 'step:completed' -> RunJournal
 *     -> rehydrateMessagesFromJournal()  (resume transcript)
 *     -> ConcreteRunHandle.getCheckpoints()  (CheckpointInfo.stepName)
 *
 * Every journal in this file is written by the REAL producer — a compiled
 * workflow actually running with `.withJournal(...)` — never by a hand-built
 * fixture. That is deliberate: the original defect (no producer ever wrote
 * `output` or `toolName`, so every resumed step rendered the literal
 * "[completed]" and every `CheckpointInfo.stepName` was `undefined`) survived
 * precisely because the existing unit fixtures hand-wrote the fields the
 * implementation never produced. Fixture and implementation agreed with each
 * other while both disagreed with the `StepCompletedEntry` contract.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryRunJournal, InMemoryRunStore } from '@dzupagent/core'
import type { RunJournalEntry } from '@dzupagent/core/persistence'
import { createWorkflow } from '../workflow/index.js'
import type { WorkflowStep } from '../workflow/workflow-types.js'
import { rehydrateMessagesFromJournal } from '../agent/resume-utils.js'

/** Journal entries for a run, narrowed to the step_completed slice. */
function stepCompletions(
  entries: RunJournalEntry[],
): Array<{ stepId: string; toolName?: string; output?: unknown }> {
  return entries
    .filter((e) => e.type === 'step_completed')
    .map((e) => e.data as { stepId: string; toolName?: string; output?: unknown })
}

describe('step output reaches the run journal (real producer)', () => {
  let journal: InMemoryRunJournal
  let store: InMemoryRunStore

  beforeEach(() => {
    journal = new InMemoryRunJournal()
    store = new InMemoryRunStore()
  })

  // ── sequential emit path ──────────────────────────────────────────────────

  it('sequential steps persist their real return value as data.output', async () => {
    const fetchStep: WorkflowStep = {
      id: 'fetch',
      description: 'Fetch the user record',
      execute: async () => ({ user: 'ada', hits: 3 }),
    }
    const silentStep: WorkflowStep = { id: 'noop', execute: async () => undefined }

    const workflow = createWorkflow({ id: 'seq-output' })
      .then(fetchStep)
      .then(silentStep)
      .build()
      .withJournal(journal)
      .withStore(store)

    const run = await store.create({ agentId: 'workflow:seq-output', input: {} })
    await workflow.run({}, { runId: run.id })

    const completions = stepCompletions(await journal.getAll(run.id))
    expect(completions).toHaveLength(2)

    const fetched = completions.find((c) => c.stepId === 'fetch')!
    expect(fetched.output).toEqual({ user: 'ada', hits: 3 })
    expect(fetched.toolName).toBe('Fetch the user record')

    // A step that returned nothing must OMIT the keys, not write `undefined` —
    // `exactOptionalPropertyTypes` semantics, and the signal both readers use
    // to fall back to `stepId` / "[completed]".
    const silent = completions.find((c) => c.stepId === 'noop')!
    expect(Object.hasOwn(silent, 'output')).toBe(false)
    expect(Object.hasOwn(silent, 'toolName')).toBe(false)
  })

  it('a non-object step result survives verbatim rather than becoming {}', async () => {
    const workflow = createWorkflow({ id: 'scalar-output' })
      .then({ id: 'render', execute: async () => 'plain string result' })
      .build()
      .withJournal(journal)
      .withStore(store)

    const run = await store.create({ agentId: 'workflow:scalar-output', input: {} })
    await workflow.run({}, { runId: run.id })

    const [completion] = stepCompletions(await journal.getAll(run.id))
    expect(completion!.output).toBe('plain string result')
  })

  // ── parallel emit path ────────────────────────────────────────────────────

  it('parallel branches persist their real return values as data.output', async () => {
    const alpha: WorkflowStep = {
      id: 'alpha',
      description: 'Alpha branch',
      execute: async () => ({ a: 1 }),
    }
    const beta: WorkflowStep = { id: 'beta', execute: async () => ({ b: 2 }) }

    const workflow = createWorkflow({ id: 'par-output' })
      .parallel([alpha, beta])
      .build()
      .withJournal(journal)
      .withStore(store)

    const run = await store.create({ agentId: 'workflow:par-output', input: {} })
    const finalState = await workflow.run({}, { runId: run.id })

    const completions = stepCompletions(await journal.getAll(run.id))
    expect(completions).toHaveLength(2)
    expect(completions.find((c) => c.stepId === 'alpha')!.output).toEqual({ a: 1 })
    expect(completions.find((c) => c.stepId === 'beta')!.output).toEqual({ b: 2 })
    expect(completions.find((c) => c.stepId === 'alpha')!.toolName).toBe('Alpha branch')

    // Guard the merge contract: emitting the raw result must not change what
    // the parallel node contributes to workflow state (`result ?? {}`).
    expect(finalState).toMatchObject({ a: 1, b: 2 })
  })

  // ── consumer A: rehydrateMessagesFromJournal ──────────────────────────────

  it('rehydrates a resumed transcript carrying real sequential step output', async () => {
    const workflow = createWorkflow({ id: 'seq-resume' })
      .then({
        id: 'search',
        description: 'Search the corpus',
        execute: async () => ({ matches: 7, top: 'readme.md' }),
      })
      .then({ id: 'summarise', execute: async () => 'three findings' })
      .build()
      .withJournal(journal)
      .withStore(store)

    const run = await store.create({ agentId: 'workflow:seq-resume', input: {} })
    await workflow.run({}, { runId: run.id })

    const messages = rehydrateMessagesFromJournal(
      await journal.getAll(run.id),
      'summarise the corpus',
    )
    const rendered = messages.map((m) => String(m.content))

    expect(rendered[0]).toBe('summarise the corpus')
    expect(rendered).toHaveLength(3)

    // The whole point: real output, not the "[completed]" placeholder.
    expect(rendered[1]).toContain('"matches":7')
    expect(rendered[1]).toContain('"top":"readme.md"')
    expect(rendered[1]).toContain('Search the corpus')
    expect(rendered[1]).not.toContain('[completed]')

    expect(rendered[2]).toContain('three findings')
    expect(rendered[2]).not.toContain('[completed]')
  })

  it('rehydrates a resumed transcript carrying real parallel step output', async () => {
    const workflow = createWorkflow({ id: 'par-resume' })
      .parallel([
        { id: 'security', description: 'Security scan', execute: async () => ({ vulns: 0 }) },
        { id: 'style', execute: async () => ({ warnings: 12 }) },
      ])
      .build()
      .withJournal(journal)
      .withStore(store)

    const run = await store.create({ agentId: 'workflow:par-resume', input: {} })
    await workflow.run({}, { runId: run.id })

    const rendered = rehydrateMessagesFromJournal(
      await journal.getAll(run.id),
      'review the diff',
    ).map((m) => String(m.content))

    const joined = rendered.join('\n')
    expect(joined).toContain('"vulns":0')
    expect(joined).toContain('"warnings":12')
    expect(joined).toContain('Security scan')
    expect(joined).not.toContain('[completed]')
  })

  it('still renders "[completed]" for a step that genuinely produced nothing', async () => {
    const workflow = createWorkflow({ id: 'empty-resume' })
      .then({ id: 'sideEffectOnly', execute: async () => undefined })
      .build()
      .withJournal(journal)
      .withStore(store)

    const run = await store.create({ agentId: 'workflow:empty-resume', input: {} })
    await workflow.run({}, { runId: run.id })

    const rendered = rehydrateMessagesFromJournal(
      await journal.getAll(run.id),
      'do the thing',
    ).map((m) => String(m.content))

    expect(rendered[1]).toContain('[completed]')
    // With no description the label falls back to the step id.
    expect(rendered[1]).toContain('sideEffectOnly')
  })

  // ── consumer B: getCheckpoints().stepName ─────────────────────────────────

  it('projects WorkflowStep.description onto CheckpointInfo.stepName', async () => {
    const workflow = createWorkflow({ id: 'checkpoint-names' })
      .then({ id: 'plan', description: 'Draft the migration plan', execute: async () => ({ p: 1 }) })
      .then({ id: 'apply', execute: async () => ({ q: 2 }) })
      .build()
      .withJournal(journal)
      .withStore(store)

    const run = await store.create({ agentId: 'workflow:checkpoint-names', input: {} })
    await workflow.run({}, { runId: run.id })

    const checkpoints = await (await workflow.getHandle(run.id)).getCheckpoints()
    expect(checkpoints).toHaveLength(2)

    const planned = checkpoints.find((c) => c.stepId === 'plan')!
    expect(planned.stepName).toBe('Draft the migration plan')

    // A step with no description leaves `stepName` absent (never the string
    // "undefined"); callers fall back to `stepId`, which is always present.
    const applied = checkpoints.find((c) => c.stepId === 'apply')!
    expect(Object.hasOwn(applied, 'stepName')).toBe(false)
    expect(applied.stepId).toBe('apply')
  })

  it('names parallel-branch checkpoints from their descriptions too', async () => {
    const workflow = createWorkflow({ id: 'par-checkpoint-names' })
      .parallel([
        { id: 'db', description: 'Database migration', execute: async () => ({ db: true }) },
        { id: 'api', description: 'API regeneration', execute: async () => ({ api: true }) },
      ])
      .build()
      .withJournal(journal)
      .withStore(store)

    const run = await store.create({ agentId: 'workflow:par-checkpoint-names', input: {} })
    await workflow.run({}, { runId: run.id })

    const checkpoints = await (await workflow.getHandle(run.id)).getCheckpoints()
    expect(checkpoints.map((c) => c.stepName).sort()).toEqual([
      'API regeneration',
      'Database migration',
    ])
  })
})
