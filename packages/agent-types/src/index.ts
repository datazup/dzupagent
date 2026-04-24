/**
 * @dzupagent/agent-types — Layer 0 shared type primitives.
 *
 * Pure TypeScript interfaces consumed by higher layers (`@dzupagent/agent`,
 * `@dzupagent/agent-adapters`). This package MUST NOT import from any other
 * `@dzupagent/*` package to keep it at the bottom of the dependency graph.
 */

export type { StuckDetectorConfig } from './guardrails.js'
export type { RetryPolicy } from './retry.js'
export type {
  ToolScope,
  ToolPermissionEntry,
  ToolPermissionPolicy,
} from './tool-permission.js'
