export type FlowPrimitive = string | number | boolean | null
export type FlowValue = FlowPrimitive | FlowValue[] | { [key: string]: FlowValue }

export interface FlowNodeBase {
  /**
   * Stable node identifier. Optional at the low-level AST layer for backward
   * compatibility with existing compiler fixtures; required by
   * `FlowDocumentV1` validation for canonical authored flows.
   */
  id?: string
  name?: string
  description?: string
  meta?: Record<string, unknown>
}

export interface FlowInputSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'
  required?: boolean
  description?: string
  default?: FlowValue
}

export interface FlowDefaults {
  personaRef?: string
  timeoutMs?: number
  retry?: {
    attempts: number
    delayMs?: number
  }
}

export type FlowNode =
  | SequenceNode
  | ActionNode
  | ForEachNode
  | BranchNode
  | ApprovalNode
  | ClarificationNode
  | PersonaNode
  | RouteNode
  | ParallelNode
  | CompleteNode
  | SpawnNode
  | ClassifyNode
  | EmitNode
  | MemoryNode
  | CheckpointNode
  | RestoreNode

export type SequenceNode = FlowNodeBase & { type: 'sequence'; nodes: FlowNode[] }
export type ActionNode = FlowNodeBase & {
  type: 'action'
  toolRef: string
  input: Record<string, unknown>
  personaRef?: string
}
export type ForEachNode = FlowNodeBase & {
  type: 'for_each'
  source: string
  as: string
  body: FlowNode[]
}
export type BranchNode = FlowNodeBase & {
  type: 'branch'
  condition: string
  then: FlowNode[]
  else?: FlowNode[]
}
export type ApprovalNode = FlowNodeBase & {
  type: 'approval'
  question: string
  options?: string[]
  onApprove: FlowNode[]
  onReject?: FlowNode[]
}
export type ClarificationNode = FlowNodeBase & {
  type: 'clarification'
  question: string
  expected?: 'text' | 'choice'
  choices?: string[]
}
export type PersonaNode = FlowNodeBase & {
  type: 'persona'
  personaId: string
  body: FlowNode[]
}
export type RouteNode = FlowNodeBase & {
  type: 'route'
  strategy: 'capability' | 'fixed-provider'
  tags?: string[]
  provider?: string
  body: FlowNode[]
}
export type ParallelNode = FlowNodeBase & { type: 'parallel'; branches: FlowNode[][] }
export type CompleteNode = FlowNodeBase & { type: 'complete'; result?: string }
export type SpawnNode = FlowNodeBase & {
  type: 'spawn'
  templateRef: string
  input?: Record<string, unknown>
  waitForCompletion?: boolean
}
export type ClassifyNode = FlowNodeBase & {
  type: 'classify'
  prompt: string
  choices: string[]
  outputKey: string
}
export type EmitNode = FlowNodeBase & {
  type: 'emit'
  /** Event name emitted at runtime, e.g. "task.completed", "plan.approved". */
  event: string
  /** Static payload merged with run state (runId, tenantId) at emit time. */
  payload?: Record<string, unknown>
}
export type MemoryNode = FlowNodeBase & {
  type: 'memory'
  operation: 'read' | 'write' | 'list'
  tier: 'session' | 'project' | 'workspace'
  key?: string
  valueExpr?: string
  outputVar?: string
}
export type CheckpointNode = FlowNodeBase & {
  type: 'checkpoint'
  /** Human name e.g. "after login page verified". */
  label?: string
  /** Node id whose output should be snapshotted into the checkpoint. */
  captureOutputOf: string
}
export type RestoreNode = FlowNodeBase & {
  type: 'restore'
  /** Matches a CheckpointNode's label in the same flow. */
  checkpointLabel: string
  /** Behavior when the named checkpoint does not exist at runtime. Defaults to 'fail'. */
  onNotFound?: 'fail' | 'skip'
}

export interface FlowDocumentV1 {
  dsl: 'dzupflow/v1'
  id: string
  title?: string
  description?: string
  version: number
  inputs?: Record<string, FlowInputSpec>
  defaults?: FlowDefaults
  tags?: string[]
  meta?: Record<string, unknown>
  root: SequenceNode
}

// Validation errors produced by Stage 3 semantic validator
export interface ValidationError {
  nodeType: FlowNode['type']
  nodePath: string       // dot-notation path in the AST, e.g. "root.nodes[2].body[0]"
  code: ValidationErrorCode
  message: string
}

export type ValidationErrorCode =
  | 'UNRESOLVED_TOOL_REF'
  | 'UNRESOLVED_PERSONA_REF'
  | 'EMPTY_BODY'
  | 'INVALID_CONDITION'
  | 'MISSING_REQUIRED_FIELD'
  | 'DUPLICATE_NODE_ID'
  | 'RESOLVER_INFRA_ERROR'

/**
 * Resolves opaque tool/skill/workflow references emitted by flow-ast
 * into concrete, callable metadata during flow-compiler Stage 3
 * (semantic validation).
 *
 * Implementations typically wrap SkillRegistry + WorkflowRegistry +
 * MCPClient + any AgentRegistry facade. Resolution must be synchronous
 * from the compiler's perspective — if async lookup is required, it
 * should be pre-warmed before compile() is invoked.
 */
export interface ToolResolver {
  /**
   * Look up a reference by name. Returns `null` (not throws) for unknown
   * references so the compiler can aggregate all unresolved refs into a
   * single validation error report instead of failing on the first miss.
   */
  resolve(ref: string): ResolvedTool | null

  /**
   * Enumerate every ref the resolver currently knows about. Used by the
   * compiler to produce "did you mean …?" diagnostics and by tooling
   * (LSP / pretty-printer) to offer completions.
   */
  listAvailable(): string[]
}

/**
 * Async variant of {@link ToolResolver} for registries whose lookup
 * cannot be pre-warmed: remote agent registries, lazy MCP bootstrap,
 * database-backed skill stores.
 *
 * Stage 3 semantic resolution accepts `ToolResolver | AsyncToolResolver`
 * and awaits the result when `resolve()` returns a Promise (duck-typed —
 * no `kind` brand per Wave 11 ADR §3.3). `listAvailable()` remains
 * synchronous — resolvers that cannot enumerate synchronously must cache
 * their catalogue internally and refresh it out-of-band (TTL, LISTEN/NOTIFY,
 * etc.). The compiler calls `listAvailable()` only when emitting suggestions
 * and cannot tolerate a per-suggestion network round-trip.
 *
 * Prefer the synchronous {@link ToolResolver} for in-memory fixtures and
 * pre-warmed registries — there is no benefit to paying the await cost.
 */
export interface AsyncToolResolver {
  /**
   * Look up a reference by name. Returns `null` (not throws) for unknown
   * references so the compiler can aggregate every unresolved ref into a
   * single validation report. Rejection is reserved for infrastructure
   * failure (network, DB) — it surfaces as a Stage 3 error with code
   * `RESOLVER_INFRA_ERROR`.
   */
  resolve(ref: string): Promise<ResolvedTool | null>

  /**
   * Enumerate every ref currently in the resolver's catalogue.
   * MUST be synchronous. See interface-level JSDoc for rationale.
   */
  listAvailable(): string[]
}

export type ResolvedToolKind = 'mcp-tool' | 'skill' | 'workflow' | 'agent'

export interface ResolvedTool {
  /** The original opaque ref string as it appeared in the flow source. */
  ref: string
  /** What the ref actually points at — drives compiler lowering choices. */
  kind: ResolvedToolKind
  /** JSON-Schema (or Zod-derived schema) describing accepted input. */
  inputSchema: unknown
  /** Optional JSON-Schema for declared output shape. */
  outputSchema?: unknown
  /** Opaque, stable handle the runtime uses to invoke the resolved entity. */
  handle: unknown
}
