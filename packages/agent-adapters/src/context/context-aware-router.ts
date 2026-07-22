/**
 * Context-aware routing strategy (composition root).
 *
 * Estimates context size from prompt content and injected context chunks,
 * then routes to providers with sufficient context windows. Also provides
 * middleware for injecting contextual data into prompts.
 *
 * The implementation is decomposed into per-concern leaf modules under
 * `context-aware-router/` (ARCH-M-06 god-module split); this file preserves the
 * exact public surface as a thin re-export barrel.
 */

export type {
  ContextAwareRouterConfig,
  ContextEstimate,
  ContextInjection,
  ContextInjectionConfig,
} from "./context-aware-router/types.js";
export { ContextAwareRouter } from "./context-aware-router/router.js";
export { ContextInjectionMiddleware } from "./context-aware-router/injection-middleware.js";
