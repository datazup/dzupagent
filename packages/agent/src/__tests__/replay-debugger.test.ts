import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@forgeagent/core'
import type { ForgeEventBus, ForgeEvent } from '@forgeagent/core'
import { TraceCapture } from '../replay/trace-capture.js'
import { ReplayEngine } from '../replay/replay-engine.js'
import { ReplayController } from '../replay/replay-controller.js'
import { ReplayInspector } from '../replay/replay-inspector.js'
import { TraceSerializer } from '../replay/trace-serializer.js'
import type {
  CapturedTrace,
  ReplayEvent,
  Breakpoint,
  ReplaySession,
} from '../replay/replay-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestBus(): ForgeEventBus {
  return createEventBus()
}

function emitSequence(bus: ForgeEventBus, events: ForgeEvent[]): void {
  for (const event of events) {
    bus.emit(event)
  }
}

function makeSampleEvents(): ForgeEvent[] {
  return [
    { type: 'agent:started', agentId: 'test-agent', runId: 'run-1' },
    { type: 'tool:called', toolName: 'read_file', input: { path: '/src/index.ts' } },
    { type: 'tool:result', toolName: 'read_file', durationMs: 42 },
    { type: 'tool:called', toolName: 'write_file', input: { path: '/src/main.ts' } },
    { type: 'tool:result', toolName: 'write_file', durationMs: 15 },
    { type: 'agent:completed', agentId: 'test-agent', runId: 'run-1', durationMs: 200 },
  ]
}

function makeSampleTrace(): CapturedTrace {
  const events: ReplayEvent[] = [
    { index: 0, timestamp: 1000, type: 'agent:started', data: { agentId: 'a1', runId: 'r1' }, stateSnapshot: { step: 0 } },
    { index: 1, timestamp: 1100, type: 'tool:called', nodeId: 'read_file', data: { toolName: 'read_file', input: {} } },
    { index: 2, timestamp: 1200, type: 'tool:result', nodeId: 'read_file', data: { toolName: 'read_file', durationMs: 50 } },
    { index: 3, timestamp: 1300, type: 'tool:called', nodeId: 'write_file', data: { toolName: 'write_file', input: {} } },
    { index: 4, timestamp: 1400, type: 'tool:result', nodeId: 'write_file', data: { toolName: 'write_file', durationMs: 20 } },
    { index: 5, timestamp: 1500, type: 'tool:error', nodeId: 'lint', data: { toolName: 'lint', error: 'Lint failed' } },
    { index: 6, timestamp: 1600, type: 'pipeline:node_retry', nodeId: 'lint', data: { nodeId: 'lint', attempt: 1, maxAttempts: 3, error: 'Lint failed', backoffMs: 1000 } },
    { index: 7, timestamp: 1700, type: 'tool:result', nodeId: 'lint', data: { toolName: 'lint', durationMs: 100 } },
    { index: 8, timestamp: 1800, type: 'agent:completed', data: { agentId: 'a1', runId: 'r1', durationMs: 800 }, stateSnapshot: { step: 8, done: true } },
  ]

  return {
    schemaVersion: '1.0.0',
    runId: 'run-1',
    agentId: 'test-agent',
    events,
    startedAt: 1000,
    completedAt: 1800,
    config: { snapshotInterval: 10 },
  }
}

// ---------------------------------------------------------------------------
// TraceCapture
// ---------------------------------------------------------------------------

describe('TraceCapture', () => {
  let bus: ForgeEventBus

  beforeEach(() => {
    bus = createTestBus()
  })

  it('captures events from event bus', () => {
    const capture = new TraceCapture(bus)
    capture.start('run-1', 'agent-1')

    emitSequence(bus, makeSampleEvents())

    expect(capture.eventCount).toBe(6)
    const trace = capture.stop()
    expect(trace.runId).toBe('run-1')
    expect(trace.agentId).toBe('agent-1')
    expect(trace.events).toHaveLength(6)
    expect(trace.schemaVersion).toBe('1.0.0')
  })

  it('assigns sequential indices to events', () => {
    const capture = new TraceCapture(bus)
    capture.start('run-1')

    emitSequence(bus, makeSampleEvents())

    const trace = capture.stop()
    for (let i = 0; i < trace.events.length; i++) {
      expect(trace.events[i]!.index).toBe(i)
    }
  })

  it('captures state snapshots at configured intervals', () => {
    let callCount = 0
    const capture = new TraceCapture(bus, { snapshotInterval: 2 })
    capture.setStateProvider(() => {
      callCount++
      return { counter: callCount }
    })
    capture.start('run-1')

    emitSequence(bus, makeSampleEvents())

    const trace = capture.stop()
    // Events at indices 0, 2, 4 should have snapshots (every 2)
    expect(trace.events[0]!.stateSnapshot).toEqual({ counter: 1 })
    expect(trace.events[1]!.stateSnapshot).toBeUndefined()
    expect(trace.events[2]!.stateSnapshot).toEqual({ counter: 2 })
    expect(trace.events[3]!.stateSnapshot).toBeUndefined()
    expect(trace.events[4]!.stateSnapshot).toEqual({ counter: 3 })
    expect(trace.events[5]!.stateSnapshot).toBeUndefined()
  })

  it('filters events by includeTypes', () => {
    const capture = new TraceCapture(bus, {
      snapshotInterval: 0,
      includeTypes: ['tool:*'],
    })
    capture.start('run-1')

    emitSequence(bus, makeSampleEvents())

    const trace = capture.stop()
    expect(trace.events).toHaveLength(4) // only tool:called and tool:result
    for (const event of trace.events) {
      expect(event.type.startsWith('tool:')).toBe(true)
    }
  })

  it('filters events by excludeTypes', () => {
    const capture = new TraceCapture(bus, {
      snapshotInterval: 0,
      excludeTypes: ['agent:*'],
    })
    capture.start('run-1')

    emitSequence(bus, makeSampleEvents())

    const trace = capture.stop()
    expect(trace.events).toHaveLength(4) // excludes agent:started and agent:completed
  })

  it('enforces maxEvents limit', () => {
    const capture = new TraceCapture(bus, {
      snapshotInterval: 0,
      maxEvents: 3,
    })
    capture.start('run-1')

    emitSequence(bus, makeSampleEvents())

    const trace = capture.stop()
    expect(trace.events).toHaveLength(3)
    // Should keep the latest 3 events
    expect(trace.events[0]!.type).toBe('tool:called')
    expect(trace.events[2]!.type).toBe('agent:completed')
  })

  it('throws if start is called while already capturing', () => {
    const capture = new TraceCapture(bus)
    capture.start('run-1')
    expect(() => capture.start('run-2')).toThrow('already capturing')
  })

  it('throws if stop is called without starting', () => {
    const capture = new TraceCapture(bus)
    expect(() => capture.stop()).toThrow('not capturing')
  })

  it('reports capturing status correctly', () => {
    const capture = new TraceCapture(bus)
    expect(capture.isCapturing()).toBe(false)
    capture.start('run-1')
    expect(capture.isCapturing()).toBe(true)
    capture.stop()
    expect(capture.isCapturing()).toBe(false)
  })

  it('peek returns events without stopping', () => {
    const capture = new TraceCapture(bus)
    capture.start('run-1')

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })

    const peeked = capture.peek()
    expect(peeked).toHaveLength(1)
    expect(capture.isCapturing()).toBe(true)

    capture.stop()
  })

  it('extracts nodeId from event data', () => {
    const capture = new TraceCapture(bus, { snapshotInterval: 0 })
    capture.start('run-1')

    bus.emit({ type: 'tool:called', toolName: 'read_file', input: {} })

    const trace = capture.stop()
    expect(trace.events[0]!.nodeId).toBe('read_file')
  })
})

// ---------------------------------------------------------------------------
// ReplayEngine
// ---------------------------------------------------------------------------

describe('ReplayEngine', () => {
  it('creates a session from a trace', () => {
    const engine = new ReplayEngine()
    const trace = makeSampleTrace()
    const session = engine.createSession(trace)

    expect(session.id).toBeTruthy()
    expect(session.runId).toBe('run-1')
    expect(session.events).toHaveLength(9)
    expect(session.currentIndex).toBe(-1)
    expect(session.status).toBe('paused')
    expect(session.speed).toBe(1)
  })

  it('creates sessions with custom speed and breakpoints', () => {
    const engine = new ReplayEngine()
    const trace = makeSampleTrace()
    const bp: Breakpoint = {
      id: 'bp-1',
      type: 'event-type',
      value: 'tool:error',
      enabled: true,
    }
    const session = engine.createSession(trace, { speed: 2, breakpoints: [bp] })

    expect(session.speed).toBe(2)
    expect(session.breakpoints).toHaveLength(1)
    expect(session.breakpoints[0]!.id).toBe('bp-1')
  })

  it('manages sessions', () => {
    const engine = new ReplayEngine()
    const trace = makeSampleTrace()

    const s1 = engine.createSession(trace)
    const s2 = engine.createSession(trace)

    expect(engine.sessionCount).toBe(2)
    expect(engine.getSession(s1.id)).toBe(s1)
    expect(engine.listSessions()).toHaveLength(2)

    engine.deleteSession(s1.id)
    expect(engine.sessionCount).toBe(1)

    engine.clear()
    expect(engine.sessionCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ReplayController
// ---------------------------------------------------------------------------

describe('ReplayController', () => {
  let session: ReplaySession

  beforeEach(() => {
    const engine = new ReplayEngine()
    session = engine.createSession(makeSampleTrace())
  })

  it('step advances one event at a time', () => {
    const controller = new ReplayController(session)

    const event1 = controller.step()
    expect(event1?.index).toBe(0)
    expect(event1?.type).toBe('agent:started')
    expect(session.currentIndex).toBe(0)

    const event2 = controller.step()
    expect(event2?.index).toBe(1)
    expect(session.currentIndex).toBe(1)
  })

  it('stepBack moves backward', () => {
    const controller = new ReplayController(session)

    controller.step() // index 0
    controller.step() // index 1
    controller.step() // index 2

    const event = controller.stepBack()
    expect(event?.index).toBe(1)
    expect(session.currentIndex).toBe(1)
  })

  it('stepBack at start returns undefined', () => {
    const controller = new ReplayController(session)

    const event = controller.stepBack()
    expect(event).toBeUndefined()
    expect(session.currentIndex).toBe(-1)
  })

  it('step at end returns undefined and sets completed', () => {
    const controller = new ReplayController(session)

    // Advance to the last event
    for (let i = 0; i < session.events.length; i++) {
      controller.step()
    }

    const event = controller.step()
    expect(event).toBeUndefined()
    expect(session.status).toBe('completed')
  })

  it('seekTo jumps to a specific index', () => {
    const controller = new ReplayController(session)

    const event = controller.seekTo(5)
    expect(event?.index).toBe(5)
    expect(session.currentIndex).toBe(5)
  })

  it('seekTo returns undefined for out-of-bounds index', () => {
    const controller = new ReplayController(session)

    expect(controller.seekTo(-1)).toBeUndefined()
    expect(controller.seekTo(100)).toBeUndefined()
  })

  it('reset moves to the beginning', () => {
    const controller = new ReplayController(session)

    controller.step()
    controller.step()
    controller.reset()

    expect(session.currentIndex).toBe(-1)
    expect(session.status).toBe('paused')
  })

  it('play advances through all events', async () => {
    // Use a session with 0-speed (no delays)
    session.speed = 1000 // Very fast to skip delays
    const controller = new ReplayController(session)

    const events: ReplayEvent[] = []
    controller.onEvent((event) => events.push(event))

    await controller.play()

    expect(events).toHaveLength(session.events.length)
    expect(session.status).toBe('completed')
    expect(session.currentIndex).toBe(session.events.length - 1)
  })

  it('pause stops playback', async () => {
    session.speed = 0.001 // Slow so we can pause
    const controller = new ReplayController(session)

    const events: ReplayEvent[] = []
    controller.onEvent((event) => events.push(event))

    // Start playing, then pause after a tick
    const playPromise = controller.play()
    // Give it a moment to start
    await new Promise(r => setTimeout(r, 10))
    controller.pause()
    await playPromise

    expect(session.status).toBe('paused')
    // Should have processed at least one event but not all
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  it('breakpoint on event type pauses playback', async () => {
    session.speed = 1000
    const controller = new ReplayController(session)

    controller.addBreakpoint({
      id: 'bp-error',
      type: 'event-type',
      value: 'tool:error',
      enabled: true,
    })

    const hitBreakpoints: Breakpoint[] = []
    controller.onBreakpointHit((bp) => hitBreakpoints.push(bp))

    await controller.play()

    expect(hitBreakpoints).toHaveLength(1)
    expect(hitBreakpoints[0]!.id).toBe('bp-error')
    expect(session.status).toBe('paused')
    // Should have stopped at the error event (index 5)
    expect(session.currentIndex).toBe(5)
  })

  it('breakpoint on node-id pauses playback', async () => {
    session.speed = 1000
    const controller = new ReplayController(session)

    controller.addBreakpoint({
      id: 'bp-write',
      type: 'node-id',
      value: 'write_file',
      enabled: true,
    })

    await controller.play()

    expect(session.status).toBe('paused')
    expect(session.events[session.currentIndex]!.nodeId).toBe('write_file')
  })

  it('breakpoint on error type catches error events', async () => {
    session.speed = 1000
    const controller = new ReplayController(session)

    controller.addBreakpoint({
      id: 'bp-any-error',
      type: 'error',
      value: '',
      enabled: true,
    })

    await controller.play()

    expect(session.status).toBe('paused')
    // First error event is at index 5 (tool:error)
    expect(session.currentIndex).toBe(5)
  })

  it('condition breakpoint with custom predicate', async () => {
    session.speed = 1000
    const controller = new ReplayController(session)

    controller.addBreakpoint({
      id: 'bp-custom',
      type: 'condition',
      value: 'custom check',
      condition: (event) => event.index === 3,
      enabled: true,
    })

    await controller.play()

    expect(session.status).toBe('paused')
    expect(session.currentIndex).toBe(3)
  })

  it('disabled breakpoints are skipped', async () => {
    session.speed = 1000
    const controller = new ReplayController(session)

    controller.addBreakpoint({
      id: 'bp-disabled',
      type: 'event-type',
      value: 'tool:error',
      enabled: false,
    })

    await controller.play()

    // Should play through the entire trace since breakpoint is disabled
    expect(session.status).toBe('completed')
  })

  it('removeBreakpoint removes by ID', () => {
    const controller = new ReplayController(session)

    controller.addBreakpoint({
      id: 'bp-1',
      type: 'event-type',
      value: 'tool:called',
      enabled: true,
    })

    expect(session.breakpoints).toHaveLength(1)
    expect(controller.removeBreakpoint('bp-1')).toBe(true)
    expect(session.breakpoints).toHaveLength(0)
    expect(controller.removeBreakpoint('nonexistent')).toBe(false)
  })

  it('toggleBreakpoint toggles enabled state', () => {
    const controller = new ReplayController(session)

    controller.addBreakpoint({
      id: 'bp-1',
      type: 'event-type',
      value: 'tool:called',
      enabled: true,
    })

    controller.toggleBreakpoint('bp-1')
    expect(session.breakpoints[0]!.enabled).toBe(false)

    controller.toggleBreakpoint('bp-1')
    expect(session.breakpoints[0]!.enabled).toBe(true)
  })

  it('clearBreakpoints removes all', () => {
    const controller = new ReplayController(session)

    controller.addBreakpoint({ id: '1', type: 'event-type', value: 'a', enabled: true })
    controller.addBreakpoint({ id: '2', type: 'event-type', value: 'b', enabled: true })

    controller.clearBreakpoints()
    expect(session.breakpoints).toHaveLength(0)
  })

  it('getState reconstructs from nearest snapshot', () => {
    const controller = new ReplayController(session)

    // Event 0 has stateSnapshot: { step: 0 }
    const state0 = controller.getState(0)
    expect(state0).toEqual({ step: 0 })

    // Event 4 has no snapshot, nearest is event 0
    const state4 = controller.getState(4)
    expect(state4).toEqual({ step: 0 })

    // Event 8 has stateSnapshot: { step: 8, done: true }
    const state8 = controller.getState(8)
    expect(state8).toEqual({ step: 8, done: true })
  })

  it('getState returns undefined for out-of-bounds index', () => {
    const controller = new ReplayController(session)
    expect(controller.getState(-1)).toBeUndefined()
    expect(controller.getState(100)).toBeUndefined()
  })

  it('setSpeed validates positive values', () => {
    const controller = new ReplayController(session)
    controller.setSpeed(2)
    expect(session.speed).toBe(2)
    expect(() => controller.setSpeed(0)).toThrow('positive')
    expect(() => controller.setSpeed(-1)).toThrow('positive')
  })

  it('status change callbacks fire on transitions', () => {
    const controller = new ReplayController(session)

    const changes: Array<{ status: string; prev: string }> = []
    controller.onStatusChange((status, prev) => {
      changes.push({ status, prev })
    })

    controller.step()
    // stepping -> paused (two transitions)
    expect(changes.length).toBeGreaterThanOrEqual(1)
  })

  it('onEvent callback unsubscribe works', async () => {
    session.speed = 1000
    const controller = new ReplayController(session)

    const events: ReplayEvent[] = []
    const unsub = controller.onEvent((event) => events.push(event))

    controller.step()
    expect(events).toHaveLength(1)

    unsub()

    controller.step()
    // Should still be 1 because we unsubscribed
    expect(events).toHaveLength(1)
  })

  it('play with empty events completes immediately', async () => {
    const emptySession: ReplaySession = {
      id: 'empty',
      runId: 'run-empty',
      events: [],
      currentIndex: -1,
      status: 'paused',
      breakpoints: [],
      speed: 1,
    }

    const controller = new ReplayController(emptySession)
    await controller.play()
    expect(emptySession.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// ReplayInspector
// ---------------------------------------------------------------------------

describe('ReplayInspector', () => {
  let session: ReplaySession

  beforeEach(() => {
    const engine = new ReplayEngine()
    session = engine.createSession(makeSampleTrace())
  })

  it('generates timeline data', () => {
    const inspector = new ReplayInspector(session)
    const timeline = inspector.getTimeline()

    expect(timeline.nodes).toHaveLength(9)
    expect(timeline.totalDurationMs).toBe(800)
    expect(timeline.errorCount).toBe(2) // tool:error + pipeline:node_retry (has error field)
    expect(timeline.recoveryCount).toBe(1) // pipeline:node_retry
    expect(timeline.nodeIds.length).toBeGreaterThan(0)
  })

  it('timeline nodes have correct error flags', () => {
    const inspector = new ReplayInspector(session)
    const timeline = inspector.getTimeline()

    const errorNode = timeline.nodes.find(n => n.type === 'tool:error')
    expect(errorNode?.isError).toBe(true)

    const normalNode = timeline.nodes.find(n => n.type === 'agent:started')
    expect(normalNode?.isError).toBe(false)
  })

  it('computes state diff between snapshots', () => {
    const inspector = new ReplayInspector(session)

    // Event 0 has { step: 0 }, Event 8 has { step: 8, done: true }
    const diffs = inspector.getStateDiff(0, 8)

    expect(diffs.length).toBeGreaterThan(0)

    const stepDiff = diffs.find(d => d.path === 'step')
    expect(stepDiff).toBeDefined()
    expect(stepDiff?.changeType).toBe('modified')
    expect(stepDiff?.previous).toBe(0)
    expect(stepDiff?.current).toBe(8)

    const doneDiff = diffs.find(d => d.path === 'done')
    expect(doneDiff).toBeDefined()
    expect(doneDiff?.changeType).toBe('added')
    expect(doneDiff?.current).toBe(true)
  })

  it('returns empty diff when no snapshots available', () => {
    // Create a session with no snapshots
    const noSnapshotSession: ReplaySession = {
      id: 's1',
      runId: 'r1',
      events: [
        { index: 0, timestamp: 1000, type: 'test', data: {} },
        { index: 1, timestamp: 1100, type: 'test', data: {} },
      ],
      currentIndex: -1,
      status: 'paused',
      breakpoints: [],
      speed: 1,
    }

    const inspector = new ReplayInspector(noSnapshotSession)
    const diffs = inspector.getStateDiff(0, 1)
    expect(diffs).toEqual([])
  })

  it('finds events by type pattern', () => {
    const inspector = new ReplayInspector(session)

    const toolEvents = inspector.findEventsByType('tool:*')
    expect(toolEvents.length).toBeGreaterThan(0)
    for (const e of toolEvents) {
      expect(e.type.startsWith('tool:')).toBe(true)
    }

    const exact = inspector.findEventsByType('agent:started')
    expect(exact).toHaveLength(1)
  })

  it('finds events by node ID', () => {
    const inspector = new ReplayInspector(session)

    const events = inspector.findEventsByNode('read_file')
    expect(events).toHaveLength(2) // tool:called and tool:result
  })

  it('finds error events', () => {
    const inspector = new ReplayInspector(session)

    const errors = inspector.findErrors()
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors.some(e => e.type === 'tool:error')).toBe(true)
  })

  it('finds recovery attempts', () => {
    const inspector = new ReplayInspector(session)

    const recoveries = inspector.findRecoveryAttempts()
    expect(recoveries).toHaveLength(1)
    expect(recoveries[0]!.type).toBe('pipeline:node_retry')
  })

  it('computes node metrics', () => {
    const inspector = new ReplayInspector(session)

    const metrics = inspector.getNodeMetrics()
    expect(metrics.size).toBeGreaterThan(0)

    const readMetrics = metrics.get('read_file')
    expect(readMetrics).toBeDefined()
    expect(readMetrics!.eventCount).toBe(2)
    expect(readMetrics!.totalDurationMs).toBe(50)
  })

  it('generates summary', () => {
    const inspector = new ReplayInspector(session)

    const summary = inspector.getSummary()
    expect(summary.runId).toBe('run-1')
    expect(summary.totalEvents).toBe(9)
    expect(summary.errorCount).toBe(2) // tool:error + retry (has error field)
    expect(summary.recoveryCount).toBe(1)
    expect(summary.eventTypeCounts['tool:called']).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// TraceSerializer
// ---------------------------------------------------------------------------

describe('TraceSerializer', () => {
  const serializer = new TraceSerializer()
  const trace = makeSampleTrace()

  it('serializes and deserializes JSON format', () => {
    const buffer = serializer.serialize(trace, { format: 'json' })
    const restored = serializer.deserialize(buffer, 'json')

    expect(restored.runId).toBe(trace.runId)
    expect(restored.events).toHaveLength(trace.events.length)
    expect(restored.schemaVersion).toBe('1.0.0')
  })

  it('serializes and deserializes compact JSON format', () => {
    const buffer = serializer.serialize(trace, { format: 'json-compact' })
    const restored = serializer.deserialize(buffer, 'json-compact')

    expect(restored.runId).toBe(trace.runId)
    expect(restored.events).toHaveLength(trace.events.length)

    // Compact should be smaller than pretty
    const prettyBuffer = serializer.serialize(trace, { format: 'json' })
    expect(buffer.length).toBeLessThan(prettyBuffer.length)
  })

  it('serializes and deserializes binary format', () => {
    const buffer = serializer.serialize(trace, { format: 'binary' })

    // Verify magic bytes
    expect(buffer.subarray(0, 7).toString('ascii')).toBe('FGTRACE')
    expect(buffer.readUInt8(7)).toBe(1) // version

    const restored = serializer.deserialize(buffer, 'binary')
    expect(restored.runId).toBe(trace.runId)
    expect(restored.events).toHaveLength(trace.events.length)
  })

  it('binary format is smaller than JSON', () => {
    const jsonBuffer = serializer.serialize(trace, { format: 'json' })
    const binaryBuffer = serializer.serialize(trace, { format: 'binary' })

    expect(binaryBuffer.length).toBeLessThan(jsonBuffer.length)
  })

  it('auto-detects binary format', () => {
    const buffer = serializer.serialize(trace, { format: 'binary' })
    const restored = serializer.deserialize(buffer) // no format specified

    expect(restored.runId).toBe(trace.runId)
  })

  it('auto-detects JSON format', () => {
    const buffer = serializer.serialize(trace, { format: 'json' })
    const restored = serializer.deserialize(buffer) // no format specified

    expect(restored.runId).toBe(trace.runId)
  })

  it('sanitizes sensitive fields', () => {
    const traceWithSecrets: CapturedTrace = {
      ...trace,
      events: [
        {
          index: 0,
          timestamp: 1000,
          type: 'test',
          data: {
            apiKey: 'sk-secret-123',
            password: 'hunter2',
            safe: 'this is fine',
            nested: {
              accessToken: 'tok-abc',
              value: 42,
            },
          },
        },
      ],
    }

    const buffer = serializer.serialize(traceWithSecrets, {
      format: 'json',
      sanitize: true,
    })
    const restored = serializer.deserialize(buffer, 'json')
    const data = restored.events[0]!.data

    expect(data['apiKey']).toBe('[REDACTED]')
    expect(data['password']).toBe('[REDACTED]')
    expect(data['safe']).toBe('this is fine')
    const nested = data['nested'] as Record<string, unknown>
    expect(nested['accessToken']).toBe('[REDACTED]')
    expect(nested['value']).toBe(42)
  })

  it('sanitizes with custom redact fields', () => {
    const traceWithCustom: CapturedTrace = {
      ...trace,
      events: [
        {
          index: 0,
          timestamp: 1000,
          type: 'test',
          data: { myCustomField: 'sensitive', normal: 'ok' },
        },
      ],
    }

    const buffer = serializer.serialize(traceWithCustom, {
      format: 'json',
      sanitize: true,
      redactFields: ['myCustomField'],
    })
    const restored = serializer.deserialize(buffer, 'json')

    expect(restored.events[0]!.data['myCustomField']).toBe('[REDACTED]')
    expect(restored.events[0]!.data['normal']).toBe('ok')
  })

  it('sanitize also redacts state snapshots', () => {
    const traceWithSnapshot: CapturedTrace = {
      ...trace,
      events: [
        {
          index: 0,
          timestamp: 1000,
          type: 'test',
          data: {},
          stateSnapshot: { secretToken: 'abc123', counter: 5 },
        },
      ],
    }

    const sanitized = serializer.sanitize(traceWithSnapshot)
    expect(sanitized.events[0]!.stateSnapshot!['secretToken']).toBe('[REDACTED]')
    expect(sanitized.events[0]!.stateSnapshot!['counter']).toBe(5)
  })

  it('rejects invalid trace data', () => {
    const invalid = Buffer.from('{"runId": 42}', 'utf-8')
    expect(() => serializer.deserialize(invalid, 'json')).toThrow()
  })

  it('rejects wrong schema version', () => {
    const wrongVersion = Buffer.from(
      JSON.stringify({ schemaVersion: '2.0.0', runId: 'r1', events: [] }),
      'utf-8',
    )
    expect(() => serializer.deserialize(wrongVersion, 'json')).toThrow('schema version')
  })

  it('rejects binary with bad magic bytes', () => {
    const badMagic = Buffer.alloc(20)
    badMagic.write('INVALID', 0, 7, 'ascii')
    expect(() => serializer.deserialize(badMagic, 'binary')).toThrow('magic bytes')
  })
})

// ---------------------------------------------------------------------------
// Integration: Capture -> Engine -> Controller -> Inspector
// ---------------------------------------------------------------------------

describe('Replay integration', () => {
  it('full workflow: capture events, create session, replay, inspect', async () => {
    const bus = createTestBus()
    const capture = new TraceCapture(bus, { snapshotInterval: 3 })

    let stateCounter = 0
    capture.setStateProvider(() => ({ step: stateCounter++ }))
    capture.start('integration-run', 'agent-1')

    // Emit events
    emitSequence(bus, [
      { type: 'agent:started', agentId: 'agent-1', runId: 'integration-run' },
      { type: 'tool:called', toolName: 'search', input: { query: 'test' } },
      { type: 'tool:result', toolName: 'search', durationMs: 100 },
      { type: 'tool:called', toolName: 'write', input: { content: 'hello' } },
      { type: 'tool:result', toolName: 'write', durationMs: 50 },
      { type: 'agent:completed', agentId: 'agent-1', runId: 'integration-run', durationMs: 300 },
    ])

    const trace = capture.stop()

    // Create replay session
    const engine = new ReplayEngine()
    const session = engine.createSession(trace)

    // Use controller
    const controller = new ReplayController(session)
    const visitedTypes: string[] = []
    controller.onEvent((event) => visitedTypes.push(event.type))

    // Step through first 3 events
    controller.step()
    controller.step()
    controller.step()
    expect(visitedTypes).toEqual(['agent:started', 'tool:called', 'tool:result'])

    // Seek to end
    controller.seekTo(5)
    expect(session.currentIndex).toBe(5)

    // Inspect
    const inspector = new ReplayInspector(session)
    const timeline = inspector.getTimeline()
    expect(timeline.nodes).toHaveLength(6)

    const summary = inspector.getSummary()
    expect(summary.totalEvents).toBe(6)
    expect(summary.eventTypeCounts['tool:called']).toBe(2)

    // Serialize for sharing
    const serializer = new TraceSerializer()
    const binary = serializer.serialize(trace, { format: 'binary' })
    const restored = serializer.deserialize(binary)
    expect(restored.events).toHaveLength(6)
  })
})
