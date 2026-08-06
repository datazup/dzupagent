/**
 * F-R2 runtime-trace agreement (acceptance 3, second half): the port classes
 * the compiler pins on `CompileSuccess.ports` must agree with what a live
 * `PipelineRuntime` run actually does with the compiled artifact.
 *
 * This package is the sanctioned meeting point — it already depends on both
 * `@dzupagent/flow-compiler` (compile) and `@dzupagent/agent` (execute) — so
 * no new dependency edge is introduced. No mocks on either side: the real
 * four-stage compiler produces the `PipelineDefinition`, and the real
 * checkpoint-based runtime executes it. Only the leaf node executor is a
 * recording stub (no LLM/network), which is exactly the host seam.
 *
 * Agreement claims proven here:
 *  1. suspendedExits — the live run stops in state `suspended` at exactly the
 *     pinned node, and the REJECTED outcome of an approval without `onReject`
 *     dead-ends: resuming with a `rejected` decision must NOT fail open into
 *     the approve body or the next sibling.
 *  2. normalExits — an `approved` resume continues through the approve body
 *     and the next sibling, and the trace's final node IS the pinned normal
 *     exit of the root fragment.
 *  3. terminalExits — a lowered `complete` suspends the run at the pinned
 *     terminal node with no lowered continuation: resuming executes nothing
 *     further and the run completes.
 *
 * This file is also the first consumer of the approval-resume host contract:
 * the compiler names the gate's conditional-edge predicate
 * `approval__<gateId>__predicate` and keys its branches `approved`/`rejected`,
 * so the host predicate must return one of those branch keys for the decision
 * to route. An unmatched key is fail-closed (no continuation) by design.
 */

import { describe, expect, it } from 'vitest'
import { createBuiltinToolRegistry } from '@dzupagent/app-tools'
import type { TopicRecord } from '@dzupagent/app-tools'
import { createFlowCompiler } from '@dzupagent/flow-compiler'
import type { CompileSuccess, LoweredPorts } from '@dzupagent/flow-compiler'
import { InMemoryPipelineCheckpointStore, PipelineRuntime } from '@dzupagent/agent'
import type { PipelineRuntimeEvent } from '@dzupagent/agent'
import type { PipelineDefinition, PipelineNode } from '@dzupagent/core/pipeline'

const TEST_TOPICS: TopicRecord[] = [
  {
    id: 'topic-ts',
    title: 'TypeScript',
    summary: 'Typed superset of JavaScript',
    tags: ['language'],
  },
]

// ---------------------------------------------------------------------------
// Compile helper — real compiler, real builtin-registry resolver
// ---------------------------------------------------------------------------

async function compileToPipeline(flow: unknown): Promise<{
  definition: PipelineDefinition
  ports: LoweredPorts
}> {
  const bundle = createBuiltinToolRegistry({ topics: TEST_TOPICS })
  const compiler = createFlowCompiler({ toolResolver: bundle.toToolResolver() })
  const result = await compiler.compile(flow as object)

  if (!('artifact' in result)) {
    throw new Error(
      `expected CompileSuccess, got failure: ${JSON.stringify(result)}`,
    )
  }
  const success = result as CompileSuccess
  // Ports ship on every pipeline-family target; suspend-only flows route to
  // `workflow-builder`, which lowers through the same flat pipeline path.
  expect(['pipeline', 'workflow-builder', 'planning-dag']).toContain(
    success.target,
  )
  expect(success.ports).toBeDefined()
  return {
    definition: success.artifact as PipelineDefinition,
    ports: success.ports as LoweredPorts,
  }
}

// ---------------------------------------------------------------------------
// Runtime helper — real PipelineRuntime, recording leaf executor
// ---------------------------------------------------------------------------

interface TraceHarness {
  runtime: PipelineRuntime
  /** node names (falling back to ids) in execution order */
  executedNames: string[]
  /** node ids in execution order */
  executedIds: string[]
  events: PipelineRuntimeEvent[]
  store: InMemoryPipelineCheckpointStore
}

function makeTraceHarness(
  definition: PipelineDefinition,
  predicates?: Record<string, (state: Record<string, unknown>) => boolean>,
): TraceHarness {
  const executedNames: string[] = []
  const executedIds: string[] = []
  const events: PipelineRuntimeEvent[] = []
  const store = new InMemoryPipelineCheckpointStore()

  const runtime = new PipelineRuntime({
    definition,
    checkpointStore: store,
    predicates,
    onEvent: (event) => events.push(event),
    nodeExecutor: async (nodeId, node) => {
      executedNames.push((node as PipelineNode).name ?? nodeId)
      executedIds.push(nodeId)
      return { nodeId, output: { ok: true }, durationMs: 0 }
    },
  })

  return { runtime, executedNames, executedIds, events, store }
}

function suspendedNodeId(events: PipelineRuntimeEvent[]): string {
  const suspended = events.find(
    (e): e is Extract<PipelineRuntimeEvent, { type: 'pipeline:suspended' }> =>
      e.type === 'pipeline:suspended',
  )
  if (suspended === undefined) {
    throw new Error('expected a pipeline:suspended event')
  }
  return suspended.nodeId
}

/**
 * The compiler names the approval gate's conditional-edge predicate after the
 * gate id; the branch taken is the STRING the predicate returns (`approved` /
 * `rejected`), threaded through the runtime's boolean-typed predicate slot.
 */
function approvalDecision(
  gateId: string,
  decision: 'approved' | 'rejected',
): Record<string, (state: Record<string, unknown>) => boolean> {
  return {
    [`approval__${gateId}__predicate`]: () =>
      decision as unknown as boolean,
  }
}

// ---------------------------------------------------------------------------
// Fixtures — suspend-bearing flows that route to the `pipeline` target
// ---------------------------------------------------------------------------

/** action → approval (no onReject) → action: one suspended exit at the gate. */
const APPROVAL_FLOW = {
  type: 'sequence',
  nodes: [
    { type: 'action', toolRef: 'topics.search', input: { query: 'ts' } },
    {
      type: 'approval',
      question: 'proceed?',
      onApprove: [{ type: 'action', toolRef: 'topics.list', input: {} }],
    },
    { type: 'action', toolRef: 'topics.get', input: { id: 'topic-ts' } },
  ],
}

/**
 * action → branch(then: complete / else: action): the then-arm deliberately
 * ends the flow, so the branch contributes one terminal exit while the
 * else-arm remains the fragment's normal exit.
 */
const TERMINAL_FLOW = {
  type: 'sequence',
  nodes: [
    { type: 'action', toolRef: 'topics.search', input: { query: 'ts' } },
    {
      type: 'branch',
      condition: 'halt',
      then: [{ type: 'complete', id: 'done', result: 'all done' }],
      else: [{ type: 'action', toolRef: 'topics.list', input: {} }],
    },
  ],
}

/** The branch gate's conditional edge is keyed by a REAL boolean predicate. */
function branchDecision(
  definition: PipelineDefinition,
  outcome: boolean,
): Record<string, (state: Record<string, unknown>) => boolean> {
  const gate = definition.nodes.find((n) => n.name?.startsWith('branch:'))
  if (gate === undefined) {
    throw new Error('expected a lowered branch gate in the definition')
  }
  return { [`branch__${gate.id}__predicate`]: () => outcome }
}

// ---------------------------------------------------------------------------
// Agreement tests
// ---------------------------------------------------------------------------

describe('F-R2 trace agreement: suspended exits', () => {
  it('the live run suspends at exactly the pinned suspended-exit node', async () => {
    const { definition, ports } = await compileToPipeline(APPROVAL_FLOW)

    // Compiled claim: exactly one suspended exit (the approval gate).
    expect(ports.suspendedExits).toHaveLength(1)
    const gateId = ports.suspendedExits[0] as string

    const { runtime, executedNames, events } = makeTraceHarness(definition)
    const result = await runtime.execute()

    expect(result.state).toBe('suspended')
    expect(suspendedNodeId(events)).toBe(gateId)

    // Trace up to the suspension: the first sibling ran, nothing behind the
    // gate did.
    expect(executedNames).toContain('topics.search')
    expect(executedNames).not.toContain('topics.list')
    expect(executedNames).not.toContain('topics.get')
  })

  it('rejected with no onReject dead-ends at the gate — no fail-open into the continuation', async () => {
    const { definition, ports } = await compileToPipeline(APPROVAL_FLOW)
    const gateId = ports.suspendedExits[0] as string

    const harness = makeTraceHarness(
      definition,
      approvalDecision(gateId, 'rejected'),
    )
    const first = await harness.runtime.execute()
    expect(first.state).toBe('suspended')

    const checkpoint = await harness.store.load(first.runId)
    expect(checkpoint).not.toBeNull()
    const resumed = await harness.runtime.resume(checkpoint!)

    // The rejected outcome has no lowered continuation: the run ends without
    // ever executing the approve body or the sibling after the approval.
    expect(resumed.state).toBe('completed')
    expect(harness.executedNames).not.toContain('topics.list')
    expect(harness.executedNames).not.toContain('topics.get')
  })
})

describe('F-R2 trace agreement: normal exits continue', () => {
  it('approving resumes through the body and the run ends at the pinned normal exit', async () => {
    const { definition, ports } = await compileToPipeline(APPROVAL_FLOW)
    const gateId = ports.suspendedExits[0] as string

    // Compiled claim: the root fragment's single normal exit is the sibling
    // after the approval.
    expect(ports.normalExits).toHaveLength(1)

    const harness = makeTraceHarness(
      definition,
      approvalDecision(gateId, 'approved'),
    )
    const first = await harness.runtime.execute()
    expect(first.state).toBe('suspended')
    const executedBeforeResume = harness.executedIds.length

    const checkpoint = await harness.store.load(first.runId)
    const resumed = await harness.runtime.resume(checkpoint!)

    expect(resumed.state).toBe('completed')
    // The approve body ran, then the sibling after the approval.
    expect(harness.executedNames).toContain('topics.list')
    expect(harness.executedNames).toContain('topics.get')
    // Resume did not replay the pre-suspend prefix.
    expect(
      harness.executedNames.slice(executedBeforeResume),
    ).not.toContain('topics.search')
    // The trace's final node IS the pinned normal exit of the root fragment.
    expect(harness.executedIds[harness.executedIds.length - 1]).toBe(
      ports.normalExits[0],
    )
  })
})

describe('F-R2 trace agreement: terminal exits end the run', () => {
  it('the run stops at the pinned terminal node and resuming executes nothing further', async () => {
    const { definition, ports } = await compileToPipeline(TERMINAL_FLOW)

    // Compiled claim: the then-arm's `complete` is the one terminal exit,
    // disjoint from the normal continuation (the else-arm tail).
    expect(ports.terminalExits).toHaveLength(1)
    const terminalId = ports.terminalExits[0] as string
    expect(ports.normalExits).not.toContain(terminalId)

    const harness = makeTraceHarness(
      definition,
      branchDecision(definition, true),
    )
    const first = await harness.runtime.execute()

    expect(first.state).toBe('suspended')
    expect(suspendedNodeId(harness.events)).toBe(terminalId)
    expect(harness.executedNames).toContain('topics.search')
    expect(harness.executedNames).not.toContain('topics.list')

    // The terminal node has no lowered continuation: resume completes the
    // run without executing a single additional node.
    const executedBeforeResume = harness.executedIds.length
    const checkpoint = await harness.store.load(first.runId)
    const resumed = await harness.runtime.resume(checkpoint!)

    expect(resumed.state).toBe('completed')
    expect(harness.executedIds).toHaveLength(executedBeforeResume)
  })

  it('the untaken else-arm continues to the pinned normal exit and never touches the terminal node', async () => {
    const { definition, ports } = await compileToPipeline(TERMINAL_FLOW)

    const harness = makeTraceHarness(
      definition,
      branchDecision(definition, false),
    )
    const result = await harness.runtime.execute()

    // No suspend-bearing node on the else path: the run completes in one go
    // and its final node is the fragment's pinned normal exit.
    expect(result.state).toBe('completed')
    expect(harness.executedNames).toContain('topics.list')
    expect(ports.normalExits).toContain(
      harness.executedIds[harness.executedIds.length - 1],
    )
    // The terminal node was never traversed.
    expect(harness.executedIds).not.toContain(ports.terminalExits[0])
  })
})

describe('F-R2 trace agreement: ports reference real artifact nodes', () => {
  it('every pinned port id resolves to a node in the compiled definition', async () => {
    for (const flow of [APPROVAL_FLOW, TERMINAL_FLOW]) {
      const { definition, ports } = await compileToPipeline(flow)
      const ids = new Set(definition.nodes.map((n) => n.id))
      for (const portClass of [
        ports.entryNodeIds,
        ports.normalExits,
        ports.suspendedExits,
        ports.terminalExits,
        ports.errorExits,
      ]) {
        for (const id of portClass) {
          expect(ids.has(id)).toBe(true)
        }
      }
    }
  })
})
