import type { FlowNodeBase } from "./primitives.js";
import type {
  AgentNode,
  ValidateNode,
  WorkerDispatchNode,
  FleetDispatchNode,
  FleetGatherNode,
  FleetContractNetNode,
  KnowledgeWriteNode,
  KnowledgeQueryNode,
  ShellRunNode,
  EvidenceWriteNode,
  ValidateSchemaNode,
  AdapterRunNode,
  AdapterRaceNode,
  AdapterParallelNode,
  AdapterSupervisorNode,
} from "./agent-nodes.js";
import type {
  SpddImportSourcesNode,
  SpddBuildSourcePackNode,
  SpddRunAnalysisNode,
  SpddGenerateCanvasNode,
  SpddValidateCanvasNode,
  SpddReviewCanvasNode,
  SpddProjectPlanNode,
  SpddArmDispatchNode,
  SpddRunValidationNode,
  SpddCollectProofNode,
  SpddScanDriftNode,
  SpddCreateSyncProposalNode,
  SpddAgentSwarmNode,
} from "./spdd-nodes.js";

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
  | SetNode
  | CheckpointNode
  | RestoreNode
  | TryCatchNode
  | LoopNode
  | HttpNode
  | WaitNode
  | SubflowNode
  | PromptNode
  | ReturnToNode
  | AgentNode
  | ValidateNode
  | WorkerDispatchNode
  | FleetDispatchNode
  | FleetGatherNode
  | FleetContractNetNode
  | KnowledgeWriteNode
  | KnowledgeQueryNode
  | ShellRunNode
  | EvidenceWriteNode
  | ValidateSchemaNode
  | AdapterRunNode
  | AdapterRaceNode
  | AdapterParallelNode
  | AdapterSupervisorNode
  | SpddImportSourcesNode
  | SpddBuildSourcePackNode
  | SpddRunAnalysisNode
  | SpddGenerateCanvasNode
  | SpddValidateCanvasNode
  | SpddReviewCanvasNode
  | SpddProjectPlanNode
  | SpddArmDispatchNode
  | SpddRunValidationNode
  | SpddCollectProofNode
  | SpddScanDriftNode
  | SpddCreateSyncProposalNode
  | SpddAgentSwarmNode;

export type SequenceNode = FlowNodeBase & {
  type: "sequence";
  nodes: FlowNode[];
};
export type ActionNode = FlowNodeBase & {
  type: "action";
  toolRef: string;
  input: Record<string, unknown>;
  personaRef?: string;
};
export type ForEachNode = FlowNodeBase & {
  type: "for_each";
  source: string;
  as: string;
  body: FlowNode[];
  /** Write each item under this key on the item itself (enrichment mode). */
  attachAs?: string;
  /** Collect body output key `from` into array state key `into`. */
  collect?: {
    from: string;
    into: string;
  };
  /** Accumulate results across iterations in a state key. */
  accumulator?: {
    key: string;
    /** Keep last N results; omit for unbounded. */
    window?: number;
    initialValue?: unknown;
  };
  /** Run up to N iterations in parallel. Default 1 (sequential). Hard cap: 8. */
  concurrency?: number;
  /** Stop scheduling new iterations after the first item failure. Default false. */
  failFast?: boolean;
};
export type BranchNode = FlowNodeBase & {
  type: "branch";
  condition: string;
  then: FlowNode[];
  else?: FlowNode[];
};
export type ApprovalNodeClass =
  | "read_only"
  | "local_side_effect"
  | "destructive_shell"
  | "network_egress"
  | "mcp_external_side_effect"
  | "unknown";
export type ApprovalNode = FlowNodeBase & {
  type: "approval";
  question: string;
  /** Optional policy class. Omitted nodes remain explicit human gates. */
  approvalClass?: ApprovalNodeClass;
  options?: string[];
  onApprove: FlowNode[];
  onReject?: FlowNode[];
};
export type ClarificationNode = FlowNodeBase & {
  type: "clarification";
  question: string;
  expected?: "text" | "choice";
  choices?: string[];
};
export type PersonaNode = FlowNodeBase & {
  type: "persona";
  personaId: string;
  body: FlowNode[];
};
export type RouteNode = FlowNodeBase & {
  type: "route";
  strategy: "capability" | "fixed-provider";
  tags?: string[];
  provider?: string;
  body: FlowNode[];
};
export type ParallelNode = FlowNodeBase & {
  type: "parallel";
  branches: FlowNode[][];
};
export type CompleteNode = FlowNodeBase & { type: "complete"; result?: string };
export type SpawnNode = FlowNodeBase & {
  type: "spawn";
  templateRef: string;
  input?: Record<string, unknown>;
  waitForCompletion?: boolean;
};
export type ClassifyNode = FlowNodeBase & {
  type: "classify";
  prompt: string;
  choices: string[];
  outputKey: string;
  defaultChoice?: string;
};
export type EmitNode = FlowNodeBase & {
  type: "emit";
  /** Event name emitted at runtime, e.g. "task.completed", "plan.approved". */
  event: string;
  /** Static payload merged with run state (runId, tenantId) at emit time. */
  payload?: Record<string, unknown>;
};
export type MemoryNode = FlowNodeBase & {
  type: "memory";
  operation: "read" | "write" | "list" | "search";
  tier: "session" | "project" | "workspace";
  key?: string;
  valueExpr?: string;
  outputVar?: string;
  /** Search query template expression; required when operation === 'search'. */
  query?: string;
  /** Search result cap; default 10 at runtime. */
  limit?: number;
};
/**
 * Declarative state-mutation node. Merges resolved values from `assign` into
 * run state. No tool call, no LLM — pure local mutation. Template expressions
 * inside `assign` values are resolved at execution time.
 */
export type SetNode = FlowNodeBase & {
  type: "set";
  /** Map of state keys to values (literals or template expressions). */
  assign: Record<string, unknown>;
};
export type CheckpointNode = FlowNodeBase & {
  type: "checkpoint";
  /** Human name e.g. "after login page verified". */
  label?: string;
  /** Node id whose output should be snapshotted into the checkpoint. */
  captureOutputOf: string;
};
export type RestoreNode = FlowNodeBase & {
  type: "restore";
  /** Matches a CheckpointNode's label in the same flow. */
  checkpointLabel: string;
  /** Behavior when the named checkpoint does not exist at runtime. Defaults to 'fail'. */
  onNotFound?: "fail" | "skip";
};
/** Structured error recovery: executes `body`; on error runs `catch` branch. */
export type TryCatchNode = FlowNodeBase & {
  type: "try_catch";
  body: FlowNode[];
  catch: FlowNode[];
  /** State key written with the error message when catch branch runs. Defaults to "error". */
  errorVar?: string;
};
/** Condition-based loop: repeats `body` while `condition` evaluates truthy. */
export type LoopNode = FlowNodeBase & {
  type: "loop";
  /** Template expression evaluated against state before each iteration. */
  condition: string;
  body: FlowNode[];
  /** Maximum iterations (default 100, prevents infinite loops). */
  maxIterations?: number;
  /** Step ID to track for no-progress detection across iterations. */
  progressKey?: string;
};
/** Lightweight HTTP action node — calls an external URL without a registered skill. */
export type HttpNode = FlowNodeBase & {
  type: "http";
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  /** State key for the response body (default: node id or "httpResponse"). */
  outputVar?: string;
  /** Request timeout in milliseconds. Defaults to 30 000 ms when unset. */
  timeoutMs?: number;
};
/** Time-based delay / sleep before continuing. */
export type WaitNode = FlowNodeBase & {
  type: "wait";
  durationMs: number;
};
/** Inline another flow's steps into the current run with shared state. */
export type SubflowNode = FlowNodeBase & {
  type: "subflow";
  /** References a FlowDocumentV1.id. */
  flowRef: string;
  /** Input bindings merged into the child scope's state at entry. */
  input?: Record<string, unknown>;
  /** State key for the subflow's final state merge (default: subflow id or "subflowResult"). */
  outputVar?: string;
};
/** Direct LLM call — sends user prompt + optional system prompt and stores the text response. */
export type PromptNode = FlowNodeBase & {
  type: "prompt";
  /** User-facing prompt. Template expressions ({{ state.key }}) are resolved before invocation. */
  userPrompt: string;
  /** Optional system prompt override. When omitted, the active persona system prompt is used. */
  systemPrompt?: string;
  /** State key where the LLM response string is stored. Defaults to node.id ?? "promptResult". */
  outputKey?: string;
  /** Optional provider override (e.g. "claude", "openai", "openrouter"). */
  provider?: string;
  /** Optional model override (e.g. "claude-sonnet-4-6"). */
  model?: string;
  /** When true, the codev MCP server is wired so the LLM can call tools in a loop. Default false. */
  tools?: boolean;
};
/**
 * Loop-back jump — re-executes from a labeled ancestor node while a condition holds.
 * Equivalent to Flowise's "Loop" back-edge node. Compiles to a bounded-replay region.
 */
export type ReturnToNode = FlowNodeBase & {
  type: "return_to";
  /** ID of the preceding sibling node to jump back to when condition is truthy. */
  targetId: string;
  /** Template expression evaluated before each jump. Falsy → exit (no jump). */
  condition: string;
  /** Maximum number of jumps allowed (default 10). Hard safety ceiling. */
  maxIterations?: number;
};
