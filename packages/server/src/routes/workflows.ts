/**
 * Workflow execution routes — thin re-export barrel.
 *
 * The implementation is split into focused sibling modules:
 *   - workflows-types.ts       — Config + body types, allowed targets, no-op resolver
 *   - workflows-validation.ts  — Persona resolver wiring helpers
 *   - workflows-streaming.ts   — Compiled-flow JSON + SSE branch (POST /execute)
 *   - workflows-handlers.ts    — Hono route factory and textual handlers
 *
 * Routes:
 *   POST /execute  — Execute a workflow. Two mutually-exclusive modes:
 *                    * { text: "..." }          — parse text → skill chain → result
 *                    * { flow: <FlowNode> }     — compile flow → skill chain → result
 *                    When Accept: text/event-stream is negotiated with a
 *                    flow body, execution events are streamed as SSE.
 *   POST /dry-run  — Validate a workflow without executing (dry-run check)
 *   GET  /stream   — SSE stream of textual workflow execution events
 *   GET  /         — List named workflows from WorkflowRegistry
 */
export type {
  WorkflowRouteConfig,
  ExecuteWorkflowBody,
  DryRunBody,
} from './workflows-types.js'
export { ALLOWED_TARGETS, NOOP_TOOL_RESOLVER, isAllowedTarget } from './workflows-types.js'
export { resolveCompilePersonaResolver } from './workflows-validation.js'
export { executeCompiledFlow } from './workflows-streaming.js'
export { createWorkflowRoutes } from './workflows-handlers.js'
