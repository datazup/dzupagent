/**
 * Packet 23-A compiler/runtime composition agreement for structured loops.
 *
 * Server is the sanctioned host boundary that already depends on both the
 * public compiler and the canonical runtime. The compiler and runtime gates
 * are deliberately separate: compilation requires an explicit target
 * capability, while execution requires the host to register the reviewed
 * typed-loop predicate bridge.
 */
import { describe, expect, it } from 'vitest'
import {
  FLOW_TYPED_CONDITION_CAPABILITY,
  createFlowCompiler,
  createTypedLoopPredicates,
} from '@dzupagent/flow-compiler'
import {
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  type NodeExecutor,
} from '@dzupagent/agent'
import type {
  PipelineCheckpoint,
  PipelineDefinition,
  PipelineNode,
} from '@dzupagent/core/pipeline'
import { PipelineCheckpointSchema } from '@dzupagent/core/pipeline'

const TOOL_NAMES = ['tasks.prepare', 'tasks.normal', 'tasks.after'] as const
const TARGET_CAPABILITIES = [FLOW_TYPED_CONDITION_CAPABILITY] as const
const REDACTED_TEST_SESSION = 'must-not-survive-in-nested-checkpoint'

const toolResolver = {
  resolve(ref: string) {
    if (!TOOL_NAMES.includes(ref as (typeof TOOL_NAMES)[number])) return null
    return {
      ref,
      kind: 'skill' as const,
      inputSchema: { type: 'object' },
      handle: {
        name: ref,
        description: `test tool ${ref}`,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        permissionLevel: 'read' as const,
        sideEffects: [],
        namespace: 'tasks',
      },
    }
  },
  listAvailable: () => [...TOOL_NAMES],
}

const typedCondition = {
  schema: 'dzupagent.flowTypedCondition/v1',
  expression: { op: 'literal', value: false },
} as const

describe('structured loop terminal compiler/runtime agreement', () => {
  it('executes a compiler-produced terminal loop and suppresses its outer continuation', async () => {
    const definition = await compileLoop([
      {
        type: 'action',
        id: 'prepare',
        toolRef: 'tasks.prepare',
        input: {},
      },
      { type: 'complete', id: 'done', result: 'terminal-result' },
    ])
    const checkpointStore = new InMemoryPipelineCheckpointStore()
    const toolCalls: string[] = []
    const seenIdempotencyKeys: Record<string, string | undefined> = {}

    const result = await runtimeFor({
      definition,
      checkpointStore,
      toolCalls,
      seenIdempotencyKeys,
    }).execute(undefined, { runId: 'compiled-terminal' })

    expect(result.state).toBe('completed')
    expect(toolCalls).toEqual(['tasks.prepare'])
    const loop = findLoop(definition)
    const prepare = findTool(definition, 'tasks.prepare')
    const terminalExitNodeId = loop.bodyGraph?.terminalExitNodeIds[0]
    expect(terminalExitNodeId).toBeDefined()
    expect(loop.bodyGraph?.normalExitNodeIds).toEqual([])
    expect(result.nodeResults.get(loop.id)?.output).toMatchObject({
      loopOutput: 'terminal-result',
      metrics: { terminationReason: 'terminal' },
    })

    const checkpoint = await checkpointStore.load(result.runId)
    expect(PipelineCheckpointSchema.safeParse(checkpoint).success).toBe(true)
    expect(checkpoint).toMatchObject({
      completedNodeIds: [loop.id],
      suspendedAtNodeId: terminalExitNodeId,
      loopState: {
        [loop.id]: {
          bodyGraphState: {
            completed: true,
            outcome: {
              kind: 'terminal',
              exitNodeId: terminalExitNodeId,
            },
          },
        },
      },
    })
    if (checkpoint === undefined) throw new Error('expected terminal checkpoint')
    const bodyState = checkpoint.loopState?.[loop.id]?.bodyGraphState
    expect(bodyState?.nodeResults[prepare.id]).not.toHaveProperty(
      'providerSessionRefs',
    )
    expect(checkpoint.providerSessionRefs).toBeUndefined()
    expect(JSON.stringify(checkpoint)).not.toContain(REDACTED_TEST_SESSION)
    const retainedKey = bodyState?.nodeIdempotencyKeys[prepare.id]
    expect(retainedKey).toMatch(/^dzup:v1:/)
    expect(seenIdempotencyKeys[prepare.id]).toBe(retainedKey)

    const resumedToolCalls: string[] = []
    const resumed = await runtimeFor({
      definition,
      checkpointStore,
      toolCalls: resumedToolCalls,
    }).resume(checkpoint)
    expect(resumed.state).toBe('completed')
    expect(resumedToolCalls).toEqual([])
    const checkpointAfterResume = await checkpointStore.load(result.runId)
    expect(
      checkpointAfterResume?.loopState?.[loop.id]?.bodyGraphState
        ?.nodeIdempotencyKeys[prepare.id],
    ).toBe(retainedKey)
  })

  it.each([
    { chooseTerminal: true, expectedToolCalls: [] },
    {
      chooseTerminal: false,
      expectedToolCalls: ['tasks.normal', 'tasks.after'],
    },
  ])(
    'executes the compiler-selected conditional terminal=$chooseTerminal path',
    async ({ chooseTerminal, expectedToolCalls }) => {
      const definition = await compileLoop([
        {
          type: 'branch',
          id: 'decision',
          condition: 'true',
          then: [
            { type: 'complete', id: 'done', result: 'terminal-result' },
          ],
          else: [
            {
              type: 'action',
              id: 'normal',
              toolRef: 'tasks.normal',
              input: {},
            },
          ],
        },
      ])
      const loop = findLoop(definition)
      expect(loop.bodyGraph?.normalExitNodeIds).not.toEqual([])
      expect(loop.bodyGraph?.terminalExitNodeIds).not.toEqual([])
      expect(
        loop.bodyGraph?.normalExitNodeIds.some((nodeId) =>
          loop.bodyGraph?.terminalExitNodeIds.includes(nodeId),
        ),
      ).toBe(false)

      const toolCalls: string[] = []
      const result = await runtimeFor({
        definition,
        checkpointStore: new InMemoryPipelineCheckpointStore(),
        toolCalls,
        chooseTerminal,
      }).execute()

      expect(result.state).toBe('completed')
      expect(toolCalls).toEqual(expectedToolCalls)
    },
  )

  it.each(['before-save', 'save-then-throw'] as const)(
    'keeps a compiler-produced terminal boundary fail-closed after %s',
    async (failureMode) => {
      const definition = await compileLoop([
        {
          type: 'action',
          id: 'prepare',
          toolRef: 'tasks.prepare',
          input: {},
        },
        { type: 'complete', id: 'done', result: 'terminal-result' },
      ])
      const checkpointStore = new TerminalCheckpointFailureStore(failureMode)
      const toolCalls: string[] = []

      const failed = await runtimeFor({
        definition,
        checkpointStore,
        toolCalls,
      }).execute(undefined, { runId: `compiled-terminal-${failureMode}` })

      expect(failed.state).toBe('failed')
      expect(toolCalls).toEqual(['tasks.prepare'])
      const loop = findLoop(definition)
      const prepare = findTool(definition, 'tasks.prepare')
      const checkpoint = await checkpointStore.load(failed.runId)
      expect(checkpoint).toBeDefined()
      if (checkpoint === undefined) throw new Error('expected retained checkpoint')
      expect(
        checkpoint.loopState?.[loop.id]?.bodyGraphState?.nodeIdempotencyKeys[
          prepare.id
        ],
      ).toMatch(/^dzup:v1:/)
      expect(
        checkpoint.loopState?.[loop.id]?.bodyGraphState?.nodeResults[prepare.id],
      ).not.toHaveProperty('providerSessionRefs')
      expect(JSON.stringify(checkpoint)).not.toContain(REDACTED_TEST_SESSION)
      if (failureMode === 'before-save') {
        expect(
          checkpoint.loopState?.[loop.id]?.bodyGraphState?.outcome,
        ).toBeUndefined()
      } else {
        expect(
          checkpoint.loopState?.[loop.id]?.bodyGraphState?.outcome,
        ).toMatchObject({ kind: 'terminal' })
      }

      const resumedToolCalls: string[] = []
      const resumed = await runtimeFor({
        definition,
        checkpointStore,
        toolCalls: resumedToolCalls,
      }).resume(checkpoint)
      expect(resumed.state).toBe('completed')
      expect(resumedToolCalls).toEqual([])
    },
  )
})

async function compileLoop(body: Array<Record<string, unknown>>) {
  const compiled = await createFlowCompiler({
    toolResolver,
    targetCapabilities: TARGET_CAPABILITIES,
  }).compileDocument({
    dsl: 'dzupflow/v1',
    id: 'structured-terminal-compile-to-run',
    version: 1,
    root: {
      type: 'sequence',
      id: 'root',
      nodes: [
        {
          type: 'loop',
          id: 'retry',
          condition: 'false',
          typedCondition,
          maxIterations: 2,
          body,
        },
        {
          type: 'action',
          id: 'after',
          toolRef: 'tasks.after',
          input: {},
        },
      ],
    },
  })

  expect('errors' in compiled ? JSON.stringify(compiled.errors) : 'ok').toBe(
    'ok',
  )
  if ('errors' in compiled) throw new Error('expected compile success')
  return {
    ...(compiled.artifact as PipelineDefinition),
    checkpointStrategy: 'after_each_node' as const,
  }
}

function runtimeFor(options: {
  definition: PipelineDefinition
  checkpointStore: InMemoryPipelineCheckpointStore
  toolCalls: string[]
  chooseTerminal?: boolean
  seenIdempotencyKeys?: Record<string, string | undefined>
}) {
  const predicates = createTypedLoopPredicates(options.definition.nodes, {
    hostCapabilities: TARGET_CAPABILITIES,
  })
  for (const edge of options.definition.edges) {
    if (edge.type === 'conditional') {
      predicates[edge.predicateName] = () => options.chooseTerminal ?? true
    }
  }

  const nodeExecutor: NodeExecutor = async (nodeId, node, context) => {
    options.seenIdempotencyKeys &&
      (options.seenIdempotencyKeys[nodeId] = context.idempotencyKey)
    if (node.type !== 'tool') {
      return { nodeId, output: nodeId, durationMs: 1 }
    }
    options.toolCalls.push(node.toolName)
    return {
      nodeId,
      output: node.toolName,
      durationMs: 1,
      ...(node.toolName === 'tasks.prepare'
        ? {
            providerSessionRefs: [
              { provider: 'test', sessionId: REDACTED_TEST_SESSION },
            ],
          }
        : {}),
    }
  }

  return new PipelineRuntime({
    definition: options.definition,
    checkpointStore: options.checkpointStore,
    predicates,
    nodeExecutor,
  })
}

function findLoop(definition: PipelineDefinition) {
  const loop = definition.nodes.find((node) => node.type === 'loop')
  if (loop?.type !== 'loop') throw new Error('expected compiled loop')
  return loop
}

function findTool(
  definition: PipelineDefinition,
  toolName: string,
): Extract<PipelineNode, { type: 'tool' }> {
  const tool = definition.nodes.find(
    (node) => node.type === 'tool' && node.toolName === toolName,
  )
  if (tool?.type !== 'tool') throw new Error(`expected tool ${toolName}`)
  return tool
}

class TerminalCheckpointFailureStore extends InMemoryPipelineCheckpointStore {
  private failed = false

  constructor(
    private readonly failureMode: 'before-save' | 'save-then-throw',
  ) {
    super()
  }

  override async save(checkpoint: PipelineCheckpoint): Promise<void> {
    const hasTerminalOutcome = Object.values(checkpoint.loopState ?? {}).some(
      (state) => state.bodyGraphState?.outcome?.kind === 'terminal',
    )
    if (!this.failed && hasTerminalOutcome) {
      this.failed = true
      if (this.failureMode === 'save-then-throw') {
        await super.save(checkpoint)
      }
      throw new Error(`simulated terminal ${this.failureMode}`)
    }
    await super.save(checkpoint)
  }
}
