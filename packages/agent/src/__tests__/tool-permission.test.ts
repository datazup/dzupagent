/**
 * MC-GA03 — Tool permission scoping tests.
 *
 * Covers the three flavours added by this major change:
 * 1. `DynamicToolRegistry` ownership metadata + `getToolsForAgent` /
 *    `getEntry` / `getOwnerId` / `getScope` helpers.
 * 2. `OwnershipPermissionPolicy` allow/deny matrix.
 * 3. `runToolLoop` integration — denied calls surface as
 *    `ForgeError('TOOL_PERMISSION_DENIED')` in both sequential and
 *    parallel execution paths.
 * 4. Anti-laundering: re-registering a `borrowed` tool to a different
 *    owner throws.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { ForgeError } from '@dzupagent/core'
import {
  DynamicToolRegistry,
  OwnershipPermissionPolicy,
} from '../agent/tool-registry.js'
import { runToolLoop } from '../agent/tool-loop.js'

// ---------- Helpers ----------

function mockTool(name: string, result = 'ok') {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => result),
  } as unknown as StructuredToolInterface
}

function mockModel(responses: AIMessage[]): BaseChatModel {
  let i = 0
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      return responses[i++] ?? new AIMessage('done')
    }),
  } as unknown as BaseChatModel
}

function toolCallMessage(toolName: string, id = `tc_${toolName}`): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ id, name: toolName, args: {} }],
  })
}

describe('DynamicToolRegistry — ownership metadata', () => {
  it('treats tools registered without owner as shared', () => {
    const registry = new DynamicToolRegistry()
    const tool = mockTool('sharedTool')
    registry.register(tool)

    const entry = registry.getEntry('sharedTool')
    expect(entry).toEqual({ name: 'sharedTool', scope: 'shared' })
    expect(registry.getOwnerId('sharedTool')).toBeUndefined()
    expect(registry.getScope('sharedTool')).toBe('shared')
  })

  it('defaults to private scope when ownerId is supplied without scope', () => {
    const registry = new DynamicToolRegistry()
    const tool = mockTool('privateTool')
    registry.register(tool, { ownerId: 'agent-a' })

    expect(registry.getEntry('privateTool')).toEqual({
      name: 'privateTool',
      scope: 'private',
      ownerId: 'agent-a',
    })
  })

  it('getToolsForAgent returns shared + owned tools only', () => {
    const registry = new DynamicToolRegistry()
    registry.register(mockTool('s'), { scope: 'shared' })
    registry.register(mockTool('a'), { ownerId: 'agent-a' })
    registry.register(mockTool('b'), { ownerId: 'agent-b' })

    const forA = registry.getToolsForAgent('agent-a').map(t => t.name).sort()
    const forB = registry.getToolsForAgent('agent-b').map(t => t.name).sort()

    expect(forA).toEqual(['a', 's'])
    expect(forB).toEqual(['b', 's'])
  })
})

describe('OwnershipPermissionPolicy', () => {
  it('allows an agent to call its own tool', () => {
    const registry = new DynamicToolRegistry()
    registry.register(mockTool('myTool'), { ownerId: 'agent-a' })
    const policy = new OwnershipPermissionPolicy(registry)

    expect(policy.hasPermission('agent-a', 'myTool')).toBe(true)
  })

  it('denies cross-agent calls to private tools', () => {
    const registry = new DynamicToolRegistry()
    registry.register(mockTool('privB'), { ownerId: 'agent-b' })
    const policy = new OwnershipPermissionPolicy(registry)

    expect(policy.hasPermission('agent-a', 'privB')).toBe(false)
  })

  it('shared tools are callable by any agent', () => {
    const registry = new DynamicToolRegistry()
    registry.register(mockTool('shared'), { scope: 'shared' })
    const policy = new OwnershipPermissionPolicy(registry)

    expect(policy.hasPermission('agent-a', 'shared')).toBe(true)
    expect(policy.hasPermission('agent-b', 'shared')).toBe(true)
    expect(policy.hasPermission('agent-z', 'shared')).toBe(true)
  })

  it('denies unknown tools entirely', () => {
    const registry = new DynamicToolRegistry()
    const policy = new OwnershipPermissionPolicy(registry)

    expect(policy.hasPermission('agent-a', 'does-not-exist')).toBe(false)
  })

  it('borrowed tools are callable only by the borrower', () => {
    const registry = new DynamicToolRegistry()
    registry.register(mockTool('lent'), {
      ownerId: 'manager',
      scope: 'borrowed',
    })
    const policy = new OwnershipPermissionPolicy(registry)

    expect(policy.hasPermission('manager', 'lent')).toBe(true)
    expect(policy.hasPermission('specialist-c', 'lent')).toBe(false)
  })
})

describe('Anti-laundering invariant', () => {
  it('rejects re-delegating a borrowed tool to a different owner', () => {
    const registry = new DynamicToolRegistry()
    const tool = mockTool('lent')
    registry.register(tool, { ownerId: 'manager', scope: 'borrowed' })

    expect(() =>
      registry.register(tool, { ownerId: 'specialist-c', scope: 'borrowed' }),
    ).toThrow(/Cannot re-delegate borrowed tool "lent"/)
  })

  it('allows re-registering a borrowed tool to the same owner', () => {
    const registry = new DynamicToolRegistry()
    const tool = mockTool('lent')
    registry.register(tool, { ownerId: 'manager', scope: 'borrowed' })
    expect(() =>
      registry.register(tool, { ownerId: 'manager', scope: 'borrowed' }),
    ).not.toThrow()
  })
})

describe('runToolLoop — permission enforcement', () => {
  it('allows an agent to invoke its own private tool', async () => {
    const registry = new DynamicToolRegistry()
    const tool = mockTool('writeFile', 'wrote it')
    registry.register(tool, { ownerId: 'agent-a' })
    const policy = new OwnershipPermissionPolicy(registry)

    const model = mockModel([toolCallMessage('writeFile'), new AIMessage('done')])
    const result = await runToolLoop(model, [new HumanMessage('go')], [tool], {
      maxIterations: 3,
      agentId: 'agent-a',
      toolPermissionPolicy: policy,
    })

    expect(result.stopReason).toBe('complete')
    expect(tool.invoke).toHaveBeenCalledTimes(1)
  })

  it('throws TOOL_PERMISSION_DENIED when agent calls another agent\'s private tool', async () => {
    const registry = new DynamicToolRegistry()
    const tool = mockTool('writeFile', 'wrote it')
    registry.register(tool, { ownerId: 'agent-b' })
    const policy = new OwnershipPermissionPolicy(registry)

    const model = mockModel([toolCallMessage('writeFile')])

    await expect(
      runToolLoop(model, [new HumanMessage('go')], [tool], {
        maxIterations: 3,
        agentId: 'agent-a',
        toolPermissionPolicy: policy,
      }),
    ).rejects.toMatchObject({
      code: 'TOOL_PERMISSION_DENIED',
    })

    expect(tool.invoke).not.toHaveBeenCalled()
  })

  it('throws ForgeError instances (not plain Error) for denials', async () => {
    const registry = new DynamicToolRegistry()
    const tool = mockTool('writeFile')
    registry.register(tool, { ownerId: 'agent-b' })
    const policy = new OwnershipPermissionPolicy(registry)

    const model = mockModel([toolCallMessage('writeFile')])

    try {
      await runToolLoop(model, [new HumanMessage('go')], [tool], {
        maxIterations: 3,
        agentId: 'agent-a',
        toolPermissionPolicy: policy,
      })
      throw new Error('expected ForgeError to be thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ForgeError)
      expect((err as ForgeError).code).toBe('TOOL_PERMISSION_DENIED')
      expect((err as ForgeError).context).toMatchObject({
        agentId: 'agent-a',
        toolName: 'writeFile',
      })
    }
  })

  it('permits shared tools from any agent', async () => {
    const registry = new DynamicToolRegistry()
    const tool = mockTool('lookup', 'found')
    registry.register(tool, { scope: 'shared' })
    const policy = new OwnershipPermissionPolicy(registry)

    const model = mockModel([toolCallMessage('lookup'), new AIMessage('done')])

    const result = await runToolLoop(model, [new HumanMessage('go')], [tool], {
      maxIterations: 3,
      agentId: 'some-random-agent',
      toolPermissionPolicy: policy,
    })

    expect(result.stopReason).toBe('complete')
    expect(tool.invoke).toHaveBeenCalledTimes(1)
  })

  it('enforces permissions on the parallel execution path as well', async () => {
    const registry = new DynamicToolRegistry()
    const allowed = mockTool('mine')
    const forbidden = mockTool('theirs')
    registry.register(allowed, { ownerId: 'agent-a' })
    registry.register(forbidden, { ownerId: 'agent-b' })
    const policy = new OwnershipPermissionPolicy(registry)

    // Single AI turn emits TWO tool calls — triggers the parallel path
    const parallelCall = new AIMessage({
      content: '',
      tool_calls: [
        { id: '1', name: 'mine', args: {} },
        { id: '2', name: 'theirs', args: {} },
      ],
    })
    const model = mockModel([parallelCall])

    await expect(
      runToolLoop(
        model,
        [new HumanMessage('go')],
        [allowed, forbidden],
        {
          maxIterations: 3,
          agentId: 'agent-a',
          toolPermissionPolicy: policy,
          parallelTools: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })

    // Neither tool should have executed — permission check runs in the
    // pre-validation loop before the parallel executor fires.
    expect(allowed.invoke).not.toHaveBeenCalled()
    expect(forbidden.invoke).not.toHaveBeenCalled()
  })

  it('is opt-in — undefined policy preserves pre-MC-GA03 behaviour', async () => {
    const registry = new DynamicToolRegistry()
    const tool = mockTool('anyTool', 'ok')
    registry.register(tool, { ownerId: 'agent-b' })

    // Intentionally pass NO toolPermissionPolicy → no check
    const model = mockModel([toolCallMessage('anyTool'), new AIMessage('done')])

    const result = await runToolLoop(model, [new HumanMessage('go')], [tool], {
      maxIterations: 3,
      agentId: 'agent-a',
    })

    expect(result.stopReason).toBe('complete')
    expect(tool.invoke).toHaveBeenCalledTimes(1)
  })
})
