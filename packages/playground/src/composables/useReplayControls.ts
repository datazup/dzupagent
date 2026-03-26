/**
 * Composable for managing trace timeline replay controls.
 *
 * Provides play/pause, step forward/back, speed control, and auto-advance
 * functionality for replaying trace events in the timeline.
 *
 * @module useReplayControls
 */
import { ref, watch, onUnmounted, type Ref } from 'vue'

/** Available playback speed multipliers */
export type ReplaySpeed = 0.5 | 1 | 2

/** Reactive replay state returned by useReplayControls */
export interface ReplayControls {
  /** Whether the replay is currently auto-advancing */
  isPlaying: Ref<boolean>
  /** Current replay position (-1 means replay is inactive) */
  currentIndex: Ref<number>
  /** Current playback speed multiplier */
  speed: Ref<ReplaySpeed>

  /** Start auto-advancing from the current index */
  play: () => void
  /** Stop auto-advancing */
  pause: () => void
  /** Advance one step forward (clamped to totalSteps - 1) */
  stepForward: () => void
  /** Go back one step (clamped to 0) */
  stepBack: () => void
  /** Reset replay to inactive state (currentIndex = -1) */
  reset: () => void
  /** Change the playback speed */
  setSpeed: (s: ReplaySpeed) => void
  /** Jump to a specific index (clamped to valid range) */
  jumpTo: (index: number) => void
}

/**
 * Create replay controls for stepping through a list of items.
 *
 * @param totalSteps - Reactive ref with the total number of steps available
 * @returns Replay control state and methods
 */
export function useReplayControls(totalSteps: Ref<number>): ReplayControls {
  const isPlaying = ref(false)
  const currentIndex = ref(-1)
  const speed = ref<ReplaySpeed>(1)

  let timer: ReturnType<typeof setInterval> | null = null

  /** Clear any running auto-advance timer */
  function clearTimer(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /** Start a new auto-advance timer at the current speed */
  function startTimer(): void {
    clearTimer()
    const intervalMs = Math.round(1000 / speed.value)
    timer = setInterval(() => {
      if (currentIndex.value >= totalSteps.value - 1) {
        pause()
        return
      }
      currentIndex.value += 1
    }, intervalMs)
  }

  /** Start auto-advancing from the current position */
  function play(): void {
    if (totalSteps.value === 0) return

    // If replay is not active or already at the end, start from 0
    if (currentIndex.value < 0 || currentIndex.value >= totalSteps.value - 1) {
      currentIndex.value = 0
    }

    isPlaying.value = true
    startTimer()
  }

  /** Pause auto-advancing */
  function pause(): void {
    isPlaying.value = false
    clearTimer()
  }

  /** Advance one step forward */
  function stepForward(): void {
    if (totalSteps.value === 0) return

    // Activate replay if not yet started
    if (currentIndex.value < 0) {
      currentIndex.value = 0
      return
    }

    if (currentIndex.value < totalSteps.value - 1) {
      currentIndex.value += 1
    }
  }

  /** Go back one step */
  function stepBack(): void {
    if (currentIndex.value > 0) {
      currentIndex.value -= 1
    }
  }

  /** Reset to inactive state */
  function reset(): void {
    pause()
    currentIndex.value = -1
  }

  /** Change playback speed and restart timer if playing */
  function setSpeed(s: ReplaySpeed): void {
    speed.value = s
    if (isPlaying.value) {
      startTimer()
    }
  }

  /** Jump to a specific index */
  function jumpTo(index: number): void {
    if (totalSteps.value === 0) return
    currentIndex.value = Math.max(0, Math.min(index, totalSteps.value - 1))
  }

  // Auto-pause when reaching the end
  watch(currentIndex, (idx) => {
    if (idx >= totalSteps.value - 1 && isPlaying.value) {
      pause()
    }
  })

  // Cleanup timer on unmount
  onUnmounted(() => {
    clearTimer()
  })

  return {
    isPlaying,
    currentIndex,
    speed,
    play,
    pause,
    stepForward,
    stepBack,
    reset,
    setSpeed,
    jumpTo,
  }
}
