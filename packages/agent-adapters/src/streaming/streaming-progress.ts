import type { AgentEvent } from '../types.js'
import type { ProgressState, StreamOutputEvent } from './streaming-handler-types.js'

/** Assumed typical tool call count for progress estimation */
const TYPICAL_TOOL_CALLS = 10

/** Progress range allocated to the tool-calling phase (30% - 80%) */
const TOOL_PHASE_START = 30
const TOOL_PHASE_END = 80

export function createInitialStreamingProgress(): ProgressState {
  return {
    totalEvents: 0,
    toolCallCount: 0,
    messageCount: 0,
    startTime: 0,
    lastEventTime: 0,
    estimatedPercent: 0,
  }
}

export function updateStreamingProgress(progress: ProgressState, event: AgentEvent): void {
  const now = Date.now()
  progress.totalEvents++
  progress.lastEventTime = now

  if (progress.startTime === 0) {
    progress.startTime = now
  }

  switch (event.type) {
    case 'adapter:started':
      progress.estimatedPercent = 5
      break

    case 'adapter:message':
      progress.messageCount++
      if (progress.estimatedPercent < 20) {
        progress.estimatedPercent = 20
      }
      break

    case 'adapter:tool_call':
      progress.toolCallCount++
      progress.estimatedPercent = estimateToolProgress(progress)
      break

    case 'adapter:tool_result':
      progress.estimatedPercent = Math.min(progress.estimatedPercent + 2, TOOL_PHASE_END)
      break

    case 'adapter:stream_delta':
      if (progress.estimatedPercent < 20) {
        progress.estimatedPercent = 20
      }
      break

    case 'adapter:completed':
    case 'adapter:failed':
      progress.estimatedPercent = 100
      break
  }
}

export function createStreamingProgressEvent(progress: ProgressState): StreamOutputEvent {
  return {
    type: 'progress',
    timestamp: new Date().toISOString(),
    data: {
      type: 'progress',
      percent: progress.estimatedPercent,
      currentStep: describeCurrentStep(progress),
      totalSteps: undefined,
      tokensUsed: undefined,
    },
  }
}

function estimateToolProgress(progress: ProgressState): number {
  const ratio = Math.min(progress.toolCallCount / TYPICAL_TOOL_CALLS, 1)
  return Math.round(TOOL_PHASE_START + ratio * (TOOL_PHASE_END - TOOL_PHASE_START))
}

function describeCurrentStep(progress: ProgressState): string {
  if (progress.estimatedPercent <= 5) return 'initializing'
  if (progress.toolCallCount > 0) return `tool call #${progress.toolCallCount}`
  if (progress.messageCount > 0) return 'generating response'
  return 'processing'
}
