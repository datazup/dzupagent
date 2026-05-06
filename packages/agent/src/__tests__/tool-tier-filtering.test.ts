/**
 * Tests for the permission-tier tool filtering pipeline (MC-AGT-05).
 *
 * Validates that:
 *   - Agents only expose tools whose `requiredTier` is satisfied by the
 *     agent's effective {@link PermissionTier}.
 *   - The `agent:tools-filtered` event is emitted at construction with the
 *     correct allowed/filtered counts.
 *   - The default tier (when `permissionTier` is omitted) is `'read-only'`.
 *   - The `WeakMap`-backed registry never mutates the underlying tool
 *     instance, so the same tool may be tagged differently for different
 *     test scenarios without leaking state across them.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { createForgeTool } from '@dzupagent/core'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'
import {
  setToolTier,
  filterToolsByTier,
  getToolTier,
  DEFAULT_TOOL_TIER,
} from '../tools/tool-tier-registry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModel(): BaseChatModel {
  const model: Record<string, unknown> = {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => new AIMessage('done')),
    bindTools: vi.fn().mockReturnThis(),
    stream: vi.fn(async function* (_msgs: BaseMessage[]) {
      yield new AIMessage('done')
    }),
  }
  return model as unknown as BaseChatModel
}

function makeTool(name: string): StructuredToolInterface {
  return createForgeTool({
    id: name,
    description: `Test tool ${name}`,
    inputSchema: z.object({ value: z.string() }),
    execute: async ({ value }) => `echo:${value}`,
  })
}

interface EventBusStub {
  emit: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  events: unknown[]
}

function createEventBusStub(): EventBusStub {
  const events: unknown[] = []
  return {
    emit: vi.fn((event: unknown) => {
      events.push(event)
    }),
    on: vi.fn(),
    off: vi.fn(),
    events,
  }
}

function minimalConfig(overrides: Partial<DzupAgentConfig> = {}): DzupAgentConfig {
  return {
    id: 'test-agent',
    instructions: 'You are a test agent.',
    model: createMockModel(),
    ...overrides,
  }
}

/**
 * Reach into the private `getTools()` accessor so tests can assert on the
 * exact tool list bound to the model. Casting through `unknown` keeps the
 * public surface intact.
 */
function readBoundTools(agent: DzupAgent): StructuredToolInterface[] {
  return (agent as unknown as {
    getTools: () => StructuredToolInterface[]
  }).getTools()
}

// ---------------------------------------------------------------------------
// Pure registry behaviour
// ---------------------------------------------------------------------------

describe('tool-tier-registry', () => {
  it('defaults untagged tools to read-only', () => {
    const tool = makeTool('untagged')
    expect(getToolTier(tool)).toBe(DEFAULT_TOOL_TIER)
    expect(DEFAULT_TOOL_TIER).toBe('read-only')
  })

  it('records the tagged tier without mutating the tool', () => {
    const tool = makeTool('writer')
    setToolTier(tool, 'workspace-write')
    expect(getToolTier(tool)).toBe('workspace-write')
    // The tool should not gain any new own-property for the tier.
    expect(Object.prototype.hasOwnProperty.call(tool, 'requiredTier')).toBe(false)
  })

  it('filterToolsByTier keeps only tools whose tier is satisfied', () => {
    const reader = makeTool('reader')
    const writer = makeTool('writer')
    const sudo = makeTool('sudo')
    setToolTier(writer, 'workspace-write')
    setToolTier(sudo, 'full-access')

    expect(filterToolsByTier([reader, writer, sudo], 'read-only')).toEqual([reader])
    expect(filterToolsByTier([reader, writer, sudo], 'workspace-write')).toEqual([
      reader,
      writer,
    ])
    expect(filterToolsByTier([reader, writer, sudo], 'full-access')).toEqual([
      reader,
      writer,
      sudo,
    ])
  })
})

// ---------------------------------------------------------------------------
// DzupAgent integration
// ---------------------------------------------------------------------------

describe('DzupAgent permission-tier filtering', () => {
  it('agent on read-only tier only sees read-only tools', () => {
    const reader = makeTool('reader-1')
    const writer = makeTool('writer-1')
    const sudo = makeTool('sudo-1')
    setToolTier(writer, 'workspace-write')
    setToolTier(sudo, 'full-access')

    const agent = new DzupAgent(minimalConfig({
      tools: [reader, writer, sudo],
      permissionTier: 'read-only',
    }))

    const bound = readBoundTools(agent)
    expect(bound.map((tool) => tool.name)).toEqual(['reader-1'])
  })

  it('agent on workspace-write tier sees read-only and workspace-write tools', () => {
    const reader = makeTool('reader-2')
    const writer = makeTool('writer-2')
    const sudo = makeTool('sudo-2')
    setToolTier(writer, 'workspace-write')
    setToolTier(sudo, 'full-access')

    const agent = new DzupAgent(minimalConfig({
      tools: [reader, writer, sudo],
      permissionTier: 'workspace-write',
    }))

    const bound = readBoundTools(agent)
    expect(bound.map((tool) => tool.name).sort()).toEqual(['reader-2', 'writer-2'])
  })

  it('agent on full-access tier sees all tools', () => {
    const reader = makeTool('reader-3')
    const writer = makeTool('writer-3')
    const sudo = makeTool('sudo-3')
    setToolTier(writer, 'workspace-write')
    setToolTier(sudo, 'full-access')

    const agent = new DzupAgent(minimalConfig({
      tools: [reader, writer, sudo],
      permissionTier: 'full-access',
    }))

    const bound = readBoundTools(agent)
    expect(bound.map((tool) => tool.name).sort()).toEqual([
      'reader-3',
      'sudo-3',
      'writer-3',
    ])
  })

  it('default permissionTier is read-only', () => {
    const reader = makeTool('reader-4')
    const writer = makeTool('writer-4')
    setToolTier(writer, 'workspace-write')

    const agent = new DzupAgent(minimalConfig({
      tools: [reader, writer],
      // no permissionTier — must default to read-only
    }))

    const bound = readBoundTools(agent)
    expect(bound.map((tool) => tool.name)).toEqual(['reader-4'])
  })

  it('emits agent:tools-filtered event at construction with filtered names', () => {
    const reader = makeTool('reader-5')
    const writer = makeTool('writer-5')
    const sudo = makeTool('sudo-5')
    setToolTier(writer, 'workspace-write')
    setToolTier(sudo, 'full-access')

    const eventBus = createEventBusStub()

    new DzupAgent(minimalConfig({
      id: 'audited-agent',
      tools: [reader, writer, sudo],
      permissionTier: 'read-only',
      eventBus: eventBus as never,
    }))

    const filteredEvent = eventBus.events.find(
      (event) => (event as { type?: string }).type === 'agent:tools-filtered',
    ) as
      | {
          type: 'agent:tools-filtered'
          agentId: string
          effectiveTier: string
          totalTools: number
          allowedTools: number
          filteredTools: string[]
        }
      | undefined

    expect(filteredEvent).toBeDefined()
    expect(filteredEvent!.agentId).toBe('audited-agent')
    expect(filteredEvent!.effectiveTier).toBe('read-only')
    expect(filteredEvent!.totalTools).toBe(3)
    expect(filteredEvent!.allowedTools).toBe(1)
    expect(filteredEvent!.filteredTools.sort()).toEqual(['sudo-5', 'writer-5'])
  })

  it('emits an empty filteredTools list when nothing is filtered', () => {
    const reader = makeTool('reader-6')
    const eventBus = createEventBusStub()

    new DzupAgent(minimalConfig({
      tools: [reader],
      permissionTier: 'full-access',
      eventBus: eventBus as never,
    }))

    const filteredEvent = eventBus.events.find(
      (event) => (event as { type?: string }).type === 'agent:tools-filtered',
    ) as { allowedTools: number; filteredTools: string[] } | undefined

    expect(filteredEvent).toBeDefined()
    expect(filteredEvent!.allowedTools).toBe(1)
    expect(filteredEvent!.filteredTools).toEqual([])
  })

  it('filters and audits middleware-provided tools from the resolved tool list', () => {
    const reader = makeTool('reader-7')
    const middlewareTool = makeTool('middleware-sudo-7')
    setToolTier(middlewareTool, 'full-access')

    const eventBus = createEventBusStub()
    const agent = new DzupAgent(minimalConfig({
      tools: [reader],
      middleware: [{ name: 'tiered-middleware', tools: [middlewareTool] }],
      permissionTier: 'read-only',
      eventBus: eventBus as never,
    }))

    expect(readBoundTools(agent).map((tool) => tool.name)).toEqual(['reader-7'])

    const filteredEvent = eventBus.events.find(
      (event) => (event as { type?: string }).type === 'agent:tools-filtered',
    ) as { totalTools: number; allowedTools: number; filteredTools: string[] } | undefined

    expect(filteredEvent).toBeDefined()
    expect(filteredEvent!.totalTools).toBe(2)
    expect(filteredEvent!.allowedTools).toBe(1)
    expect(filteredEvent!.filteredTools).toEqual(['middleware-sudo-7'])
  })
})
