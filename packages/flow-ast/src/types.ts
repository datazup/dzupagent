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

export type SequenceNode    = { type: 'sequence'; nodes: FlowNode[] }
export type ActionNode      = { type: 'action'; toolRef: string; input: Record<string, unknown>; personaRef?: string }
export type ForEachNode     = { type: 'for_each'; source: string; as: string; body: FlowNode[] }
export type BranchNode      = { type: 'branch'; condition: string; then: FlowNode[]; else?: FlowNode[] }
export type ApprovalNode    = { type: 'approval'; question: string; options?: string[]; onApprove: FlowNode[]; onReject?: FlowNode[] }
export type ClarificationNode = { type: 'clarification'; question: string; expected?: 'text' | 'choice'; choices?: string[] }
export type PersonaNode     = { type: 'persona'; personaId: string; body: FlowNode[] }
export type RouteNode       = { type: 'route'; strategy: 'capability' | 'fixed-provider'; tags?: string[]; provider?: string; body: FlowNode[] }
export type ParallelNode    = { type: 'parallel'; branches: FlowNode[][] }
export type CompleteNode    = { type: 'complete'; result?: string }

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
