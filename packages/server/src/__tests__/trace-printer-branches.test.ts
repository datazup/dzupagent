/**
 * Branch coverage tests for TracePrinter.formatEvent().
 *
 * Exercises every branch of extractDetails() for all DzupEvent types,
 * plus verbose-mode serialization, attach/detach, idempotent detach.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createEventBus, type DzupEvent } from '@dzupagent/core'
import { TracePrinter } from '../cli/trace-printer.js'

function format(ev: DzupEvent, verbose = false): string {
  const printer = new TracePrinter(verbose)
  return printer.formatEvent(ev)
}

describe('TracePrinter.formatEvent branch coverage', () => {
  it('formats agent:started', () => {
    const line = format({ type: 'agent:started', agentId: 'a1', runId: 'run-12345678' })
    expect(line).toContain('agent:started')
    expect(line).toContain('agent=a1')
    expect(line).toContain('[run-1234')
  })

  it('formats agent:completed with durationMs', () => {
    const line = format({
      type: 'agent:completed',
      agentId: 'a1',
      runId: 'r1',
      output: 'done',
      durationMs: 500,
    } as DzupEvent)
    expect(line).toContain('duration=500ms')
  })

  it('formats agent:failed with errorCode and message', () => {
    const line = format({
      type: 'agent:failed',
      agentId: 'a1',
      runId: 'r1',
      errorCode: 'TIMEOUT',
      message: 'boom',
    })
    expect(line).toContain('error=TIMEOUT: boom')
  })

  it('formats tool:called', () => {
    const line = format({ type: 'tool:called', toolName: 'search', input: {} })
    expect(line).toContain('tool=search')
  })

  it('formats tool:result with durationMs', () => {
    const line = format({
      type: 'tool:result',
      toolName: 'search',
      result: { x: 1 },
      durationMs: 40,
    } as DzupEvent)
    expect(line).toContain('tool=search')
    expect(line).toContain('duration=40ms')
  })

  it('formats tool:error', () => {
    const line = format({
      type: 'tool:error',
      toolName: 'search',
      errorCode: 'TOOL_INPUT_INVALID',
      message: 'bad',
    } as DzupEvent)
    expect(line).toContain('error=TOOL_INPUT_INVALID: bad')
  })

  it('formats memory:written', () => {
    const line = format({
      type: 'memory:written',
      namespace: 'ns1',
      key: 'k1',
    } as DzupEvent)
    expect(line).toContain('ns=ns1')
    expect(line).toContain('key=k1')
  })

  it('formats memory:searched', () => {
    const line = format({
      type: 'memory:searched',
      namespace: 'ns1',
      query: 'find me',
      resultCount: 3,
    } as DzupEvent)
    expect(line).toContain('ns=ns1')
    expect(line).toContain('query="find me"')
    expect(line).toContain('results=3')
  })

  it('formats memory:error', () => {
    const line = format({
      type: 'memory:error',
      namespace: 'ns1',
      message: 'fail',
    } as DzupEvent)
    expect(line).toContain('ns=ns1')
    expect(line).toContain('fail')
  })

  it('formats budget:warning', () => {
    const line = format({
      type: 'budget:warning',
      level: 'warn',
      usage: { percent: 80 },
    } as DzupEvent)
    expect(line).toContain('level=warn')
    expect(line).toContain('80%')
  })

  it('formats budget:exceeded', () => {
    const line = format({
      type: 'budget:exceeded',
      reason: 'token_cap',
    } as DzupEvent)
    expect(line).toContain('token_cap')
  })

  it('formats pipeline:phase_changed', () => {
    const line = format({
      type: 'pipeline:phase_changed',
      previousPhase: 'init',
      phase: 'exec',
    } as DzupEvent)
    expect(line).toContain('init -> exec')
  })

  it('formats pipeline:validation_failed', () => {
    const line = format({
      type: 'pipeline:validation_failed',
      phase: 'exec',
      errors: ['e1', 'e2'],
    } as DzupEvent)
    expect(line).toContain('phase=exec')
    expect(line).toContain('errors=2')
  })

  it('formats approval:requested', () => {
    const line = format({ type: 'approval:requested', runId: 'r1', agentId: 'a1' } as DzupEvent)
    expect(line).toContain('runId=r1')
  })

  it('formats approval:granted with approvedBy', () => {
    const line = format({
      type: 'approval:granted',
      runId: 'r1',
      approvedBy: 'alice',
    } as DzupEvent)
    expect(line).toContain('by=alice')
  })

  it('formats approval:granted without approvedBy', () => {
    const line = format({ type: 'approval:granted', runId: 'r1' } as DzupEvent)
    expect(line).toContain('runId=r1')
    expect(line).not.toContain('by=')
  })

  it('formats approval:rejected with reason', () => {
    const line = format({
      type: 'approval:rejected',
      runId: 'r1',
      reason: 'too risky',
    } as DzupEvent)
    expect(line).toContain('reason="too risky"')
  })

  it('formats approval:rejected without reason', () => {
    const line = format({ type: 'approval:rejected', runId: 'r1' } as DzupEvent)
    expect(line).toContain('runId=r1')
    expect(line).not.toContain('reason=')
  })

  it('formats mcp:connected', () => {
    const line = format({
      type: 'mcp:connected',
      serverName: 's1',
      toolCount: 7,
    } as DzupEvent)
    expect(line).toContain('server=s1')
    expect(line).toContain('tools=7')
  })

  it('formats mcp:disconnected', () => {
    const line = format({ type: 'mcp:disconnected', serverName: 's1' } as DzupEvent)
    expect(line).toContain('server=s1')
  })

  it('formats provider:failed', () => {
    const line = format({
      type: 'provider:failed',
      provider: 'openai',
      message: 'x',
    } as DzupEvent)
    expect(line).toContain('provider=openai')
  })

  it('formats provider:circuit_opened and provider:circuit_closed', () => {
    const a = format({ type: 'provider:circuit_opened', provider: 'openai' } as DzupEvent)
    const b = format({ type: 'provider:circuit_closed', provider: 'openai' } as DzupEvent)
    expect(a).toContain('provider=openai')
    expect(b).toContain('provider=openai')
  })

  it('unknown event type produces no details suffix', () => {
    const line = format({ type: 'something:else' } as unknown as DzupEvent)
    expect(line).toContain('something:else')
    expect(line).not.toContain(' -- ')
  })

  it('renders [--------] when runId is missing', () => {
    const line = format({ type: 'tool:called', toolName: 'x', input: {} })
    expect(line).toContain('[--------]')
  })

  it('verbose mode appends JSON body', () => {
    const line = format({ type: 'agent:started', agentId: 'a1', runId: 'r1' }, true)
    expect(line).toContain('"agentId": "a1"')
    expect(line).toMatch(/\n\s+"type":/)
  })
})

describe('TracePrinter lifecycle', () => {
  afterEach(() => vi.restoreAllMocks())

  it('attach subscribes to the bus and detach stops it', () => {
    const bus = createEventBus()
    const printer = new TracePrinter()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    printer.attach(bus)
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    expect(logSpy).toHaveBeenCalledTimes(1)

    printer.detach()
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2' })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('double attach replaces prior subscription', () => {
    const bus = createEventBus()
    const printer = new TracePrinter()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    printer.attach(bus)
    printer.attach(bus)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    expect(logSpy).toHaveBeenCalledTimes(1)
    printer.detach()
  })

  it('detach without attach is a no-op', () => {
    const printer = new TracePrinter()
    expect(() => printer.detach()).not.toThrow()
  })
})
