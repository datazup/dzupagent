/**
 * Tests for the useTraceReplay composable and mapServerStepToTraceEvent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useTraceStore } from '../stores/trace-store.js'
import {
  mapServerStepToTraceEvent,
  useTraceReplay,
  type ServerTraceStep,
  type ServerTraceResponse,
} from '../composables/useTraceReplay.js'
import type { ApiResponse } from '../types.js'

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

const mockGet = vi.fn()

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: mockGet,
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: (p: string) => p,
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServerStep(overrides: Partial<ServerTraceStep> = {}): ServerTraceStep {
  return {
    stepIndex: 0,
    timestamp: Date.now(),
    type: 'llm_request',
    content: 'test content',
    ...overrides,
  }
}

function makeServerResponse(
  steps: ServerTraceStep[],
  overrides: Partial<ServerTraceResponse> = {},
): ApiResponse<ServerTraceResponse> {
  return {
    data: {
      runId: 'run-1',
      agentId: 'agent-1',
      steps,
      totalSteps: steps.length,
      distribution: {
        user_input: 0,
        llm_request: 0,
        llm_response: 0,
        tool_call: 0,
        tool_result: 0,
        system: 0,
        output: 0,
      },
      startedAt: Date.now(),
      ...overrides,
    },
  }
}

// ---------------------------------------------------------------------------
// Tests: mapServerStepToTraceEvent
// ---------------------------------------------------------------------------

describe('mapServerStepToTraceEvent', () => {
  it('maps llm_request to llm type', () => {
    const step = makeServerStep({ type: 'llm_request', stepIndex: 0 })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.type).toBe('llm')
    expect(event.id).toBe('run-1-step-0')
  })

  it('maps llm_response to llm type', () => {
    const step = makeServerStep({ type: 'llm_response', stepIndex: 1 })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.type).toBe('llm')
    expect(event.id).toBe('run-1-step-1')
  })

  it('maps tool_call to tool type', () => {
    const step = makeServerStep({ type: 'tool_call', stepIndex: 2 })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.type).toBe('tool')
  })

  it('maps tool_result to tool type', () => {
    const step = makeServerStep({ type: 'tool_result', stepIndex: 3 })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.type).toBe('tool')
  })

  it('maps user_input to system type', () => {
    const step = makeServerStep({ type: 'user_input' })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.type).toBe('system')
  })

  it('maps system to system type', () => {
    const step = makeServerStep({ type: 'system' })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.type).toBe('system')
  })

  it('maps output to system type', () => {
    const step = makeServerStep({ type: 'output' })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.type).toBe('system')
  })

  it('uses toolName from metadata as name', () => {
    const step = makeServerStep({
      type: 'tool_call',
      metadata: { toolName: 'searchDocs' },
    })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.name).toBe('searchDocs')
  })

  it('uses tool from metadata as name fallback', () => {
    const step = makeServerStep({
      type: 'tool_call',
      metadata: { tool: 'readFile' },
    })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.name).toBe('readFile')
  })

  it('uses model from metadata as name for LLM steps', () => {
    const step = makeServerStep({
      type: 'llm_request',
      metadata: { model: 'claude-3-opus' },
    })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.name).toBe('claude-3-opus')
  })

  it('uses string content as name when no metadata', () => {
    const step = makeServerStep({
      type: 'system',
      content: 'Phase changed to planning',
      metadata: undefined,
    })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.name).toBe('Phase changed to planning')
  })

  it('truncates long string content to 60 chars', () => {
    const longContent = 'A'.repeat(80)
    const step = makeServerStep({
      type: 'system',
      content: longContent,
      metadata: undefined,
    })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.name.length).toBe(60)
    expect(event.name).toBe(`${'A'.repeat(57)}...`)
  })

  it('falls back to type label when no metadata or content', () => {
    const step = makeServerStep({
      type: 'llm_request',
      content: null,
      metadata: undefined,
    })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.name).toBe('llm request')
  })

  it('converts timestamp to ISO string', () => {
    const ts = 1711411200000 // 2024-03-26T00:00:00Z
    const step = makeServerStep({ timestamp: ts })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.startedAt).toBe(new Date(ts).toISOString())
  })

  it('uses durationMs from step or defaults to 0', () => {
    const withDuration = makeServerStep({ durationMs: 500 })
    expect(mapServerStepToTraceEvent(withDuration, 'run-1').durationMs).toBe(500)

    const withoutDuration = makeServerStep({ durationMs: undefined })
    expect(mapServerStepToTraceEvent(withoutDuration, 'run-1').durationMs).toBe(0)
  })

  it('preserves metadata on the mapped event', () => {
    const step = makeServerStep({
      metadata: { model: 'claude-3', tokens: 500 },
    })
    const event = mapServerStepToTraceEvent(step, 'run-1')

    expect(event.metadata).toEqual({ model: 'claude-3', tokens: 500 })
  })
})

// ---------------------------------------------------------------------------
// Tests: useTraceReplay composable
// ---------------------------------------------------------------------------

describe('useTraceReplay', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGet.mockReset()
  })

  it('starts with default state', () => {
    const { totalSteps, isLoading, error } = useTraceReplay()

    expect(totalSteps.value).toBe(0)
    expect(isLoading.value).toBe(false)
    expect(error.value).toBeNull()
  })

  it('loadTrace fetches steps and populates trace store', async () => {
    const steps: ServerTraceStep[] = [
      makeServerStep({ stepIndex: 0, type: 'llm_request', durationMs: 100 }),
      makeServerStep({ stepIndex: 1, type: 'tool_call', durationMs: 200 }),
      makeServerStep({ stepIndex: 2, type: 'llm_response', durationMs: 150 }),
    ]
    mockGet.mockResolvedValueOnce(makeServerResponse(steps))

    const traceStore = useTraceStore()
    const { loadTrace, totalSteps, isLoading } = useTraceReplay()

    await loadTrace('run-1')

    expect(mockGet).toHaveBeenCalledWith('/api/runs/run-1/messages')
    expect(totalSteps.value).toBe(3)
    expect(traceStore.events.length).toBe(3)
    expect(traceStore.events[0]?.type).toBe('llm')
    expect(traceStore.events[1]?.type).toBe('tool')
    expect(traceStore.events[2]?.type).toBe('llm')
    expect(isLoading.value).toBe(false)
  })

  it('loadTrace sets isLoading during fetch', async () => {
    const loadingStates: boolean[] = []

    // Use a deferred promise to control timing
    let resolveGet: ((value: ApiResponse<ServerTraceResponse>) => void) | null = null
    mockGet.mockReturnValueOnce(
      new Promise<ApiResponse<ServerTraceResponse>>((resolve) => {
        resolveGet = resolve
      }),
    )

    const { loadTrace, isLoading } = useTraceReplay()

    const loadPromise = loadTrace('run-1')
    loadingStates.push(isLoading.value)

    resolveGet!(makeServerResponse([]))
    await loadPromise
    loadingStates.push(isLoading.value)

    expect(loadingStates[0]).toBe(true)
    expect(loadingStates[1]).toBe(false)
  })

  it('loadTrace sets error on failure', async () => {
    mockGet.mockRejectedValueOnce(new Error('Network error'))

    const { loadTrace, error, isLoading } = useTraceReplay()

    await loadTrace('run-1')

    expect(error.value).toBe('Network error')
    expect(isLoading.value).toBe(false)
  })

  it('loadTrace sets generic error for non-Error throws', async () => {
    mockGet.mockRejectedValueOnce('something went wrong')

    const { loadTrace, error } = useTraceReplay()

    await loadTrace('run-1')

    expect(error.value).toBe('Failed to load trace')
  })

  it('loadTrace clears previous error on new request', async () => {
    mockGet.mockRejectedValueOnce(new Error('first error'))

    const { loadTrace, error } = useTraceReplay()

    await loadTrace('run-1')
    expect(error.value).toBe('first error')

    mockGet.mockResolvedValueOnce(makeServerResponse([]))
    await loadTrace('run-1')
    expect(error.value).toBeNull()
  })

  it('loadTrace replaces existing trace store events', async () => {
    const traceStore = useTraceStore()
    traceStore.addEvent({
      id: 'old-event',
      type: 'system',
      name: 'old',
      startedAt: new Date().toISOString(),
      durationMs: 0,
    })

    const steps = [makeServerStep({ stepIndex: 0, type: 'llm_request' })]
    mockGet.mockResolvedValueOnce(makeServerResponse(steps))

    const { loadTrace } = useTraceReplay()
    await loadTrace('run-1')

    expect(traceStore.events.length).toBe(1)
    expect(traceStore.events[0]?.id).toBe('run-1-step-0')
  })

  it('loadPage fetches a paginated range and returns mapped events', async () => {
    const steps = [
      makeServerStep({ stepIndex: 5, type: 'tool_call' }),
      makeServerStep({ stepIndex: 6, type: 'tool_result' }),
    ]
    mockGet.mockResolvedValueOnce(makeServerResponse(steps))

    const { loadPage } = useTraceReplay()
    const events = await loadPage('run-1', 5, 7)

    expect(mockGet).toHaveBeenCalledWith('/api/runs/run-1/messages?from=5&to=7')
    expect(events.length).toBe(2)
    expect(events[0]?.type).toBe('tool')
    expect(events[1]?.type).toBe('tool')
  })
})
