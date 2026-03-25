/**
 * Trace store -- manages trace events for the inspector timeline.
 *
 * Collects events from WebSocket messages and displays them
 * as a color-coded timeline in the TraceTab.
 *
 * @module trace-store
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { TraceEvent } from '../types.js'

const MAX_EVENTS = 500

export const useTraceStore = defineStore('trace', () => {
  // ── State ─────────────────────────────────────────
  const events = ref<TraceEvent[]>([])

  // ── Getters ───────────────────────────────────────
  const eventCount = computed(() => events.value.length)

  const totalDurationMs = computed(() =>
    events.value.reduce((sum, e) => sum + e.durationMs, 0),
  )

  const eventsByType = computed(() => {
    const grouped: Record<string, TraceEvent[]> = {}
    for (const event of events.value) {
      const list = grouped[event.type]
      if (list) {
        list.push(event)
      } else {
        grouped[event.type] = [event]
      }
    }
    return grouped
  })

  // ── Actions ───────────────────────────────────────

  /** Add a trace event to the timeline */
  function addEvent(event: TraceEvent): void {
    if (events.value.length >= MAX_EVENTS) {
      events.value = events.value.slice(-Math.floor(MAX_EVENTS / 2))
    }
    events.value.push(event)
  }

  /** Clear all trace events */
  function clearEvents(): void {
    events.value = []
  }

  return {
    // State
    events,

    // Getters
    eventCount,
    totalDurationMs,
    eventsByType,

    // Actions
    addEvent,
    clearEvents,
  }
})
