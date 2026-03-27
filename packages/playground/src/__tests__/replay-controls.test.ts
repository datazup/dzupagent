/**
 * Tests for useReplayControls composable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { useReplayControls, type ReplaySpeed } from '../composables/useReplayControls.js'

/**
 * Helper: run the composable outside a component context.
 * We mock onUnmounted since we are not in a real component lifecycle.
 */
vi.mock('vue', async () => {
  const actual = await vi.importActual<typeof import('vue')>('vue')
  return {
    ...actual,
    onUnmounted: vi.fn((cb: () => void) => {
      // Store cleanup callback for manual invocation in tests
      cleanupCallbacks.push(cb)
    }),
  }
})

const cleanupCallbacks: Array<() => void> = []

describe('useReplayControls', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    cleanupCallbacks.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('initializes with inactive state', () => {
    const totalSteps = ref(5)
    const replay = useReplayControls(totalSteps)

    expect(replay.isPlaying.value).toBe(false)
    expect(replay.currentIndex.value).toBe(-1)
    expect(replay.speed.value).toBe(1)
  })

  it('play() starts auto-advancing currentIndex', async () => {
    const totalSteps = ref(5)
    const replay = useReplayControls(totalSteps)

    replay.play()
    expect(replay.isPlaying.value).toBe(true)
    // Should start at index 0
    expect(replay.currentIndex.value).toBe(0)

    // Advance one tick (1000ms at 1x speed)
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(replay.currentIndex.value).toBe(1)

    // Advance another tick
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(replay.currentIndex.value).toBe(2)
  })

  it('pause() stops auto-advancing', async () => {
    const totalSteps = ref(10)
    const replay = useReplayControls(totalSteps)

    replay.play()
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(replay.currentIndex.value).toBe(1)

    replay.pause()
    expect(replay.isPlaying.value).toBe(false)

    // Timer should be stopped, index stays the same
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(replay.currentIndex.value).toBe(1)
  })

  it('stepForward() increments index clamped to totalSteps - 1', () => {
    const totalSteps = ref(3)
    const replay = useReplayControls(totalSteps)

    // First call activates replay at 0
    replay.stepForward()
    expect(replay.currentIndex.value).toBe(0)

    replay.stepForward()
    expect(replay.currentIndex.value).toBe(1)

    replay.stepForward()
    expect(replay.currentIndex.value).toBe(2)

    // At the end, should not advance past 2
    replay.stepForward()
    expect(replay.currentIndex.value).toBe(2)
  })

  it('stepBack() decrements index clamped to 0', () => {
    const totalSteps = ref(5)
    const replay = useReplayControls(totalSteps)

    replay.jumpTo(3)
    expect(replay.currentIndex.value).toBe(3)

    replay.stepBack()
    expect(replay.currentIndex.value).toBe(2)

    replay.stepBack()
    expect(replay.currentIndex.value).toBe(1)

    replay.stepBack()
    expect(replay.currentIndex.value).toBe(0)

    // At the start, should not go below 0
    replay.stepBack()
    expect(replay.currentIndex.value).toBe(0)
  })

  it('reset() returns currentIndex to -1 and stops playing', () => {
    const totalSteps = ref(5)
    const replay = useReplayControls(totalSteps)

    replay.play()
    expect(replay.isPlaying.value).toBe(true)
    expect(replay.currentIndex.value).toBe(0)

    replay.reset()
    expect(replay.currentIndex.value).toBe(-1)
    expect(replay.isPlaying.value).toBe(false)
  })

  it('setSpeed() changes the interval', async () => {
    const totalSteps = ref(10)
    const replay = useReplayControls(totalSteps)

    replay.play()
    expect(replay.currentIndex.value).toBe(0)

    // At 2x speed, interval should be 500ms
    replay.setSpeed(2)
    expect(replay.speed.value).toBe(2)

    vi.advanceTimersByTime(500)
    await nextTick()
    expect(replay.currentIndex.value).toBe(1)

    vi.advanceTimersByTime(500)
    await nextTick()
    expect(replay.currentIndex.value).toBe(2)
  })

  it('setSpeed(0.5) uses 2000ms interval', async () => {
    const totalSteps = ref(10)
    const replay = useReplayControls(totalSteps)

    replay.play()
    replay.setSpeed(0.5)

    // 1000ms should not be enough at 0.5x
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(replay.currentIndex.value).toBe(0)

    // At 2000ms it should advance
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(replay.currentIndex.value).toBe(1)
  })

  it('auto-pauses at the end', async () => {
    const totalSteps = ref(3)
    const replay = useReplayControls(totalSteps)

    replay.play()
    expect(replay.currentIndex.value).toBe(0)

    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(replay.currentIndex.value).toBe(1)

    vi.advanceTimersByTime(1000)
    await nextTick()
    // Should reach index 2 (last) and auto-pause
    expect(replay.currentIndex.value).toBe(2)
    expect(replay.isPlaying.value).toBe(false)

    // Should not go past the end
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(replay.currentIndex.value).toBe(2)
  })

  it('jumpTo() clamps to valid range', () => {
    const totalSteps = ref(5)
    const replay = useReplayControls(totalSteps)

    replay.jumpTo(3)
    expect(replay.currentIndex.value).toBe(3)

    replay.jumpTo(100)
    expect(replay.currentIndex.value).toBe(4) // totalSteps - 1

    replay.jumpTo(-5)
    expect(replay.currentIndex.value).toBe(0)
  })

  it('play() does nothing when totalSteps is 0', () => {
    const totalSteps = ref(0)
    const replay = useReplayControls(totalSteps)

    replay.play()
    expect(replay.isPlaying.value).toBe(false)
    expect(replay.currentIndex.value).toBe(-1)
  })

  it('stepForward() does nothing when totalSteps is 0', () => {
    const totalSteps = ref(0)
    const replay = useReplayControls(totalSteps)

    replay.stepForward()
    expect(replay.currentIndex.value).toBe(-1)
  })

  it('jumpTo() does nothing when totalSteps is 0', () => {
    const totalSteps = ref(0)
    const replay = useReplayControls(totalSteps)

    replay.jumpTo(3)
    expect(replay.currentIndex.value).toBe(-1)
  })

  it('play() restarts from 0 when already at the end', () => {
    const totalSteps = ref(3)
    const replay = useReplayControls(totalSteps)

    replay.jumpTo(2)
    expect(replay.currentIndex.value).toBe(2)

    replay.play()
    // Should restart from 0 since we were at the end
    expect(replay.currentIndex.value).toBe(0)
    expect(replay.isPlaying.value).toBe(true)
  })

  it('cleanup callback clears the timer', async () => {
    const totalSteps = ref(10)
    const replay = useReplayControls(totalSteps)

    replay.play()
    expect(replay.isPlaying.value).toBe(true)

    // Simulate unmount
    for (const cb of cleanupCallbacks) {
      cb()
    }

    // Timer should be cleared; advancing time should not change index
    const indexBefore = replay.currentIndex.value
    vi.advanceTimersByTime(5000)
    await nextTick()
    expect(replay.currentIndex.value).toBe(indexBefore)
  })

  it('setSpeed() does not restart timer when not playing', () => {
    const totalSteps = ref(10)
    const replay = useReplayControls(totalSteps)

    replay.jumpTo(2)
    replay.setSpeed(2 as ReplaySpeed)
    expect(replay.speed.value).toBe(2)
    expect(replay.isPlaying.value).toBe(false)

    // No auto-advance should happen
    vi.advanceTimersByTime(5000)
    expect(replay.currentIndex.value).toBe(2)
  })
})
