import { describe, it, expect } from 'vitest'
import {
  createEventBus,
  EventLogSink,
  InMemoryEventLog,
  InMemoryRunStore,
} from '../index.js'

describe('core integration', () => {
  it('wires the event bus, event log sink, and run store through a single run lifecycle', async () => {
    const bus = createEventBus()
    const eventLog = new InMemoryEventLog()
    const sink = new EventLogSink(eventLog)
    const runStore = new InMemoryRunStore({ maxRuns: 2, maxLogsPerRun: 3 })

    const run = await runStore.create({
      agentId: 'agent-1',
      input: { prompt: 'summarize the design doc' },
      metadata: { source: 'integration-test' },
    })

    const unsubscribe = sink.attach(bus, run.id)

    bus.emit({
      type: 'agent:started',
      agentId: run.agentId,
      runId: run.id,
    })

    await runStore.addLog(run.id, {
      level: 'info',
      phase: 'planning',
      message: 'Run started',
    })

    bus.emit({
      type: 'tool:called',
      toolName: 'search',
      input: { query: 'design doc' },
    })

    bus.emit({
      type: 'tool:result',
      toolName: 'search',
      durationMs: 17,
    })

    await runStore.update(run.id, {
      status: 'completed',
      output: { answer: 'done' },
      completedAt: new Date('2026-04-01T00:00:00Z'),
    })

    bus.emit({
      type: 'agent:completed',
      agentId: run.agentId,
      runId: run.id,
      durationMs: 17,
    })

    unsubscribe()

    const events = await eventLog.getEvents(run.id)
    expect(events).toHaveLength(4)
    expect(events.map((entry) => entry.type)).toEqual([
      'agent:started',
      'tool:called',
      'tool:result',
      'agent:completed',
    ])
    expect(events[1]!.payload).toEqual({
      toolName: 'search',
      input: { query: 'design doc' },
    })

    const storedRun = await runStore.get(run.id)
    expect(storedRun).not.toBeNull()
    expect(storedRun!.status).toBe('completed')
    expect(storedRun!.output).toEqual({ answer: 'done' })
    expect(storedRun!.completedAt).toEqual(new Date('2026-04-01T00:00:00Z'))

    const runLogs = await runStore.getLogs(run.id)
    expect(runLogs).toHaveLength(1)
    expect(runLogs[0]!.phase).toBe('planning')
    expect(runLogs[0]!.message).toBe('Run started')
  })
})
