/**
 * @dzupagent/agent/compat — transitional compatibility facade.
 *
 * This subpath collects APIs that remain available for existing consumers but
 * should not define the stable root contract. Prefer the runtime, workflow,
 * and tools subpaths for new imports.
 */

export { serializeMessages, deserializeMessages } from './agent/agent-state.js'
export type {
  AgentStateSnapshot as LegacyAgentStateSnapshot,
  SerializedMessage as LegacySerializedMessage,
} from './agent/agent-state.js'
export * from './instructions/index.js'
export * from './playground/index.js'
export * from './presets/index.js'
export * from './reflection/index.js'
export * from './recovery/index.js'
export * from './self-correction/reflection-loop.js'
export * from './self-correction/iteration-controller.js'
export * from './self-correction/self-correcting-node.js'
export * from './self-correction/error-detector.js'
export * from './self-correction/root-cause-analyzer.js'
export * from './self-correction/verification-protocol.js'
export * from './self-correction/self-learning-runtime.js'
export * from './self-correction/self-learning-hook.js'
export * from './self-correction/post-run-analyzer.js'
export * from './self-correction/adaptive-prompt-enricher.js'
export * from './self-correction/pipeline-stuck-detector.js'
export * from './self-correction/trajectory-calibrator.js'
export * from './self-correction/observability-bridge.js'
export * from './self-correction/strategy-selector.js'
export * from './self-correction/recovery-feedback.js'
export * from './self-correction/performance-optimizer.js'
export * from './self-correction/langgraph-middleware.js'
export * from './self-correction/feedback-collector.js'
export * from './self-correction/learning-dashboard.js'

