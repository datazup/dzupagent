import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@dzupagent/adapter-types'
import type { AdapterInstallationRef } from '@dzupagent/adapter-types/monitoring/installation'
import { PROVIDER_CATALOG } from '../../provider-catalog.js'
import {
  buildCapabilityManifest,
  detectCapabilityDrift,
} from '../capability-manifest-builder.js'
import {
  ObservedCapabilitiesLiveSubscriber,
  reduceRunEventsToObservedCapabilities,
  replayObservedCapabilities,
  type ObservedRunEvent,
  type ObservedRunEventSource,
} from '../observed-capabilities-reducer.js'

const FROM = '2026-08-09T08:00:00.000Z'
const TO = '2026-08-09T09:00:00.000Z'
const STARTED_AT = Date.parse('2026-08-09T08:10:00.000Z')
const STREAMED_AT = Date.parse('2026-08-09T08:10:01.000Z')
const COMPLETED_AT = Date.parse('2026-08-09T08:10:02.000Z')

const ref: AdapterInstallationRef = {
  installationId: 'inst-goose-01',
  coordinates: { providerId: 'goose', backend: 'cli' },
  hostBindingId: 'worker-7',
  managed: true,
}

const started = {
  type: 'adapter:started',
  providerId: 'goose',
  sessionId: 'session-1',
  timestamp: STARTED_AT,
} satisfies AgentEvent

const streamed = {
  type: 'adapter:stream_delta',
  providerId: 'goose',
  content: 'hello',
  timestamp: STREAMED_AT,
} satisfies AgentEvent

const toolResult = {
  type: 'adapter:tool_result',
  providerId: 'goose',
  toolName: 'read_file',
  output: 'hello',
  durationMs: 10,
  timestamp: STREAMED_AT,
} satisfies AgentEvent

const completed = {
  type: 'adapter:completed',
  providerId: 'goose',
  sessionId: 'session-1',
  result: 'hello',
  durationMs: 2_000,
  timestamp: COMPLETED_AT,
} satisfies AgentEvent

const retained: ObservedRunEvent[] = [
  { runId: 'run-1', eventId: 'event-started', event: started },
  { runId: 'run-1', eventId: 'event-streamed', event: streamed },
  { runId: 'run-1', eventId: 'event-completed', event: completed },
]

class FixtureEventSource implements ObservedRunEventSource {
  private listener: ((event: ObservedRunEvent) => void) | null = null

  subscribe(listener: (event: ObservedRunEvent) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }

  emit(event: ObservedRunEvent): void {
    this.listener?.(event)
  }
}

describe('run-event capability observation (Q3)', () => {
  it('is byte-equivalent for out-of-order duplicate live and retained events', () => {
    const cycle = { ref, window: { from: FROM, to: TO } }
    const source = new FixtureEventSource()
    const live = new ObservedCapabilitiesLiveSubscriber(source, cycle)
    live.start()

    source.emit(retained[2]!)
    source.emit(retained[1]!)
    source.emit(retained[0]!)
    source.emit(retained[1]!)

    const liveResult = live.completeCycle()
    const replayResult = replayObservedCapabilities({
      ...cycle,
      events: [...retained, retained[1]!].reverse(),
    })

    expect(JSON.stringify(liveResult)).toBe(JSON.stringify(replayResult))
    expect(liveResult).toMatchObject({
      completeness: 'complete',
      streamingSeen: true,
      usageReported: false,
      lastSuccessfulRunAt: new Date(COMPLETED_AT).toISOString(),
    })
    expect(liveResult.evidence.streamingSeen).toEqual({
      eventIds: ['event-streamed'],
      runIds: ['run-1'],
    })

    source.emit({
      runId: 'late-run',
      eventId: 'event-after-cycle',
      event: { ...streamed, timestamp: STREAMED_AT + 1 },
    })
    expect(JSON.stringify(live.completeCycle())).toBe(JSON.stringify(liveResult))
  })

  it('handles a missing-terminal partial run honestly and keeps positive evidence', () => {
    const result = reduceRunEventsToObservedCapabilities({
      ref,
      window: { from: FROM, to: TO },
      events: retained.slice(0, 2),
    })

    expect(result.completeness).toBe('partial')
    expect(result.streamingSeen).toBe(true)
    expect(result.usageReported).toBeNull()
    expect(result.interactionPromptsSeen).toBeNull()
    expect(result.lastSuccessfulRunAt).toBeNull()
  })

  it('handles a missing-start partial run honestly and keeps positive evidence', () => {
    const result = reduceRunEventsToObservedCapabilities({
      ref,
      window: { from: FROM, to: TO },
      events: retained.slice(1),
    })

    expect(result.completeness).toBe('partial')
    expect(result.streamingSeen).toBe(true)
    expect(result.evidence.streamingSeen).toEqual({
      eventIds: ['event-streamed'],
      runIds: ['run-1'],
    })
    expect(result.usageReported).toBeNull()
    expect(result.interactionPromptsSeen).toBeNull()
    expect(result.lastSuccessfulRunAt).toBeNull()
  })

  it('chooses a conflicting duplicate canonically regardless of relative order', () => {
    const streamingCandidate: ObservedRunEvent = {
      runId: 'run-1',
      eventId: 'event-conflict',
      event: streamed,
    }
    const toolCandidate: ObservedRunEvent = {
      runId: 'run-1',
      eventId: 'event-conflict',
      event: toolResult,
    }
    const left = reduceRunEventsToObservedCapabilities({
      ref,
      window: { from: FROM, to: TO },
      events: [
        retained[0]!,
        toolCandidate,
        streamingCandidate,
        retained[2]!,
      ],
    })
    const right = reduceRunEventsToObservedCapabilities({
      ref,
      window: { from: FROM, to: TO },
      events: [
        retained[0]!,
        streamingCandidate,
        toolCandidate,
        retained[2]!,
      ],
    })

    expect(JSON.stringify(left)).toBe(JSON.stringify(right))
    expect(left.streamingSeen).toBe(true)
    expect(left.toolLoopExecuted).toBeNull()
    expect(left.evidence.streamingSeen).toEqual({
      eventIds: ['event-conflict'],
      runIds: ['run-1'],
    })
  })

  it('does not add a capability seen only after the terminal event', () => {
    const result = reduceRunEventsToObservedCapabilities({
      ref,
      window: { from: FROM, to: TO },
      events: [
        retained[0]!,
        retained[2]!,
        {
          runId: 'run-1',
          eventId: 'event-late-streaming-only',
          event: { ...streamed, timestamp: COMPLETED_AT + 1 },
        },
      ],
    })

    expect(result.completeness).toBe('complete')
    expect(result.streamingSeen).toBe(false)
    expect(result.evidence.streamingSeen).toEqual({
      eventIds: ['event-completed'],
      runIds: ['run-1'],
    })
    expect(result.evidence.streamingSeen?.eventIds).not.toContain(
      'event-late-streaming-only',
    )
  })

  it('selects the latest successful run by event time rather than run id', () => {
    const laterCompleted = {
      ...completed,
      sessionId: 'session-later',
      timestamp: COMPLETED_AT + 10,
    } satisfies AgentEvent
    const result = reduceRunEventsToObservedCapabilities({
      ref,
      window: { from: FROM, to: TO },
      events: [
        { runId: 'z-earlier', eventId: 'z-started', event: started },
        { runId: 'z-earlier', eventId: 'z-completed', event: completed },
        {
          runId: 'a-later',
          eventId: 'a-started',
          event: { ...started, sessionId: 'session-later' },
        },
        { runId: 'a-later', eventId: 'a-completed', event: laterCompleted },
      ],
    })

    expect(result.lastSuccessfulRunAt).toBe(
      new Date(laterCompleted.timestamp).toISOString(),
    )
    expect(result.evidence.lastSuccessfulRunAt).toEqual({
      eventIds: ['a-completed'],
      runIds: ['a-later'],
    })
  })

  it('reports drift within one completed cycle using an M1.2 catalog entry', () => {
    const observed = replayObservedCapabilities({
      ref,
      window: { from: FROM, to: TO },
      events: retained,
    })
    const manifest = buildCapabilityManifest({
      ref,
      catalog: PROVIDER_CATALOG.goose,
      installation: null,
      observed,
      builtAt: TO,
    })

    const findings = detectCapabilityDrift(manifest, TO)

    expect(findings).toEqual([
      expect.objectContaining({
        capability: 'streaming',
        declaredBy: 'catalog',
        declaredSource: PROVIDER_CATALOG.goose.upstream.docsUrl,
        declaredCertainty: 'official',
        observedEvidence: {
          eventIds: ['event-streamed'],
          runIds: ['run-1'],
        },
      }),
    ])
  })
})
