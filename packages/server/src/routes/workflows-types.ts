/**
 * Type definitions and shared constants for workflow execution routes.
 */
import type { SkillRegistry, WorkflowRegistry } from '@dzupagent/core/pipeline'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { SkillStepResolver } from '@dzupagent/agent'
import type { CompilationTarget } from '@dzupagent/flow-compiler'
import type { ToolResolver, AsyncToolResolver } from '@dzupagent/flow-ast'
import type { PersonaResolver, AsyncPersonaResolver } from '@dzupagent/flow-compiler'
import type { PersonaStore } from '../personas/persona-store.js'

export interface WorkflowRouteConfig {
  /** Core SkillRegistry used for chain validation and resolver lookups. */
  skillRegistry?: SkillRegistry
  /** Optional WorkflowRegistry for named workflow lookup. */
  workflowRegistry?: WorkflowRegistry
  /** Skill step resolver that turns skill IDs into executable WorkflowSteps. */
  resolver?: SkillStepResolver
  /** EventBus for workflow event bridging. */
  eventBus?: DzupEventBus
  /**
   * Optional flow-compiler resolvers used by the compiled-flow execution path.
   * Mirrors the shape of `CompileRouteConfig` — when omitted, a no-op tool
   * resolver is used (and tool refs surface as stage-3 errors). When
   * `personaResolver` is omitted but `personaStore` is provided, the route
   * derives a resolver from the store.
   */
  compile?: {
    toolResolver?: ToolResolver | AsyncToolResolver
    personaResolver?: PersonaResolver | AsyncPersonaResolver
    personaStore?: PersonaStore
  }
}

/** Body shape for POST /execute. */
export interface ExecuteWorkflowBody {
  text?: string
  flow?: unknown
  document?: unknown
  dsl?: unknown
  target?: unknown
  initialState?: Record<string, unknown>
}

/** Body shape for POST /dry-run. */
export interface DryRunBody {
  steps?: string[]
  text?: string
}

/** Sync no-op resolver used when the host has not wired a domain catalog yet. */
export const NOOP_TOOL_RESOLVER: ToolResolver = {
  resolve: () => null,
  listAvailable: () => [],
}

export const ALLOWED_TARGETS: readonly CompilationTarget[] = [
  'skill-chain',
  'workflow-builder',
  'pipeline',
] as const

export function isAllowedTarget(v: unknown): v is CompilationTarget {
  return typeof v === 'string' && (ALLOWED_TARGETS as readonly string[]).includes(v)
}
