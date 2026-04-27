/**
 * @dzupagent/agent-adapters/http
 *
 * HTTP plane: handlers, request schemas, rate limiting, and SSE adapters.
 */

export { SlidingWindowRateLimiter } from './http/rate-limiter.js'
export type { RateLimitConfig } from './http/rate-limiter.js'

export { AdapterHttpHandler } from './http/adapter-http-handler.js'
export type {
  AdapterHttpConfig,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  HttpResult,
  RunRequestBody,
  SupervisorRequestBody,
  ParallelRequestBody,
  BidRequestBody,
  HealthResponse,
  TokenValidationResult,
} from './http/adapter-http-handler.js'

export {
  RunRequestSchema,
  SupervisorRequestSchema,
  ParallelRequestSchema,
  BidRequestSchema,
  ApproveRequestSchema,
} from './http/request-schemas.js'
export type {
  RunRequest,
  SupervisorRequest,
  ParallelRequest,
  BidRequest,
  ApproveRequest,
} from './http/request-schemas.js'
