/**
 * Pipeline definition types — discriminated unions for nodes, edges,
 * and the top-level pipeline definition.
 *
 * All types are JSON-serializable (no functions, no classes, no Date objects).
 *
 * @module pipeline/pipeline-definition
 */

// ---------------------------------------------------------------------------
// Node types — discriminated union on `type`
// ---------------------------------------------------------------------------

/**
 * Per-node retry policy override. When set, these values take precedence
 * over the global pipeline-level retry policy for this node.
 *
 * Kept inline (rather than imported) to avoid circular dependencies
 * between core and agent packages.
 */
export interface NodeRetryPolicy {
  /** Initial backoff delay in ms */
  initialBackoffMs?: number
  /** Maximum backoff delay in ms */
  maxBackoffMs?: number
  /** Backoff multiplier */
  multiplier?: number
  /** Alias for `multiplier` */
  backoffMultiplier?: number
  /** Add random jitter (0-50%) to backoff delay */
  jitter?: boolean
  /**
   * Error patterns that are retryable.
   * - `string` values match via `error.includes(pattern)`
   * - `RegExp` values match via `pattern.test(error)`
   */
  retryableErrors?: Array<string | RegExp>
}

export interface PipelineNodeBase {
  /** Unique identifier within the pipeline */
  id: string
  /** Discriminator for the node type */
  type: string
  /** Optional human-readable name */
  name?: string
  /** Optional description of what this node does */
  description?: string
  /** Maximum execution time in milliseconds */
  timeoutMs?: number
  /** Number of retries on failure (0 = no retries) */
  retries?: number
  /**
   * Per-node retry policy override. When set, values here take precedence
   * over the global pipeline-level retry policy for this specific node.
   * The `retries` field above still controls max retry count.
   */
  retryPolicy?: NodeRetryPolicy
}

export interface AgentNode extends PipelineNodeBase {
  type: 'agent'
  /** ID of the agent to invoke */
  agentId: string
  /** Optional agent configuration overrides */
  config?: Record<string, unknown>
}

export interface ToolNode extends PipelineNodeBase {
  type: 'tool'
  /** Name of the tool to invoke */
  toolName: string
  /** Static arguments to pass to the tool */
  arguments?: Record<string, unknown>
}

export interface TransformNode extends PipelineNodeBase {
  type: 'transform'
  /** Registered transform function name */
  transformName: string
}

export interface GateNode extends PipelineNodeBase {
  type: 'gate'
  /** Type of gate check */
  gateType: 'approval' | 'budget' | 'quality'
  /** Optional condition expression */
  condition?: string
}

export interface ForkNode extends PipelineNodeBase {
  type: 'fork'
  /** ID shared with the corresponding JoinNode */
  forkId: string
}

export interface JoinNode extends PipelineNodeBase {
  type: 'join'
  /** ID of the corresponding ForkNode */
  forkId: string
  /** How to merge results from parallel branches */
  mergeStrategy?: 'all' | 'first' | 'majority'
}

export interface LoopNode extends PipelineNodeBase {
  type: 'loop'
  /** Node IDs that form the loop body */
  bodyNodeIds: string[]
  /** Maximum number of iterations before stopping */
  maxIterations: number
  /** Registered predicate function name evaluated after each iteration */
  continuePredicateName: string
  /** Whether to throw when maxIterations is reached (default: false) */
  failOnMaxIterations?: boolean
}

export interface SuspendNode extends PipelineNodeBase {
  type: 'suspend'
  /** Optional condition that must be met for automatic resume */
  resumeCondition?: string
}

/**
 * Discriminated union of all 8 pipeline node types.
 */
export type PipelineNode =
  | AgentNode
  | ToolNode
  | TransformNode
  | GateNode
  | ForkNode
  | JoinNode
  | LoopNode
  | SuspendNode

// ---------------------------------------------------------------------------
// Edge types — discriminated union on `type`
// ---------------------------------------------------------------------------

export interface SequentialEdge {
  type: 'sequential'
  sourceNodeId: string
  targetNodeId: string
}

export interface ConditionalEdge {
  type: 'conditional'
  sourceNodeId: string
  /** Registered predicate function name */
  predicateName: string
  /** Map of predicate return value -> target node ID */
  branches: Record<string, string>
}

export interface ErrorEdge {
  type: 'error'
  sourceNodeId: string
  targetNodeId: string
  /** Optional list of error codes that trigger this edge (all errors if omitted) */
  errorCodes?: string[]
}

/**
 * Discriminated union of all 3 pipeline edge types.
 */
export type PipelineEdge = SequentialEdge | ConditionalEdge | ErrorEdge

// ---------------------------------------------------------------------------
// Checkpoint strategy
// ---------------------------------------------------------------------------

export type CheckpointStrategy = 'after_each_node' | 'on_suspend' | 'manual' | 'none'

// ---------------------------------------------------------------------------
// Pipeline definition
// ---------------------------------------------------------------------------

/**
 * Complete pipeline definition — fully JSON-serializable.
 *
 * Describes a DAG of nodes connected by edges with optional budget limits,
 * checkpoint strategy, and metadata.
 */
export interface PipelineDefinition {
  /** Unique pipeline identifier */
  id: string
  /** Human-readable name */
  name: string
  /** Semantic version of this pipeline definition */
  version: string
  /** Optional description */
  description?: string
  /** Schema version for forward compatibility */
  schemaVersion: '1.0.0'
  /** ID of the first node to execute */
  entryNodeId: string
  /** All nodes in the pipeline */
  nodes: PipelineNode[]
  /** All edges connecting nodes */
  edges: PipelineEdge[]
  /** Maximum cost in cents before the pipeline is halted */
  budgetLimitCents?: number
  /** Maximum token usage before the pipeline is halted */
  tokenLimit?: number
  /** When to create checkpoints */
  checkpointStrategy?: CheckpointStrategy
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>
  /** Tags for categorization / filtering */
  tags?: string[]
}

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

export interface PipelineValidationError {
  /** Machine-readable error code */
  code: string
  /** Human-readable error message */
  message: string
  /** Node ID where the error occurred (if applicable) */
  nodeId?: string
  /** Edge index where the error occurred (if applicable) */
  edgeIndex?: number
}

export interface PipelineValidationWarning {
  /** Machine-readable warning code */
  code: string
  /** Human-readable warning message */
  message: string
  /** Node ID where the warning applies (if applicable) */
  nodeId?: string
}

export interface PipelineValidationResult {
  /** Whether the pipeline definition is valid */
  valid: boolean
  /** Errors that prevent execution */
  errors: PipelineValidationError[]
  /** Non-blocking warnings */
  warnings: PipelineValidationWarning[]
}
