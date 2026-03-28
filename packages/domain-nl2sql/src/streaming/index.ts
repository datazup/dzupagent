/**
 * Streaming utilities for the NL2SQL domain module.
 *
 * Provides the PipelineEventEmitter and all associated event types
 * for real-time SSE streaming of pipeline progress.
 *
 * @module @dzipagent/domain-nl2sql/streaming
 */

export {
  PipelineEventEmitter,
  type StageStartEvent,
  type StageCompleteEvent,
  type SQLChunkEvent,
  type ResultRowEvent,
  type PipelineErrorEvent,
  type PipelineDoneEvent,
  type PipelineEvent,
  type PipelineEventMap,
  type PipelineEventName,
} from './pipeline-event-emitter.js'
