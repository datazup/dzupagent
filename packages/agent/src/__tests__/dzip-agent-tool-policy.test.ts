/**
 * MJ-AGENT-01 — Tool execution policy is enforceable from the public
 * `DzupAgent` config surface.
 *
 * The audit found that the reusable {@link runToolLoop} already supports
 * governance, safety scanning, per-tool timeouts, argument validation,
 * tracing, and permission policy, BUT the top-level `DzupAgent.generate()`
 * path did not expose or thread most of those controls. This suite pins
 * the new behaviour:
 *
 * - `toolExecution.governance` blocks denied tools and triggers an
 *   `approval_pending` halt for approval-required tools.
 * - `toolExecution.permissionPolicy` rejects unauthorised tool calls with
 *   a `TOOL_PERMISSION_DENIED` ForgeError.
 * - `toolExecution.timeouts` enforces per-tool deadlines.
 * - `toolExecution.argumentValidator` validates arguments against the
 *   tool schema.
 * - Existing callers without a `toolExecution` block see ZERO behaviour
 *   change (backwards compatibility).
 *
 * Run only this suite locally with:
 *   yarn workspace @dzupagent/agent test --run "tool policy generate"
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { createEventBus, ToolGovernance } from '@dzupagent/core'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModel(responses: AIMessage[]): BaseChatModel {
  let invokeIdx = 0
  const model: Record<string, unknown> = {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const resp = responses[invokeIdx] ?? responses.at(-1) ?? new AIMessage('done')
      invokeIdx++
      return resp
    }),
    bindTools: vi.fn().mockReturnThis(),
  }
  return model as unknown as BaseChatModel
}

function mockTool(
  name: string,
  invoke?: (args: Record<string, unknown>) => Promise<string> | string,
): { tool: StructuredToolInterface; invokeFn: ReturnType<typeof vi.fn> } {
  const invokeFn = vi.fn(
    invoke
      ? async (args: Record<string, unknown>) => invoke(args)
      : async () => 'ok',
  )
  return {
    tool: {
      name,
      description: `Mock tool ${name}`,
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: invokeFn,
    } as unknown as StructuredToolInterface,
    invokeFn,
  }
}

function aiWithToolCall(
  name: string,
  args: Record<string, unknown> = {},
  id = 'tc_1',
): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ id, name, args }],
  })
}

function baseConfig(overrides: Partial<DzupAgentConfig> = {}): DzupAgentConfig {
  return {
    id: 'policy-agent',
    instructions: 'You are a test agent.',
    model: createMockModel([new AIMessage('hello')]),
    ...overrides,
  }
}

// ===========================================================================
// tool policy generate — MJ-AGENT-01
// ===========================================================================

describe('DzupAgent generate() — tool policy generate (MJ-AGENT-01)', () => {
  describe('toolExecution.governance — blocked tools', () => {
    it('denies a blocked tool without invoking it', async () => {
      const { tool, invokeFn } = mockTool('deploy', () => 'deployed!')
      const model = createMockModel([
        aiWithToolCall('deploy', { env: 'prod' }),
        new AIMessage('handled'),
      ])

      const governance = new ToolGovernance({
        blockedTools: ['deploy'],
      })

      const agent = new DzupAgent(
        baseConfig({
          model,
          tools: [tool],
          toolExecution: { governance },
        }),
      )

      const result = await agent.generate([new HumanMessage('please deploy')])

      // Tool was NEVER invoked — the governance gate denied it.
      expect(invokeFn).not.toHaveBeenCalled()

      // The transcript surfaces a [blocked] tool message so the model
      // sees why the call did not run.
      const blockedMsg = result.messages.find(
        (m) =>
          m._getType() === 'tool' &&
          typeof m.content === 'string' &&
          m.content.startsWith('[blocked]'),
      )
      expect(blockedMsg).toBeDefined()
    })
  })

  describe('toolExecution.governance — approval-required tools', () => {
    it('halts the run with approval_pending and emits approval:requested', async () => {
      const { tool, invokeFn } = mockTool('migrate_db', () => 'migrated!')
      const model = createMockModel([
        aiWithToolCall('migrate_db', { dryRun: false }, 'tc_mig'),
        new AIMessage('should-not-be-reached'),
      ])

      const bus = createEventBus()
      const events: unknown[] = []
      bus.on('approval:requested', (e) => events.push(e))

      const governance = new ToolGovernance({
        approvalRequired: ['migrate_db'],
      })

      const agent = new DzupAgent(
        baseConfig({
          model,
          tools: [tool],
          eventBus: bus,
          toolExecution: {
            governance,
            // Provide a durable runId so the approval event carries the
            // correlation id consumers expect (instead of falling back to
            // the local tool_call_id).
            runId: 'durable-run-123',
          },
        }),
      )

      const result = await agent.generate([new HumanMessage('migrate it')])

      expect(invokeFn).not.toHaveBeenCalled()
      expect(result.stopReason).toBe('approval_pending')

      // Exactly one approval:requested event with the durable runId.
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'approval:requested',
        runId: 'durable-run-123',
        plan: { toolName: 'migrate_db', args: { dryRun: false } },
      })
    })
  })

  describe('toolExecution.permissionPolicy — denied tools', () => {
    it('rejects a tool the calling agent is not permitted to invoke', async () => {
      const { tool, invokeFn } = mockTool('writeFile', () => 'wrote it')
      const model = createMockModel([aiWithToolCall('writeFile', {})])

      // Strict policy: agent-a has access to nothing.
      const policy: ToolPermissionPolicy = {
        hasPermission: (callerAgentId, toolName) =>
          callerAgentId === 'agent-a' && toolName === 'writeFile' ? false : false,
      }

      const agent = new DzupAgent(
        baseConfig({
          id: 'agent-a',
          model,
          tools: [tool],
          toolExecution: {
            permissionPolicy: policy,
          },
        }),
      )

      // Denied tool calls surface as a TOOL_PERMISSION_DENIED ForgeError
      // (the equivalent of an HTTP 403 in our error taxonomy).
      await expect(
        agent.generate([new HumanMessage('write file')]),
      ).rejects.toMatchObject({
        code: 'TOOL_PERMISSION_DENIED',
        context: { agentId: 'agent-a', toolName: 'writeFile' },
      })

      expect(invokeFn).not.toHaveBeenCalled()
    })

    it('allows tools the policy permits', async () => {
      const { tool, invokeFn } = mockTool('readFile', () => 'contents')
      const model = createMockModel([
        aiWithToolCall('readFile', { path: 'a.ts' }),
        new AIMessage('done'),
      ])

      const policy: ToolPermissionPolicy = {
        hasPermission: (_callerAgentId, toolName) => toolName === 'readFile',
      }

      const agent = new DzupAgent(
        baseConfig({
          id: 'agent-a',
          model,
          tools: [tool],
          toolExecution: { permissionPolicy: policy },
        }),
      )

      const result = await agent.generate([new HumanMessage('read it')])

      expect(invokeFn).toHaveBeenCalledTimes(1)
      expect(result.stopReason).toBe('complete')
    })
  })

  describe('toolExecution.timeouts — per-tool deadlines', () => {
    it('surfaces a tool error when the per-tool timeout fires', async () => {
      // The tool intentionally hangs longer than the configured timeout,
      // so the loop must race the invocation against the timer and
      // surface a "timed out after Nms" error in the transcript.
      const { tool, invokeFn } = mockTool('slowTool', () =>
        new Promise<string>((resolve) => setTimeout(() => resolve('done'), 1000)),
      )

      const model = createMockModel([
        aiWithToolCall('slowTool', {}, 'tc_slow'),
        new AIMessage('handled the timeout'),
      ])

      const agent = new DzupAgent(
        baseConfig({
          model,
          tools: [tool],
          toolExecution: {
            // Aggressive timeout — guaranteed to expire before the tool
            // resolves on any reasonable CI machine.
            timeouts: { slowTool: 5 },
          },
        }),
      )

      const result = await agent.generate([new HumanMessage('go')])

      // The invocation was attempted — the timer raced the underlying call.
      expect(invokeFn).toHaveBeenCalledTimes(1)

      // The transcript carries the timeout error message rather than
      // a successful tool result.
      const errorMsg = result.messages.find(
        (m) =>
          m._getType() === 'tool' &&
          typeof m.content === 'string' &&
          /timed out after \d+ms/.test(m.content),
      )
      expect(errorMsg).toBeDefined()
    })
  })

  describe('toolExecution.argumentValidator — argument schema enforcement', () => {
    it('blocks tool calls whose args fail validation', async () => {
      // The tool advertises a JSON schema requiring a `path` property.
      const validatedTool: StructuredToolInterface = {
        name: 'readFile',
        description: 'Read a file',
        // Inline JSON schema so the validator can see required fields
        // without going through Zod.
        schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        } as never,
        lc_namespace: [] as string[],
        invoke: vi.fn(async () => 'contents'),
      } as unknown as StructuredToolInterface

      // The model emits a tool call missing the required `path` arg.
      const model = createMockModel([
        aiWithToolCall('readFile', { /* path missing */ }, 'tc_v'),
        new AIMessage('aborted'),
      ])

      const agent = new DzupAgent(
        baseConfig({
          model,
          tools: [validatedTool],
          toolExecution: {
            // `false` = no auto-repair; validation errors surface directly.
            argumentValidator: { autoRepair: false },
          },
        }),
      )

      const result = await agent.generate([new HumanMessage('read')])

      // The underlying tool was NOT invoked because validation failed.
      expect(validatedTool.invoke).not.toHaveBeenCalled()

      // The transcript has a tool message describing the validation error.
      const validationMsg = result.messages.find(
        (m) =>
          m._getType() === 'tool' &&
          typeof m.content === 'string' &&
          m.content.startsWith('Validation failed for tool "readFile"'),
      )
      expect(validationMsg).toBeDefined()
    })
  })

  describe('Backwards compatibility — no toolExecution config', () => {
    it('runs identically to pre-MJ-AGENT-01 callers when toolExecution is omitted', async () => {
      // Without `toolExecution`:
      //   - no permission checks
      //   - no governance gate
      //   - no per-tool timeout
      //   - no extra eventBus telemetry from the loop layer
      // The legacy invocation path should be byte-for-byte preserved.
      const { tool, invokeFn } = mockTool('readFile', () => 'contents')
      const model = createMockModel([
        aiWithToolCall('readFile', { path: 'a.ts' }),
        new AIMessage('done'),
      ])

      // EventBus is supplied to the agent for `llm:invoked` etc., but
      // because `toolExecution` is omitted, the loop should NOT receive
      // the bus, so canonical `tool:called` / `tool:result` events MUST
      // NOT be emitted (preserving the pre-MJ-AGENT-01 behaviour).
      const bus = createEventBus()
      const toolEvents: unknown[] = []
      bus.on('tool:called', (e) => toolEvents.push(e))
      bus.on('tool:result', (e) => toolEvents.push(e))
      bus.on('approval:requested', (e) => toolEvents.push(e))

      const agent = new DzupAgent(
        baseConfig({
          model,
          tools: [tool],
          eventBus: bus,
          // toolExecution intentionally omitted
        }),
      )

      const result = await agent.generate([new HumanMessage('go')])

      // The tool ran exactly once and the loop completed normally.
      expect(invokeFn).toHaveBeenCalledTimes(1)
      expect(result.stopReason).toBe('complete')

      // No new lifecycle events were emitted by the loop — the public
      // surface is bit-for-bit identical to the legacy behaviour.
      expect(toolEvents).toHaveLength(0)
    })

    it('still allows non-policy tool calls to succeed when toolExecution is set but governance/permission allow them', async () => {
      // This guards against the regression where supplying `toolExecution`
      // with non-policy fields (e.g. only `agentId`) would accidentally
      // enable a default-deny permission policy.
      const { tool, invokeFn } = mockTool('readFile', () => 'contents')
      const model = createMockModel([
        aiWithToolCall('readFile', { path: 'a.ts' }),
        new AIMessage('done'),
      ])

      const agent = new DzupAgent(
        baseConfig({
          model,
          tools: [tool],
          toolExecution: {
            // No governance, no permissionPolicy — tools must still run.
            agentId: 'observability-only',
          },
        }),
      )

      const result = await agent.generate([new HumanMessage('go')])

      expect(invokeFn).toHaveBeenCalledTimes(1)
      expect(result.stopReason).toBe('complete')
    })
  })
})
