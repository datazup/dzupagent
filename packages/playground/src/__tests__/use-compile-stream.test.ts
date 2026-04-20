/**
 * Tests for the useCompileStream composable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useCompileStream } from '../composables/useCompileStream.js'
import type { WsEvent } from '../types.js'

// ── WS store mock ──────────────────────────────────────────────────────────────

const mockLastEvent = ref<WsEvent | null>(null)
const mockSendJson = vi.fn()

// Pinia stores auto-unwrap refs; mimic that with reactive() so that
// watch(() => ws.lastEvent, ...) inside the composable tracks updates.
vi.mock('../stores/ws-store.js', async () => {
  const { reactive } = await import('vue')
  return {
    useWsStore: () =>
      reactive({
        get lastEvent() {
          return mockLastEvent.value
        },
        sendJson: mockSendJson,
      }),
  }
})

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCompileEvent(type: string, compileId = 'c-1', extra: Record<string, unknown> = {}): WsEvent {
  return { type, compileId, ...extra }
}

async function push(event: WsEvent): Promise<void> {
  mockLastEvent.value = { ...event }
  await nextTick()
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('useCompileStream', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockLastEvent.value = null
    mockSendJson.mockClear()
  })

  // ── subscribe / unsubscribe framing ───────────────────────────────────────

  describe('subscribe / unsubscribe framing', () => {
    it('sends subscribe:compile on subscribe()', () => {
      const { subscribe } = useCompileStream()
      subscribe('c-42')
      expect(mockSendJson).toHaveBeenCalledWith({ type: 'subscribe:compile', compileId: 'c-42' })
    })

    it('trims whitespace from compileId', () => {
      const { subscribe } = useCompileStream()
      subscribe('  c-42  ')
      expect(mockSendJson).toHaveBeenCalledWith({ type: 'subscribe:compile', compileId: 'c-42' })
    })

    it('ignores blank compileId', () => {
      const { subscribe } = useCompileStream()
      subscribe('   ')
      expect(mockSendJson).not.toHaveBeenCalled()
    })

    it('sets status to subscribing immediately', () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      expect(run.value.status).toBe('subscribing')
      expect(run.value.compileId).toBe('c-1')
    })

    it('unsubscribes previous compile when subscribing to a new one', () => {
      const { subscribe } = useCompileStream()
      subscribe('c-1')
      mockSendJson.mockClear()
      subscribe('c-2')
      expect(mockSendJson).toHaveBeenCalledWith({ type: 'unsubscribe:compile', compileId: 'c-1' })
      expect(mockSendJson).toHaveBeenCalledWith({ type: 'subscribe:compile', compileId: 'c-2' })
    })

    it('does not unsubscribe when re-subscribing same compileId', () => {
      const { subscribe } = useCompileStream()
      subscribe('c-1')
      mockSendJson.mockClear()
      subscribe('c-1')
      // Only the subscribe call, no unsubscribe
      const unsubCalls = mockSendJson.mock.calls.filter(([a]) => a.type === 'unsubscribe:compile')
      expect(unsubCalls.length).toBe(0)
    })

    it('sends unsubscribe:compile on unsubscribe()', () => {
      const { subscribe, unsubscribe } = useCompileStream()
      subscribe('c-1')
      mockSendJson.mockClear()
      unsubscribe()
      expect(mockSendJson).toHaveBeenCalledWith({ type: 'unsubscribe:compile', compileId: 'c-1' })
    })

    it('unsubscribe() is a no-op when not subscribed', () => {
      const { unsubscribe } = useCompileStream()
      unsubscribe()
      expect(mockSendJson).not.toHaveBeenCalled()
    })
  })

  // ── stage progression ─────────────────────────────────────────────────────

  describe('stage progression', () => {
    it('starts with all stages pending', () => {
      const { run } = useCompileStream()
      expect(run.value.stages.every((s) => s.status === 'pending')).toBe(true)
      expect(run.value.stages.length).toBe(6)
    })

    it('transitions to running on first stage event', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_started', 'c-1', { inputKind: 'skill-chain' }))
      expect(run.value.status).toBe('running')
    })

    it('sets started stage to active', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_started', 'c-1'))
      const started = run.value.stages.find((s) => s.stage === 'started')!
      expect(started.status).toBe('active')
    })

    it('marks completed stage as done and sets status completed', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_started', 'c-1'))
      await push(makeCompileEvent('flow:compile_parsed', 'c-1'))
      await push(makeCompileEvent('flow:compile_shape_validated', 'c-1'))
      await push(makeCompileEvent('flow:compile_semantic_resolved', 'c-1'))
      await push(makeCompileEvent('flow:compile_lowered', 'c-1', { target: 'skill-chain', nodeCount: 3 }))
      await push(makeCompileEvent('flow:compile_completed', 'c-1', { target: 'skill-chain', durationMs: 120 }))
      expect(run.value.status).toBe('completed')
      expect(run.value.stages.find((s) => s.stage === 'completed')?.status).toBe('done')
    })

    it('sets target and durationMs from completed event', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_completed', 'c-1', { target: 'workflow-builder', durationMs: 200 }))
      expect(run.value.target).toBe('workflow-builder')
      expect(run.value.durationMs).toBe(200)
    })

    it('closes earlier active stages when a later stage arrives', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_started', 'c-1'))
      await push(makeCompileEvent('flow:compile_parsed', 'c-1'))
      const started = run.value.stages.find((s) => s.stage === 'started')!
      expect(started.status).toBe('done')
    })

    it('captures stage-specific details', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_started', 'c-1', { inputKind: 'pipeline' }))
      const stage = run.value.stages.find((s) => s.stage === 'started')!
      expect(stage.details?.inputKind).toBe('pipeline')
    })

    it('captures nodeCount and edgeCount on lowered stage', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_lowered', 'c-1', { target: 'pipeline', nodeCount: 5, edgeCount: 4, warningCount: 1 }))
      const stage = run.value.stages.find((s) => s.stage === 'lowered')!
      expect(stage.details?.nodeCount).toBe(5)
      expect(stage.details?.edgeCount).toBe(4)
      expect(run.value.warningCount).toBe(1)
    })
  })

  // ── flow:compile_failed ───────────────────────────────────────────────────

  describe('flow:compile_failed', () => {
    it('sets status to failed', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_started', 'c-1'))
      await push(makeCompileEvent('flow:compile_failed', 'c-1', { stage: 2, errorCount: 3, durationMs: 50 }))
      expect(run.value.status).toBe('failed')
    })

    it('records errorCount and durationMs on failure', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_failed', 'c-1', { errorCount: 4, durationMs: 80 }))
      expect(run.value.errorCount).toBe(4)
      expect(run.value.durationMs).toBe(80)
    })

    it('sets failure detail with stage number', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_failed', 'c-1', { stage: 3, errorCount: 2, durationMs: 60 }))
      expect(run.value.failure?.stage).toBe(3)
      expect(run.value.failure?.errorCount).toBe(2)
    })

    it('marks active stage as failed on compile_failed', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_parsed', 'c-1'))
      await push(makeCompileEvent('flow:compile_failed', 'c-1', { stage: 2 }))
      const active = run.value.stages.find((s) => s.status === 'active')
      expect(active).toBeUndefined()
      const failed = run.value.stages.filter((s) => s.status === 'failed')
      expect(failed.length).toBeGreaterThan(0)
    })

    it('isRunning is false after compile_failed', async () => {
      const { isRunning, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_failed', 'c-1', { errorCount: 1 }))
      expect(isRunning.value).toBe(false)
    })
  })

  // ── early-exit on compileId mismatch ─────────────────────────────────────

  describe('compileId mismatch', () => {
    it('ignores events for a different compileId', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_started', 'c-WRONG'))
      expect(run.value.status).toBe('subscribing')
    })

    it('ignores events when no compileId is set', async () => {
      const { run } = useCompileStream()
      await push(makeCompileEvent('flow:compile_started', 'c-1'))
      expect(run.value.status).toBe('idle')
    })

    it('processes events after re-subscribe to new compileId', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_completed', 'c-1', { target: 'pipeline', durationMs: 10 }))
      subscribe('c-2')
      expect(run.value.status).toBe('subscribing')
      expect(run.value.compileId).toBe('c-2')
      await push(makeCompileEvent('flow:compile_started', 'c-2'))
      expect(run.value.status).toBe('running')
    })
  })

  // ── reset ─────────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('clears all state without sending WS messages', async () => {
      const { run, subscribe, reset } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_started', 'c-1'))
      mockSendJson.mockClear()
      reset()
      expect(run.value.status).toBe('idle')
      expect(run.value.compileId).toBeNull()
      expect(run.value.stages.every((s) => s.status === 'pending')).toBe(true)
      expect(mockSendJson).not.toHaveBeenCalled()
    })
  })

  // ── isRunning ─────────────────────────────────────────────────────────────

  describe('isRunning', () => {
    it('is false initially', () => {
      const { isRunning } = useCompileStream()
      expect(isRunning.value).toBe(false)
    })

    it('is true while subscribing', () => {
      const { isRunning, subscribe } = useCompileStream()
      subscribe('c-1')
      expect(isRunning.value).toBe(true)
    })

    it('is true while running', async () => {
      const { isRunning, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_started', 'c-1'))
      expect(isRunning.value).toBe(true)
    })

    it('is false after completed', async () => {
      const { isRunning, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_completed', 'c-1', { target: 'skill-chain', durationMs: 50 }))
      expect(isRunning.value).toBe(false)
    })
  })

  // ── errorCount / warningCount accumulation ────────────────────────────────

  describe('error and warning accumulation', () => {
    it('accumulates errorCount across stages (takes max)', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_parsed', 'c-1', { errorCount: 1 }))
      await push(makeCompileEvent('flow:compile_shape_validated', 'c-1', { errorCount: 3 }))
      expect(run.value.errorCount).toBe(3)
    })

    it('records warningCount from lowered stage', async () => {
      const { run, subscribe } = useCompileStream()
      subscribe('c-1')
      await push(makeCompileEvent('flow:compile_lowered', 'c-1', { warningCount: 2 }))
      expect(run.value.warningCount).toBe(2)
    })
  })
})
