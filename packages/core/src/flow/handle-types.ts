/**
 * Flow handle types — structural contracts for runtime-invocable entities
 * resolved by Stage 3 of the flow-compiler.
 *
 * Populated by registries (SkillRegistry, MCPClient, WorkflowRegistry,
 * AgentRegistry) via their ToolResolver / AsyncToolResolver adapters.
 * Consumed by Stage 4 lowerers in `@dzupagent/flow-compiler`.
 *
 * Handles are opaque-ish: they carry only the minimum the runtime needs
 * at lowering / invocation time (id + invoke signature + schema). The
 * compiler itself never dereferences the `invoke` / `execute` fields.
 *
 * See Wave 11 ADR §5 for the full contract rationale.
 */

import type { JSONSchema7 } from 'json-schema'

/**
 * Structural contract for a resolved skill. Populated by SkillRegistry
 * inside its ToolResolver/AsyncToolResolver adapter.
 */
export interface SkillHandle {
  readonly kind: 'skill'
  /** Stable skill identifier (namespace/name). */
  readonly id: string
  /** Human-readable display name, used in logs + pipeline nodes. */
  readonly displayName: string
  /**
   * Direct execute function. Lowerers wrap this into a ToolNode; the
   * runtime invokes it with validated input.
   */
  readonly execute: (input: unknown, ctx: SkillExecutionContext) => Promise<unknown>
  readonly inputSchema: JSONSchema7
  readonly outputSchema?: JSONSchema7
}

/**
 * Structural contract for a resolved MCP tool. Populated by the MCP
 * client tool-bridge adapter.
 */
export interface McpToolHandle {
  readonly kind: 'mcp-tool'
  /** Fully-qualified ref: `<serverId>/<toolName>`. */
  readonly id: string
  readonly serverId: string
  readonly toolName: string
  /**
   * Invoke the tool on the MCP server. Returns raw MCP content parts;
   * downstream nodes normalise.
   */
  readonly invoke: (input: unknown) => Promise<McpInvocationResult>
  readonly inputSchema: JSONSchema7
}

export interface McpInvocationResult {
  readonly content: ReadonlyArray<{ type: 'text' | 'json' | 'image'; value: unknown }>
  readonly isError: boolean
}

/**
 * Structural contract for a resolved workflow. Populated by
 * WorkflowRegistry. The compiler treats a workflow as an opaque
 * sub-pipeline invocable by reference.
 */
export interface WorkflowHandle {
  readonly kind: 'workflow'
  /** Workflow definition id (immutable across versions). */
  readonly id: string
  /** Active version number; lowerers pin to this. */
  readonly version: number
  /** Reference into PipelineDefinition storage — not the definition itself. */
  readonly definitionRef: string
  readonly inputSchema: JSONSchema7
  readonly outputSchema?: JSONSchema7
}

/**
 * Structural contract for a resolved agent. Populated by AgentRegistry.
 */
export interface AgentHandle {
  readonly kind: 'agent'
  readonly id: string
  readonly displayName: string
  /**
   * Invoke the agent as a tool-like callable. Matches the DzupAgent
   * `generate(input)` signature; lowerers wire this into an AgentNode.
   */
  readonly invoke: (input: AgentInvocation) => Promise<AgentInvocationResult>
}

export interface AgentInvocation {
  readonly prompt: string
  readonly context?: Record<string, unknown>
  readonly parentRunId?: string
}

export interface AgentInvocationResult {
  readonly output: unknown
  readonly runId: string
  readonly durationMs: number
}

/** Narrow discriminated union over all handle kinds. */
export type FlowHandle = SkillHandle | McpToolHandle | WorkflowHandle | AgentHandle

/** Minimal execution context threaded to SkillHandle.execute. */
export interface SkillExecutionContext {
  readonly runId: string
  readonly parentNodeId?: string
  readonly abortSignal?: AbortSignal
}
