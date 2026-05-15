import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SSEProjectionRouter, withProjection } from '../sse-projections.js'
import type { SSEWriter } from '../sse-handler.js'

function makeWriter(): { writer: SSEWriter; events: Array<{ type: string; data: unknown }> } {
  const events: Array<{ type: string; data: unknown }> = []
  const writer = {
    write: vi.fn((e: { type: string; data: unknown }) => { events.push(e) }),
    writeChunk: vi.fn(),
    writeDone: vi.fn(),
    writeError: vi.fn(),
    end: vi.fn(),
    isConnected: vi.fn(() => true),
  } as unknown as SSEWriter
  return { writer, events }
}

describe('SSEProjectionRouter', () => {
  let events: Array<{ type: string; data: unknown }>
  let router: SSEProjectionRouter

  beforeEach(() => {
    const m = makeWriter()
    events = m.events
    router = new SSEProjectionRouter(m.writer, 'raw')
  })

  it('raw mode: forwards events unchanged', () => {
    router.push({ type: 'text', data: { content: 'hello' } })
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('text')
  })

  it('raw mode: no extra projection events', () => {
    router.push({ type: 'tool_call', data: { name: 'read_file', args: {} } })
    expect(events).toHaveLength(1)
  })

  it('tools namespace: emits tool_invocation alongside raw event', () => {
    router.setNamespace('tools')
    router.push(
      { type: 'tool_call', data: { name: 'bash', args: { cmd: 'ls' } } },
      { agentId: 'a1', agentRole: 'coder' },
    )
    const invocations = events.filter(e => e.type === 'tool_invocation')
    expect(invocations).toHaveLength(1)
    const inv = invocations[0]!.data as { toolName: string; agentId: string }
    expect(inv.toolName).toBe('bash')
    expect(inv.agentId).toBe('a1')
  })

  it('tools namespace: emits tool_result_projection for tool_result', () => {
    router.setNamespace('tools')
    router.push(
      { type: 'tool_result', data: { name: 'bash', result: 'ok' } },
      { agentId: 'a1' },
    )
    const results = events.filter(e => e.type === 'tool_result_projection')
    expect(results).toHaveLength(1)
  })

  it('subagent namespace: emits agent_text for text events with agentId', () => {
    router.setNamespace('subagent')
    router.push(
      { type: 'text', data: { content: 'working...' } },
      { agentId: 'sub-1', agentRole: 'reviewer' },
    )
    const agentTexts = events.filter(e => e.type === 'agent_text')
    expect(agentTexts).toHaveLength(1)
    const at = agentTexts[0]!.data as { agentId: string; content: string }
    expect(at.agentId).toBe('sub-1')
    expect(at.content).toBe('working...')
  })

  it('subagent namespace: skips events without agentId', () => {
    router.setNamespace('subagent')
    router.push({ type: 'text', data: { content: 'no agent' } })
    // raw event still forwarded, but no agent_text projection
    const agentTexts = events.filter(e => e.type === 'agent_text')
    expect(agentTexts).toHaveLength(0)
  })

  it('coordinator namespace: only emits agent events for coordinator agentId', () => {
    router.setNamespace('coordinator')
    router.push({ type: 'text', data: { content: 'coord' } }, { agentId: 'coordinator' })
    router.push({ type: 'text', data: { content: 'sub' } }, { agentId: 'sub-1' })
    const agentTexts = events.filter(e => e.type === 'agent_text')
    expect(agentTexts).toHaveLength(1)
  })

  it('pushSubagentLifecycle emits lifecycle event', () => {
    router.pushSubagentLifecycle({ type: 'subagent_started', agentId: 'sub-1', ts: Date.now() })
    const lifecycle = events.filter(e => e.type === 'subagent_started')
    expect(lifecycle).toHaveLength(1)
  })

  it('withProjection factory returns configured router', () => {
    const { writer } = makeWriter()
    const r = withProjection(writer, 'tools')
    expect(r.getNamespace()).toBe('tools')
  })
})
