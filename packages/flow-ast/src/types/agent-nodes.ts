import type { FlowNodeBase, NodeIdempotencyMode } from "./primitives.js";

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
  /** Per-run reasoning effort. Adapters that support it (e.g. codex) map this
   * to their native reasoning option; others ignore it. */
  reasoningEffort?: "low" | "medium" | "high";
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

export type ShellRunNode = FlowNodeBase & {
  type: "shell.run";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  required?: boolean;
  allowFailure?: boolean;
  output: string;
};

export type EvidenceWriteNode = FlowNodeBase & {
  type: "evidence.write";
  source: string;
  output: string;
  redact?: boolean;
};

export type ValidateSchemaNode = FlowNodeBase & {
  type: "validate.schema";
  source: string;
  schema: Record<string, unknown> | string;
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
  provider?:
    | "claude"
    | "codex"
    | "gemini"
    | "openai"
    | "openrouter"
    | "openrouter-crush"
    | "qwen"
    | "goose"
    | "crush";
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
  idempotency?: NodeIdempotencyMode;
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
  idempotency?: NodeIdempotencyMode;
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
  idempotency?: NodeIdempotencyMode;
  /** Per-node budget/timeout/guardrail override. */
  policy?: Record<string, unknown>;
  /** State key for the merged result (shape depends on `merge`). */
  output: string;
};

/**
 * `adapter.supervisor` — decompose a `goal` into subtasks and delegate each to a
 * specialist provider, then aggregate (spec §5.3). Lowers to
 * `OrchestratorFacade.supervisor(goal, {...})` at runtime; each delegated subtask
 * + chosen provider is journaled as a sub-run (REQ-SUP-1).
 *
 * Decomposition source (resolving OQ-1): **LLM-driven** — the supervisor splits
 * the goal into subtasks at runtime (no author-provided subtask list). The
 * authoring surface is therefore just the `goal`, an optional `specialists` pool,
 * and the aggregated `output`. Note this node carries `goal` (not the common
 * `instructions`); the rest of the common adapter block applies.
 */
export type AdapterSupervisorNode = FlowNodeBase & {
  type: "adapter.supervisor";
  /** Template-resolved goal the supervisor decomposes at runtime. */
  goal: string;
  /**
   * Optional provider/tag pool for subtasks. Omitted ⇒ the registry routes each
   * subtask. (Strings, not the strict provider enum — entries may be capability
   * tags resolved by the `ProviderAdapterRegistry`.)
   */
  specialists?: string[];
  model?: string;
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
  idempotency?: NodeIdempotencyMode;
  /** Per-node budget/timeout/guardrail override. */
  policy?: Record<string, unknown>;
  /** State key for the aggregated result. */
  output: string;
};
