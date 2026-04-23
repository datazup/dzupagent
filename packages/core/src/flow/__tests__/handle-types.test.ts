import { describe, it, expect } from 'vitest'
import type {
  SkillHandle,
  McpToolHandle,
  WorkflowHandle,
  ResolvedAgentHandle,
  FlowHandle,
  SkillExecutionContext,
  AgentInvocation,
  AgentInvocationResult,
  McpInvocationResult,
} from '../handle-types.js'

/**
 * Wave 11 §5 — handle type construction smoke tests.
 *
 * These tests verify the types compile and the structural shapes match
 * the ADR. Narrowing via the `kind` discriminator is exercised so the
 * discriminated union behaves correctly.
 */
describe('flow handle types', () => {
  it('constructs a SkillHandle with all required fields', async () => {
    const handle: SkillHandle = {
      kind: 'skill',
      id: 'core/echo',
      displayName: 'Echo',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      execute: async (input, _ctx: SkillExecutionContext) => input,
    }

    expect(handle.kind).toBe('skill')
    expect(handle.id).toBe('core/echo')
    expect(await handle.execute('hi', { runId: 'r1' })).toBe('hi')
  })

  it('constructs an McpToolHandle and invokes it', async () => {
    const mockResult: McpInvocationResult = {
      content: [{ type: 'text', value: 'ok' }],
      isError: false,
    }
    const handle: McpToolHandle = {
      kind: 'mcp-tool',
      id: 'fs/read_file',
      serverId: 'fs',
      toolName: 'read_file',
      inputSchema: { type: 'object' },
      invoke: async () => mockResult,
    }

    const result = await handle.invoke({ path: '/tmp/x' })
    expect(result.isError).toBe(false)
    expect(result.content[0]?.type).toBe('text')
  })

  it('constructs a WorkflowHandle', () => {
    const handle: WorkflowHandle = {
      kind: 'workflow',
      id: 'wf-001',
      version: 3,
      definitionRef: 'pipeline://wf-001@3',
      inputSchema: { type: 'object' },
    }

    expect(handle.kind).toBe('workflow')
    expect(handle.version).toBe(3)
  })

  it('constructs a ResolvedAgentHandle and invokes it', async () => {
    const invocation: AgentInvocation = { prompt: 'hello', parentRunId: 'parent-1' }
    const mockResult: AgentInvocationResult = {
      output: 'hi',
      runId: 'child-1',
      durationMs: 42,
    }
    const handle: ResolvedAgentHandle = {
      kind: 'agent',
      id: 'agent-1',
      displayName: 'Echo Agent',
      invoke: async (inv) => {
        expect(inv.prompt).toBe('hello')
        return mockResult
      },
    }

    const result = await handle.invoke(invocation)
    expect(result.runId).toBe('child-1')
    expect(result.durationMs).toBe(42)
  })

  it('narrows FlowHandle via the kind discriminator', () => {
    const handles: FlowHandle[] = [
      {
        kind: 'skill',
        id: 's',
        displayName: 'S',
        inputSchema: {},
        execute: async () => null,
      },
      {
        kind: 'mcp-tool',
        id: 'm',
        serverId: 'srv',
        toolName: 't',
        inputSchema: {},
        invoke: async () => ({ content: [], isError: false }),
      },
      {
        kind: 'workflow',
        id: 'w',
        version: 1,
        definitionRef: 'ref',
        inputSchema: {},
      },
      {
        kind: 'agent',
        id: 'a',
        displayName: 'A',
        invoke: async () => ({ output: null, runId: 'r', durationMs: 0 }),
      },
    ]

    const kinds = handles.map((h) => {
      // Type-level narrowing: each branch should access kind-specific fields
      // without a cast.
      switch (h.kind) {
        case 'skill':
          return h.displayName
        case 'mcp-tool':
          return h.serverId
        case 'workflow':
          return String(h.version)
        case 'agent':
          return h.displayName
      }
    })

    expect(kinds).toEqual(['S', 'srv', '1', 'A'])
  })
})
