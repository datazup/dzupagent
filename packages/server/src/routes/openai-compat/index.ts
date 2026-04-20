/**
 * OpenAI-compatible route module.
 *
 * Exports the enhanced completions route that addresses three gaps over the
 * original base implementation:
 *
 * - GAP-1: System message extraction (instructions composition)
 * - GAP-2: Streaming finish_reason='length' for iteration-limited responses
 * - GAP-3: Non-streaming tool_calls in response choice message
 *
 * Also re-exports the shared types, mapper, auth middleware, and models route
 * — these were previously housed under `src/openai/` but are now consolidated
 * here so that all OpenAI-compatible surface area lives in a single module.
 */
export { createOpenAICompatCompletionsRoute } from './completions.js'
export type { OpenAICompatCompletionsConfig } from './completions.js'

export {
  mapRequest,
  mapFinalStreamChunk,
  mapResponseWithTools,
  extractToolCallsFromMessages,
  validateCompletionRequest,
  generateCompletionId,
  badRequest,
  notFoundError,
  serverError,
} from './request-mapper.js'
export type {
  EnhancedMappedRequest,
  ResponseToolCall,
} from './request-mapper.js'

// Shared wire-format types (relocated from src/openai/)
export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatCompletionChunkWithTools,
  ModelObject,
  ModelListResponse,
  OpenAIErrorResponse,
  StreamingToolCallDelta,
  StreamingToolCallFunction,
} from './types.js'

// Base completion mapper (relocated from src/openai/)
export { OpenAICompletionMapper } from './completion-mapper.js'
export type { GenerateOptions, MappedRequest } from './completion-mapper.js'

// Models route (relocated from src/openai/)
export { createModelsRoute } from './models-route.js'
export type { ModelsRouteConfig } from './models-route.js'

// Auth middleware (relocated from src/openai/)
export { openaiAuthMiddleware } from './auth-middleware.js'
export type { OpenAIAuthConfig } from './auth-middleware.js'
