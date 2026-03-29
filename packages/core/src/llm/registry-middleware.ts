/**
 * Middleware system for ModelRegistry — enables caching, logging, and
 * other cross-cutting concerns around LLM invocations.
 */

/** Token usage reported by middleware (model-agnostic) */
export interface MiddlewareTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** Context passed to middleware before/after hooks */
export interface MiddlewareContext {
  messages: Array<{ role: string; content: string }>
  model: string
  temperature?: number
  maxTokens?: number
  provider?: string
  [key: string]: unknown
}

/** Result from a beforeInvoke middleware hook */
export interface MiddlewareResult {
  /** If true, skip LLM call and use response */
  cached: boolean
  response?: string
  usage?: { inputTokens: number; outputTokens: number }
}

/**
 * Registry middleware — intercepts LLM invocations for caching, logging, etc.
 *
 * Middlewares are executed in registration order:
 * - `beforeInvoke` is called before the LLM call. Return `{ cached: true, response }` to skip the call.
 * - `afterInvoke` is called after a successful LLM call. Use it to cache results.
 */
export interface RegistryMiddleware {
  /** Unique middleware name for diagnostics */
  name: string
  /** Called before LLM invocation. Return cached response to skip LLM call. */
  beforeInvoke?(context: MiddlewareContext): Promise<MiddlewareResult>
  /** Called after LLM invocation. Use to cache results. */
  afterInvoke?(context: MiddlewareContext, response: string, usage?: MiddlewareTokenUsage): Promise<void>
}
