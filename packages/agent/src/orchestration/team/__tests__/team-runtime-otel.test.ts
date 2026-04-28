/**
 * TeamRuntime OTel tracing tests.
 *
 * Verifies that when a `tracer` is supplied via `TeamRuntimeOptions`, the
 * runtime creates a root span per `execute()` call, attaches the required
 * `team.*` semantic attributes, emits span events on phase changes and
 * participant completion, and ends the span with OK/ERROR status. When no
 * tracer is supplied, execution proceeds without crashing.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../../../agent/dzip-agent.js'
import { TeamRuntime } from '../team-runtime.js'
import type {
  TeamOTelSpanLike,
  TeamRuntimeTracer,
} from '../team-runtime.js'
import type { ParticipantDefinition, TeamDefinition } from '../team-definition.js'
import type { TeamSpawnedAgent as SpawnedAgent } from '../team-workspace.js'

// ---------------------------------------------------------------------------
// Mock tracer
// ---------------------------------------------------------------------------

interface EventRecord {
  name: string
  attributes: Record<string, string | number | boolean> | undefined
}

interface SpanRecord {
  phase: string
  attributes: Record<string, string | number | boolean>
  events: EventRecord[]
  ended: boolean
  status: 'ok' | 'error' | 'pending'
  error?: unknown
}

function createMockTracer(): { tracer: TeamRuntimeTracer; spans: SpanRecord[] } {
  const spans: SpanRecord[] = []
  const spanToRecord = new WeakMap<object, SpanRecord>()

  const tracer: TeamRuntimeTracer = {
    startPhaseSpan(phase, _options) {
      const record: SpanRecord = {
        phase,
        attributes: {},
        events: [],
        ended: false,
        status: 'pending',
      }
      spans.push(record)
      const span: TeamOTelSpanLike = {
        setAttribute(key, value) {
          record.attributes[key] = value
          return span
        },
        addEvent(name, attrs) {
          record.events.push({ name, attributes: attrs })
          return span
        },
        end() {
          record.ended = true
        },
      }
      spanToRecord.set(span as object, record)
      return span
    },
    endSpanOk(span) {
      const rec = spanToRecord.get(span as object)
      if (rec) {
        rec.status = 'ok'
        rec.ended = true
      }
      span.end()
    },
    endSpanWithError(span, error) {
      const rec = spanToRecord.get(span as object)
      if (rec) {
        rec.status = 'error'
        rec.error = error
        rec.ended = true
      }
      span.end()
    },
  }

  return { tracer, spans }
}

// ---------------------------------------------------------------------------
// Mock agents
// ---------------------------------------------------------------------------

function createMockModel(response: string, shouldThrow = false): BaseChatModel {
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    if (shouldThrow) throw new Error('mock model exploded')
    return new AIMessage({ content: response, response_metadata: {} })
  })
  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createAgent(id: string, response = 'ok', shouldThrow = false): DzupAgent {
  return new DzupAgent({
    id,
    description: `${id} agent`,
    instructions: `You are ${id}.`,
    model: createMockModel(response, shouldThrow),
  })
}

function buildTeamDefinition(
  id: string,
  pattern: TeamDefinition['coordinatorPattern'],
  participantIds: string[],
): TeamDefinition {
  return {
    id,
    name: `Team ${id}`,
    coordinatorPattern: pattern,
    participants: participantIds.map((pid, idx) => ({
      id: pid,
      role: idx === 0 ? 'supervisor' : 'specialist',
      model: 'mock-model',
    })) as ParticipantDefinition[],
  }
}

function makeResolver(
  agentsById: Map<string, DzupAgent>,
): (p: ParticipantDefinition) => Promise<SpawnedAgent> {
  return async (p) => {
    const agent = agentsById.get(p.id)
    if (!agent) throw new Error(`no agent for participant ${p.id}`)
    return {
      agent,
      status: 'idle',
      role: p.role as SpawnedAgent['role'],
      tags: [],
      spawnedAt: Date.now(),
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamRuntime — OTel tracing', () => {
  it('creates a span with the correct team.run_id attribute', async () => {
    const { tracer, spans } = createMockTracer()
    const def = buildTeamDefinition('team-run-id', 'peer_to_peer', ['a'])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(new Map([['a', createAgent('a')]])),
      generateRunId: () => 'fixed-run-id-1',
      tracer,
    })

    await runtime.execute('task')

    expect(spans).toHaveLength(1)
    expect(spans[0]!.attributes['team.run_id']).toBe('fixed-run-id-1')
  })

  it('creates a span with the correct team.agent_count attribute', async () => {
    const { tracer, spans } = createMockTracer()
    const def = buildTeamDefinition('team-agent-count', 'peer_to_peer', [
      'a',
      'b',
      'c',
    ])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(
        new Map([
          ['a', createAgent('a')],
          ['b', createAgent('b')],
          ['c', createAgent('c')],
        ]),
      ),
      tracer,
    })

    await runtime.execute('task')

    expect(spans[0]!.attributes['team.agent_count']).toBe(3)
  })

  it('creates a span with the correct team.coordination_pattern attribute', async () => {
    const { tracer, spans } = createMockTracer()
    const def = buildTeamDefinition('team-pattern', 'peer_to_peer', ['a', 'b'])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(
        new Map([
          ['a', createAgent('a')],
          ['b', createAgent('b')],
        ]),
      ),
      tracer,
    })

    await runtime.execute('task')

    expect(spans[0]!.attributes['team.coordination_pattern']).toBe('peer_to_peer')
  })

  it('adds a span event on phase change', async () => {
    const { tracer, spans } = createMockTracer()
    const def = buildTeamDefinition('team-phase', 'peer_to_peer', ['a'])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(new Map([['a', createAgent('a')]])),
      tracer,
    })

    await runtime.execute('task')

    const phaseEvents = spans[0]!.events.filter(
      (e) => e.name === 'team.phase_changed',
    )
    expect(phaseEvents.length).toBeGreaterThan(0)
    // Every phase_changed event must carry a team.phase attribute
    for (const ev of phaseEvents) {
      expect(ev.attributes).toBeDefined()
      expect(typeof ev.attributes!['team.phase']).toBe('string')
    }
    // Expect the canonical transitions (planning, executing, evaluating, completing).
    const phases = phaseEvents.map((e) => e.attributes!['team.phase'])
    expect(phases).toContain('planning')
    expect(phases).toContain('executing')
    expect(phases).toContain('completing')
  })

  it('adds a span event on participant_completed with id + status', async () => {
    const { tracer, spans } = createMockTracer()
    const def = buildTeamDefinition('team-participant', 'peer_to_peer', [
      'a',
      'b',
    ])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(
        new Map([
          ['a', createAgent('a', 'content-a')],
          ['b', createAgent('b', 'content-b')],
        ]),
      ),
      tracer,
    })

    await runtime.execute('task')

    const participantEvents = spans[0]!.events.filter(
      (e) => e.name === 'team.participant_completed',
    )
    expect(participantEvents.length).toBe(2)
    const ids = participantEvents.map((e) => e.attributes!['team.participant_id'])
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    for (const ev of participantEvents) {
      expect(ev.attributes!['team.participant_status']).toBe('success')
    }
  })

  it('ends span with OK status on successful execute()', async () => {
    const { tracer, spans } = createMockTracer()
    const def = buildTeamDefinition('team-ok', 'peer_to_peer', ['a'])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(new Map([['a', createAgent('a')]])),
      tracer,
    })

    await runtime.execute('task')

    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status).toBe('ok')
  })

  it('ends span with ERROR status on failed execute()', async () => {
    const { tracer, spans } = createMockTracer()
    const def = buildTeamDefinition('team-err', 'peer_to_peer', [])
    // No participants — peer_to_peer runtime throws before any agent runs.
    const runtime = new TeamRuntime({
      definition: def,
      tracer,
    })

    await expect(runtime.execute('task')).rejects.toThrow()

    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status).toBe('error')
    expect(spans[0]!.error).toBeInstanceOf(Error)
  })

  it('marks failed participants with status=failed in span event', async () => {
    const { tracer, spans } = createMockTracer()
    const def = buildTeamDefinition('team-partial-fail', 'peer_to_peer', [
      'a',
      'b',
    ])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(
        new Map([
          ['a', createAgent('a', 'ok')],
          ['b', createAgent('b', 'ignored', true)], // b throws
        ]),
      ),
      tracer,
    })

    await runtime.execute('task')

    const events = spans[0]!.events.filter(
      (e) => e.name === 'team.participant_completed',
    )
    const byId = new Map(
      events.map((e) => [
        e.attributes!['team.participant_id'] as string,
        e.attributes!['team.participant_status'] as string,
      ]),
    )
    expect(byId.get('a')).toBe('success')
    expect(byId.get('b')).toBe('failed')
  })

  it('does not crash when no tracer is provided', async () => {
    const def = buildTeamDefinition('team-no-tracer', 'peer_to_peer', ['a'])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(new Map([['a', createAgent('a')]])),
      // no tracer
    })

    const result = await runtime.execute('task')
    expect(result.pattern).toBe('peer-to-peer')
    expect(result.agentResults).toHaveLength(1)
  })
})
