export type FlowPrimitive = string | number | boolean | null;
export type FlowValue =
  | FlowPrimitive
  | FlowValue[]
  | { [key: string]: FlowValue };

export type FlowDiagnosticCategory =
  | "shape"
  | "resolution"
  | "registry"
  | "policy"
  | "artifact"
  | "provenance"
  | "control"
  | "condition"
  | "resume"
  | "mutation"
  | "lowering"
  | "internal";

export interface FlowArtifactContract {
  path?: string;
  kind?: string;
  required?: boolean;
  description?: string;
}

export interface FlowReviewGateMetadata {
  gate?: string;
  reviewerRole?: string;
  decisionNeeded?: string;
  artifactRef?: string;
}

export interface FlowResumeMetadata {
  mode?: "manual" | "event" | "condition";
  condition?: string;
  checkpointRef?: string;
}

export interface FlowMutationMetadata {
  policy?: "read-only" | "idempotent" | "mutating";
  idempotencyKey?: string;
}

export type FlowNodeMetadata = Record<string, unknown> & {
  invocation?: Record<string, unknown>;
  requires?: FlowValue;
  produces?: FlowValue;
  updates?: FlowValue;
  artifacts?: FlowArtifactContract[] | FlowValue;
  evidence?: FlowValue;
  provenance?: FlowValue;
  review?: FlowReviewGateMetadata | FlowValue;
  approval?: FlowReviewGateMetadata | FlowValue;
  resume?: FlowResumeMetadata | FlowValue;
  idempotency?: FlowValue;
  mutation?: FlowMutationMetadata | FlowValue;
  conditions?: Record<string, string> | FlowValue;
};

export interface FlowNodeBase {
  /**
   * Stable node identifier. Optional at the low-level AST layer for backward
   * compatibility with existing compiler fixtures; required by
   * `FlowDocumentV1` validation for canonical authored flows.
   */
  id?: string;
  name?: string;
  description?: string;
  meta?: FlowNodeMetadata;
}

export interface FlowInputSpec {
  type: "string" | "number" | "boolean" | "object" | "array" | "any";
  required?: boolean;
  description?: string;
  default?: FlowValue;
}

export interface FlowDefaults {
  personaRef?: string;
  timeoutMs?: number;
  retry?: {
    attempts: number;
    delayMs?: number;
  };
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
  | AdapterRunNode
  | AdapterRaceNode
  | AdapterParallelNode;

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
};
export type BranchNode = FlowNodeBase & {
  type: "branch";
  condition: string;
  then: FlowNode[];
  else?: FlowNode[];
};
export type ApprovalNode = FlowNodeBase & {
  type: "approval";
  question: string;
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

// ---------------------------------------------------------------------------
// Agent node (dzupflow/v1alpha-agent) — internal LLM loop wrapping
// `@dzupagent/agent`. Stage 1 of the agent-node implementation plan. See
// memory: `flow-dsl-agent-node-implementation-plan-2026-05-17`.
// ---------------------------------------------------------------------------

/**
 * Policy applied to a single agent run. Per-agent overrides on individual
 * AgentNodes. The document-level ceiling lives in `FlowDocumentV1.policy`
 * (Stage 3). Both fields are stored separately — the document policy is a
 * ceiling, the agent policy is a local limit.
 */
export interface AgentPolicy {
  /** Deadline for the agent run in milliseconds. */
  timeoutMs?: number;
  /** Per-agent budget cap in cents. */
  budgetCents?: number;
  /** Max tool calls the agent may issue in this run. */
  maxToolCalls?: number;
  /** Working-directory restriction; relative to repo root. */
  workingDirectory?: string;
  /** Approval taxonomy — tools matching these classes pause for approval. */
  approval?: {
    requiredFor?: string[];
  };
  /** Audit capture toggles. */
  audit?: {
    captureToolCalls?: boolean;
    captureDiffs?: boolean;
  };
}

/** Stop conditions for the internal agent loop. */
export interface AgentStop {
  /** Hard ceiling on iterations. */
  maxIterations?: number;
  /** Hard ceiling on tool calls across iterations. */
  maxToolCalls?: number;
  /** When true, halt without a schema-validated final output is an error. */
  requireFinalSchema?: boolean;
}

/** Schema-gated output contract. Either `schemaRef` (registry id) or
 *  inline `schema` (JSON Schema). One is required. */
export interface AgentOutput {
  /** State key for the validated result. */
  key: string;
  /** Registered schema id, resolved by the codev-app schema registry. */
  schemaRef?: string;
  /** Inline JSON Schema, for one-off shapes. */
  schema?: Record<string, unknown>;
}

/**
 * Inline JSON Schema validation block for an agent node (Stage 2).
 *
 * Runs after `generateStructured` and its schema validation both pass.
 * The validated value stored at `output.key` is re-checked against
 * `schema` using a JSON-Schema validator. On failure, `failBehavior`
 * dictates whether to retry the agent loop, abort the flow, or log a
 * warning and continue.
 *
 * This block is intentionally visible in the DSL — per the Codex amendment
 * (2026-05-18), validation must not be hidden inside runtime magic.
 */
export interface ValidationBlock {
  /** JSON Schema to validate the agent's output against. */
  schema: Record<string, unknown>;
  /** Human-readable message appended to the validation-failure error. */
  errorMessage?: string;
  /**
   * What to do when validation fails.
   * - 'retry': re-run the agent (up to `maxRetries` times), injecting the
   *    validation error into the prompt on each attempt.
   * - 'abort': emit an error that stops the flow.
   * - 'continue': log a warning and carry on.
   * Default: 'abort'
   */
  failBehavior?: "retry" | "abort" | "continue";
  /** Maximum retry attempts when failBehavior='retry'. Default: 1 */
  maxRetries?: number;
}

/** Per-agent acceptance criteria (alternative to top-level validate: node). */
export interface AgentValidation {
  required: AgentValidationCommand[];
  repair?: {
    maxAttempts: number;
  };
}

export interface AgentValidationCommand {
  id?: string;
  command: string;
}

/** Distinct retry behavior per failure class. */
export interface AgentRetry {
  onInvalidOutput?: {
    attempts: number;
    /** When true, feed the validation error back to the agent. */
    repairPrompt?: boolean;
  };
  onToolError?: {
    attempts: number;
  };
  onValidationFailure?: {
    attempts: number;
    /** When true, retry the entire agent loop (not just the validation step). */
    fullLoop?: boolean;
  };
  onModelUnavailable?: {
    attempts: number;
    /** Fallback profile or model id to swap to. */
    fallbackProfile?: string;
  };
}

/** Shorthand for schema-failure retry (alias of `retry.onInvalidOutput`). */
export interface AgentOnInvalidOutput {
  retry: number;
  repairPrompt?: boolean;
  failAfterRetries?: boolean;
}

/**
 * Compile-time template reference on an `agent` node.
 *
 * When present, a synthesis pass (e.g. `synthesizeTemplateRefs` in
 * codev-app) resolves the named template and lowers its `instructions`
 * string and optional `inputDefaults` into the node's `instructions`
 * and `input` fields before the flow executor sees the AST. Node-level
 * `instructions` always win over the template (node is not overwritten
 * if already set).
 */
export interface AgentTemplateRef {
  /** Name / id of the prompt template to resolve. */
  ref: string;
  /** Default input values merged into `node.input` (node.input wins per-key). */
  inputDefaults?: Record<string, unknown>;
}

export type AgentNode = FlowNodeBase & {
  type: "agent";
  /** Logical identity for traces/journal. */
  agentId: string;
  /** Compile-time profile reference (resolved by flow-compiler, never at runtime). */
  profile?: string;
  /** Compile-time toolset reference, expanded into `tools[]` by the compiler. */
  toolset?: string;
  /** Explicit tool refs (post-compile result of toolset expansion). */
  tools?: string[];
  /** ModelRegistry id; may also be supplied via `profile`. */
  model?: string;
  /** Provider routing hint. */
  provider?: string;
  /**
   * Compile-time template reference. When present and `instructions` is not
   * already set on the node, a synthesis pass resolves the named template and
   * lowers its `instructions` (and optionally `inputDefaults`) into the node
   * before the flow executor sees the AST. Mutually optional with `instructions`
   * — at least one must be present after synthesis.
   *
   * This field is intentionally optional at the AST layer so both authoring
   * modes (inline instructions or template ref) are valid DSL inputs.
   */
  template?: AgentTemplateRef;
  /** System/operator instructions, template-resolved at runtime. */
  instructions: string;
  /** State-bound input passed to the agent's first user turn. */
  input?: Record<string, unknown>;
  stop?: AgentStop;
  /** Schema-gated output. Required — no prose-only outputs land. */
  output: AgentOutput;
  /** Shorthand for `retry.onInvalidOutput`. */
  onInvalidOutput?: AgentOnInvalidOutput;
  retry?: AgentRetry;
  /** Per-agent acceptance criteria (Stage 1a). */
  validation?: AgentValidation;
  /**
   * Inline JSON Schema validation gate (Stage 2).
   *
   * Runs after `generateStructured` + `output.schema` Zod validation both
   * pass. The resolved value at `output.key` is re-validated against this
   * block's `schema`. Use this for cross-field constraints that cannot be
   * expressed as a Zod type, or to add retry/continue semantics on top of
   * a permissive output schema.
   */
  validate?: ValidationBlock;
  /** Per-agent policy override; merges flatly over top-level policy. */
  policy?: AgentPolicy;
};

/**
 * Visible top-level gate node. Runs declared commands at the documented
 * graph position and (optionally) retries the nearest prior agent on
 * failure per `repair.maxAttempts`. See Stage 4 of the plan.
 */
export type ValidateNode = FlowNodeBase & {
  type: "validate";
  /** Reference to a top-level validation declaration name. */
  ref?: string;
  /** Inline commands; alternative to `ref`. */
  commands?: AgentValidationCommand[];
  repair?: {
    maxAttempts: number;
    onFailure?: "retry-prior-agent" | "stop";
  };
};

export type WorkerDispatchNode = FlowNodeBase & {
  type: "worker.dispatch";
  /** Logical id for traces/journal. */
  dispatchId: string;
  /** CLI provider to run on the worker. */
  provider: "claude" | "codex" | "gemini" | "qwen" | "goose" | "crush";
  model?: string;
  /** System prompt projected into prompt assembly. */
  systemPrompt?: string;
  /** Operator instructions; template-resolved at runtime. */
  instructions: string;
  /** State-bound input merged into the prompt. */
  input?: Record<string, unknown>;
  /** Command governance. Default surface = "none" (read-only). */
  commandSurface?: "none" | "code";
  commandAllowlist?: string[];
  validationCommand?: string;
  /** Where the worker result lands in flow state. */
  outputKey: string;
  /** Result parse contract. */
  resultFormat?: "text" | "json";
  /**
   * OPT-IN named-schema key for shape validation of a `resultFormat: "json"`
   * payload. When set, the resume path looks this key up in the consumer's
   * schema registry and `safeParse`s the parsed payload; a shape mismatch
   * FAILS the run rather than resuming with a malformed value. Absent ⇒ no
   * shape validation (generic JSON passes through). Opaque to flow-ast: the
   * registry lives in the consuming app (e.g. codev-app).
   */
  resultSchema?: string;
};

export type FleetDispatchMode =
  | "supervisor"
  | "contract-net"
  | "fan-out"
  | "dependency";

export type FleetReposRef = string | unknown[];

export type FleetDispatchNode = FlowNodeBase & {
  type: "fleet.dispatch";
  mode: FleetDispatchMode;
  repos: FleetReposRef;
  task: unknown;
  on_contract_change?: string;
  output?: string;
};

export type FleetGatherNode = FlowNodeBase & {
  type: "fleet.gather";
  source: string;
  strategy?: string;
  output?: string;
};

export type FleetContractNetNode = FlowNodeBase & {
  type: "fleet.contract-net";
  repos: FleetReposRef;
  task: unknown;
  output?: string;
};

export type KnowledgeWriteNode = FlowNodeBase & {
  type: "knowledge.write";
  scope: string;
  entry: unknown;
};

export type KnowledgeQueryNode = FlowNodeBase & {
  type: "knowledge.query";
  filter: Record<string, unknown>;
  output: string;
};

/**
 * `adapter.run` — a single routed, in-process agent-adapter call with registry
 * fallback. Executes by delegating to the `OrchestratorFacade` at runtime (ADR
 * 0001); additive under `dzupflow/v1`. One of `provider` / `tags` is required:
 * an explicit `provider` pins the adapter, `tags` route via the
 * `ProviderAdapterRegistry`. Field grammar mirrors `worker.dispatch`/`agent`
 * conventions (study `04-SPECIFICATION.md` §3–§4). flow-ast only models shape;
 * lowering/execution live in flow-dsl + the runtime.
 */
export type AdapterRunNode = FlowNodeBase & {
  type: "adapter.run";
  /** Explicit provider; required unless `tags` routing is used. */
  provider?: "claude" | "codex" | "gemini" | "qwen" | "goose" | "crush";
  /** Capability tags for registry routing; one of `provider`/`tags` required. */
  tags?: string[];
  /** Provider model hint. */
  model?: string;
  /** Operator instructions; template-resolved at runtime. */
  instructions: string;
  /** Base persona layer; template-resolved. */
  systemPrompt?: string;
  /** State-bound bindings merged into the prompt. */
  input?: Record<string, unknown>;
  /** Persona ref applied to this node's prompt layers. */
  persona?: string;
  /** Normalized reasoning intent, mapped per provider at runtime. */
  reasoning?: "low" | "medium" | "high";
  /** Schema ref or inline JSON Schema for structured output. */
  outputSchema?: string | Record<string, unknown>;
  /** `auto` (default) applies model-aware prep; `raw` = passthrough. */
  promptPrep?: "auto" | "raw";
  /** Replay governance; REQUIRED for side-effecting nodes (validator-warned). */
  idempotency?: "idempotent" | "at-least-once" | "exactly-once-required";
  /** Per-node budget/timeout/guardrail override. */
  policy?: Record<string, unknown>;
  /** State key for the result. */
  output: string;
};

/**
 * `adapter.race` — race the same prompt across ≥2 providers; the first
 * successful result wins (Taleb provider hedge). Lowers to
 * `OrchestratorFacade.race(prompt, providers)` at runtime; the journal records
 * the winner and that the others were cancelled (spec §5.1). Additive under
 * `dzupflow/v1`. Shares the common `adapter.*` field block (§3) sans the
 * single-call routing fields — selection is the explicit `providers` list.
 */
export type AdapterRaceNode = FlowNodeBase & {
  type: "adapter.race";
  /** ≥2 providers raced on the same prompt. */
  providers: Array<"claude" | "codex" | "gemini" | "qwen" | "goose" | "crush">;
  model?: string;
  /** Operator instructions; template-resolved at runtime. */
  instructions: string;
  /** Base persona layer; template-resolved. */
  systemPrompt?: string;
  /** State-bound bindings merged into the prompt. */
  input?: Record<string, unknown>;
  /** Persona ref applied to this node's prompt layers. */
  persona?: string;
  /** Normalized reasoning intent, mapped per provider at runtime. */
  reasoning?: "low" | "medium" | "high";
  /** Schema ref or inline JSON Schema for structured output. */
  outputSchema?: string | Record<string, unknown>;
  /** `auto` (default) applies model-aware prep; `raw` = passthrough. */
  promptPrep?: "auto" | "raw";
  /** Replay governance; REQUIRED for side-effecting nodes (validator-warned). */
  idempotency?: "idempotent" | "at-least-once" | "exactly-once-required";
  /** Per-node budget/timeout/guardrail override. */
  policy?: Record<string, unknown>;
  /** State key for the winning provider's result. */
  output: string;
};

/**
 * `adapter.parallel` — fan the same prompt out to ≥2 providers concurrently and
 * merge per `merge` (spec §5.2). Concurrency is REAL via the facade (distinct
 * from the codev `parallel` node's sequential-in-runtime behavior). Lowers to
 * `OrchestratorFacade.parallel(prompt, {merge})` at runtime.
 *
 * Output-shape contract (provisional, resolving spec §13 CRITICAL #1 — the
 * authoring layer governs only the `merge` enum; the runtime produces):
 *   - `first-wins` → scalar (the first successful result)
 *   - `all` (default) → a record keyed by provider name
 *   - `best-of-n` → a scored object `{ winner, candidates }` (the scoring
 *     mechanism is a runtime concern, still to be specified; accepted at the
 *     authoring layer because the spec lists it as a valid merge value).
 */
export type AdapterParallelNode = FlowNodeBase & {
  type: "adapter.parallel";
  /** ≥2 providers run concurrently on the same prompt. */
  providers: Array<"claude" | "codex" | "gemini" | "qwen" | "goose" | "crush">;
  /** Merge strategy; default `all`. Maps to the runtime `MergeStrategy`. */
  merge?: "first-wins" | "all" | "best-of-n";
  model?: string;
  /** Operator instructions; template-resolved at runtime. */
  instructions: string;
  /** Base persona layer; template-resolved. */
  systemPrompt?: string;
  /** State-bound bindings merged into the prompt. */
  input?: Record<string, unknown>;
  /** Persona ref applied to this node's prompt layers. */
  persona?: string;
  /** Normalized reasoning intent, mapped per provider at runtime. */
  reasoning?: "low" | "medium" | "high";
  /** Schema ref or inline JSON Schema for structured output. */
  outputSchema?: string | Record<string, unknown>;
  /** `auto` (default) applies model-aware prep; `raw` = passthrough. */
  promptPrep?: "auto" | "raw";
  /** Replay governance; REQUIRED for side-effecting nodes (validator-warned). */
  idempotency?: "idempotent" | "at-least-once" | "exactly-once-required";
  /** Per-node budget/timeout/guardrail override. */
  policy?: Record<string, unknown>;
  /** State key for the merged result (shape depends on `merge`). */
  output: string;
};

export type FlowNodeKind = FlowNode["type"];

/**
 * Authoritative registry for public FlowNode discriminators.
 *
 * Parser, validator, and downstream contract tests derive their accepted
 * node-kind lists from this table so the public union cannot drift from
 * runtime handling.
 */
export const FLOW_NODE_KIND_REGISTRY = {
  sequence: true,
  action: true,
  for_each: true,
  branch: true,
  approval: true,
  clarification: true,
  persona: true,
  route: true,
  parallel: true,
  complete: true,
  spawn: true,
  classify: true,
  emit: true,
  memory: true,
  set: true,
  checkpoint: true,
  restore: true,
  try_catch: true,
  loop: true,
  http: true,
  wait: true,
  subflow: true,
  prompt: true,
  return_to: true,
  agent: true,
  validate: true,
  "worker.dispatch": true,
  "fleet.dispatch": true,
  "fleet.gather": true,
  "fleet.contract-net": true,
  "knowledge.write": true,
  "knowledge.query": true,
  "adapter.run": true,
  "adapter.race": true,
  "adapter.parallel": true,
} as const satisfies Record<FlowNodeKind, true>;

export const FLOW_NODE_KINDS = Object.keys(
  FLOW_NODE_KIND_REGISTRY
) as FlowNodeKind[];

export function isFlowNodeKind(value: string): value is FlowNodeKind {
  return Object.prototype.hasOwnProperty.call(FLOW_NODE_KIND_REGISTRY, value);
}

/**
 * Supported DSL discriminator values.
 *
 * `dzupflow/v1` is the stable, long-lived contract.
 * `dzupflow/v1alpha-agent` opts into the Stage 1 agent-node primitives
 *  (agent + validate nodes, top-level policy block). The parser must
 *  treat these as additive — `v1` documents must continue to round-trip
 *  unchanged.
 */
export type FlowDocumentDsl = "dzupflow/v1" | "dzupflow/v1alpha-agent";

/**
 * Top-level policy constraints for an entire flow run. Acts as a ceiling that
 * applies to all nodes unless a per-agent `AgentPolicy` narrows the scope
 * further. Stage 3 (policy threading).
 */
export interface FlowDocumentPolicy {
  /** Hard budget ceiling in USD cents for the entire flow run. */
  budgetCents?: number;
  /** Hard timeout in ms for the entire flow run. */
  timeoutMs?: number;
  /** Default working directory applied to all validate/command nodes. */
  workingDirectory?: string;
}

export interface FlowDocumentV1 {
  dsl: FlowDocumentDsl;
  id: string;
  title?: string;
  description?: string;
  version: number;
  inputs?: Record<string, FlowInputSpec>;
  defaults?: FlowDefaults;
  tags?: string[];
  meta?: FlowNodeMetadata;
  /** Top-level policy constraints for the entire flow run (Stage 3). */
  policy?: FlowDocumentPolicy;
  root: SequenceNode;
}

// Validation errors produced by Stage 3 semantic validator
export interface ValidationError {
  nodeType: FlowNode["type"];
  nodePath: string; // dot-notation path in the AST, e.g. "root.nodes[2].body[0]"
  code: ValidationErrorCode;
  message: string;
  category?: FlowDiagnosticCategory;
}

export type ValidationErrorCode =
  | "UNRESOLVED_TOOL_REF"
  | "UNRESOLVED_PERSONA_REF"
  | "EMPTY_BODY"
  | "INVALID_CONDITION"
  | "MISSING_REQUIRED_FIELD"
  | "DUPLICATE_NODE_ID"
  | "RESOLVER_INFRA_ERROR"
  | "UNRESOLVED_TOOLSET_REF"
  | "MISSING_TOOLSET_RESOLVER"
  | "INVALID_TOOLSET_RESOLVER_RESULT"
  | "TOOLSET_RESOLVER_INFRA_ERROR"
  | "UNRESOLVED_PROFILE_REF"
  | "MISSING_PROFILE_REGISTRY"
  | "PROFILE_RESOLVER_INFRA_ERROR"
  | "INVALID_TEMPLATE_FRONTMATTER"
  | "MISSING_REQUIRED_SECTION"
  | "UNKNOWN_FRONTMATTER_KEY";

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
  resolve(ref: string): ResolvedTool | null;

  /**
   * Enumerate every ref the resolver currently knows about. Used by the
   * compiler to produce "did you mean …?" diagnostics and by tooling
   * (LSP / pretty-printer) to offer completions.
   */
  listAvailable(): string[];
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
  resolve(ref: string): Promise<ResolvedTool | null>;

  /**
   * Enumerate every ref currently in the resolver's catalogue.
   * MUST be synchronous. See interface-level JSDoc for rationale.
   */
  listAvailable(): string[];
}

export type ResolvedToolKind = "mcp-tool" | "skill" | "workflow" | "agent";

export interface ResolvedTool {
  /** The original opaque ref string as it appeared in the flow source. */
  ref: string;
  /** What the ref actually points at — drives compiler lowering choices. */
  kind: ResolvedToolKind;
  /** JSON-Schema (or Zod-derived schema) describing accepted input. */
  inputSchema: unknown;
  /** Optional JSON-Schema for declared output shape. */
  outputSchema?: unknown;
  /** Opaque, stable handle the runtime uses to invoke the resolved entity. */
  handle: unknown;
  /** Optional generic metadata surfaced by host registries for planning tools. */
  meta?: Record<string, unknown>;
}

export interface HostToolRegistryEntry {
  ref: string;
  kind: ResolvedToolKind;
  inputSchema: unknown;
  outputSchema?: unknown;
  handle?: unknown;
  aliases?: string[];
  description?: string;
  meta?: Record<string, unknown>;
}

/**
 * Resolves a compile-time toolset reference (the `toolset: <name>` field on
 * AgentNode) into the concrete list of tool refs the agent is allowed to
 * invoke at runtime.
 *
 * Stage 2 of the Flow DSL pipeline calls this resolver during semantic
 * resolution; the resolved list is merged with any inline `tools[]` on the
 * node and written back as the canonical `tools[]` on the AST. Downstream
 * runtimes (codev-app's `flow-node-executor-agent`) filter the agent's tool
 * surface against this expanded list — toolsets are runtime-enforced, not
 * a zero-impact annotation (Codex amendment 2026-05-18).
 *
 * Returns `null` (not throws) for unknown toolset names so the compiler can
 * aggregate every UNRESOLVED_TOOLSET_REF into a single Stage-3 report. An
 * empty array is a legal result — it just means "no extra tools beyond the
 * inline list".
 */
export interface ToolsetResolver {
  resolve(ref: string): readonly string[] | null;
  /**
   * Enumerate every toolset ref currently known. Used for "did you mean…?"
   * suggestions on UNRESOLVED_TOOLSET_REF.
   */
  listAvailable(): string[];
}

/**
 * Async variant of {@link ToolsetResolver} for catalogues backed by lazy
 * loaders (DB, remote registry). Stage 3 duck-types on the return type of
 * `resolve()`; synchronous resolvers never hit the microtask queue.
 */
export interface AsyncToolsetResolver {
  resolve(ref: string): Promise<readonly string[] | null>;
  listAvailable(): string[];
}

/**
 * Catalogue entry for the helper {@link createToolsetResolverFromCatalog} in
 * `@dzupagent/flow-compiler`. Mirrors the shape consumers already use for
 * host tool registries: each entry declares the canonical name and the
 * expanded tool refs it stands for.
 */
export interface ToolsetCatalogEntry {
  name: string;
  tools: readonly string[];
  description?: string;
}
