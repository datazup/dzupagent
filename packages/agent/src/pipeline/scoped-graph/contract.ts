import type { PipelineEdge, PipelineNode } from "@dzupagent/core/pipeline";
import type { NodeExecutionContext } from "@dzupagent/runtime-contracts";

import type { BudgetTrackerState } from "../executor-internals/iteration-budget-tracker.js";
import type { RunFrame } from "../executor-internals/run-frame.js";
import type {
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineState,
} from "../pipeline-runtime-types.js";

/** Definition-bound boundary for one closed, non-root graph traversal. */
export interface ScopedGraphBoundary {
  /** Stable owner identity used in diagnostics. */
  scopeId: string;
  /** Human-readable owner prefix; for example `Loop node \"poll\"`. */
  displayName: string;
  /** Loaded root definition identity that owns this boundary. */
  sourceDefinitionId: string;
  /** Private executor definition identity for this traversal. */
  scopedDefinitionId: string;
  /** Name used for the closed node inventory in corruption diagnostics. */
  nodeInventoryName: string;
  entryNodeId: string;
  nodeIds: readonly string[];
  normalExitNodeIds: readonly string[];
  suspendedExitNodeIds: readonly string[];
  terminalExitNodeIds: readonly string[];
  errorExitNodeIds: readonly string[];
  suspensionSiteNodeIds?: readonly string[];
}

/** Loaded nodes and edges for a definition-bound scoped traversal. */
export interface ScopedGraphCheckpointDefinition {
  boundary: ScopedGraphBoundary;
  nodes: readonly PipelineNode[];
  outgoingEdges: ReadonlyMap<string, PipelineEdge[]>;
  errorEdges: ReadonlyMap<string, PipelineEdge[]>;
}

export type ScopedGraphCheckpointOutcome =
  | { kind: "normal"; exitNodeId: string }
  | { kind: "suspended"; exitNodeId: string }
  | { kind: "terminal"; exitNodeId: string };

/**
 * Generic durable frame consumed by the scoped graph kernel.
 *
 * The field set and order deliberately match the existing loop-body graph
 * wire contract. Owners adapt through {@link ScopedGraphFrameCodec}; the
 * kernel does not add a scope tag or schema field to retained bytes.
 */
export interface ScopedGraphCheckpointFrame {
  completed: boolean;
  nextNodeId?: string;
  outcome?: ScopedGraphCheckpointOutcome;
  completedNodeIds: string[];
  nodeResults: Record<string, NodeResult>;
  nodeIdempotencyKeys: Record<string, string>;
  forkState?: RunFrame["forkState"];
}

/** Identity-preserving owner adapter for an existing retained-frame shape. */
export interface ScopedGraphFrameCodec<TFrame> {
  decode(frame: TFrame): ScopedGraphCheckpointFrame;
  encode(frame: ScopedGraphCheckpointFrame): TFrame;
}

export type ScopedGraphExecutionOutcome =
  | { kind: "normal"; exitNodeId: string }
  | { kind: "suspended"; exitNodeId: string }
  | { kind: "terminal"; exitNodeId: string }
  | { kind: "cancelled" }
  | { kind: "error"; error: string; exitNodeId?: string };

export interface ScopedGraphExecutionInput<TFrame> {
  scopedRunId: string;
  context: NodeExecutionContext;
  resumeFrame?: TFrame;
  onCheckpoint?: (
    frame: TFrame,
    options?: { mandatory?: boolean }
  ) => Promise<void>;
}

export interface ScopedGraphExecutionResult<TFrame> {
  outcome: ScopedGraphExecutionOutcome;
  state: PipelineState;
  nodeResults: ReadonlyMap<string, NodeResult>;
  lastResult?: NodeResult;
  error?: string;
  checkpointFrame?: TFrame;
}

export interface ScopedGraphExecutorCoordinator {
  getState(): PipelineState;
  setState(next: PipelineState): void;
  getRecoveryAttemptsUsed(): number;
  incrementRecoveryAttempts(): number;
  getBudgetTracker(): BudgetTrackerState;
}

export interface ScopedPipelineExecutorConstructor {
  new (
    config: PipelineRuntimeConfig,
    nodeMap: Map<string, PipelineNode>,
    outgoingEdges: Map<string, PipelineEdge[]>,
    errorEdges: Map<string, PipelineEdge[]>,
    coordinator: ScopedGraphExecutorCoordinator,
    checkpointOverride?: (
      frame: RunFrame,
      selectedNextNodeId?: string
    ) => Promise<void>
  ): {
    executeFromNode(
      input: RunFrame & { startNodeId: string }
    ): Promise<PipelineRunResult>;
  };
}

export interface ScopedGraphExecutorDeps {
  readonly config: PipelineRuntimeConfig;
  readonly coordinator: ScopedGraphExecutorCoordinator;
  readonly Executor: ScopedPipelineExecutorConstructor;
}
