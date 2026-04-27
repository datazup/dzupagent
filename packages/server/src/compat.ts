/**
 * @dzupagent/server/compat — OpenAI-compatible HTTP surface.
 *
 * This subpath isolates the OpenAI Chat Completions / Models compatibility
 * layer (request mapping, response shaping, auth middleware, error helpers)
 * from the core hosting contract. Hosts that do not need OpenAI compatibility
 * can ignore this subpath entirely.
 *
 * The root `@dzupagent/server` entrypoint continues to re-export these
 * symbols (deprecated) during the migration compatibility window.
 */

export {
  OpenAICompletionMapper,
  createOpenAICompatCompletionsRoute,
  createModelsRoute,
  openaiAuthMiddleware,
  mapRequest,
  mapFinalStreamChunk,
  mapResponseWithTools,
  extractToolCallsFromMessages,
  validateCompletionRequest,
  generateCompletionId,
  badRequest,
  notFoundError,
  serverError,
} from './routes/openai-compat/index.js'
export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ModelObject,
  ModelListResponse,
  OpenAIErrorResponse,
  GenerateOptions,
  MappedRequest,
  OpenAICompatCompletionsConfig,
  ModelsRouteConfig,
  OpenAIAuthConfig,
  EnhancedMappedRequest,
  ResponseToolCall,
} from './routes/openai-compat/index.js'
