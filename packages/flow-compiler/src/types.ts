import type {
  AsyncToolResolver,
  AsyncToolsetResolver,
  FlowDiagnosticCategory,
  FlowDocumentV1,
  FlowDocumentPolicy,
  FlowDurabilityPolicy,
  FlowNodeKind,
  FlowReferenceBindings,
  FlowReferencePolicy,
  ToolResolver,
  ToolsetResolver,
} from "@dzupagent/flow-ast";
import type { ParseInput } from "@dzupagent/flow-ast";
import type { DzupEventBus } from "@dzupagent/core/events";

import type { ProfileRegistry } from "./profile-registry.js";

export interface CompilerOptions {
  toolResolver: ToolResolver | AsyncToolResolver;
  flowDocumentResolver?: FlowDocumentResolver;
  personaResolver?: PersonaResolver | AsyncPersonaResolver;
  /**
   * Resolves `toolset: <name>` references on AgentNodes into expanded
   * `tools[]` arrays. When absent, agent nodes that declare `toolset` emit
   * `UNRESOLVED_TOOLSET_REF` at Stage 3 (semantic resolution). Agent nodes
   * with only inline `tools[]` (no `toolset`) compile unaffected.
   *
   * See Stage 2 of the Flow DSL implementation plan; runtime enforcement of
   * the expanded list happens in the consuming runtime (codev-app's
   * `flow-node-executor-agent`).
   */
  toolsetResolver?: ToolsetResolver | AsyncToolsetResolver;
  /**
   * Resolves `profile: <name>` references on AgentNodes into flattened
   * model/provider/instructions/toolset/policy fields at compile time
   * (Stage 1.5). Successful resolution mutates the agent node in place
   * and strips `node.profile` from the emitted AST so the lowered
   * artifact and the runtime never see an unresolved profile ref.
   *
   * Field precedence: node-level fields always win — profiles supply
   * defaults only. See `@dzupagent/flow-compiler` `ProfileRegistry`
   * for the contract (synchronous in-process lookup; the registry
   * snapshot is expected to be hot before compile time).
   *
   * When absent, agent.profile refs are preserved on the AST and a
   * single MISSING_PROFILE_REGISTRY warning is surfaced — consuming
   * runtimes may still implement their own backfill safety net for
   * back-compat, but new flows should ship through a compile-time
   * registry.
   */
  profileRegistry?: ProfileRegistry;
  /**
   * When `true`, the compiler forwards inner lifecycle events
   * (`flow:compile_started`, `flow:compile_parsed`,
   * `flow:compile_shape_validated`, `flow:compile_semantic_resolved`,
   * `flow:compile_lowered`, `flow:compile_completed`,
   * `flow:compile_failed`) to `eventBus`.
   *
   * Requires `eventBus` to be set when `true`; the factory throws
   * otherwise. When omitted or `false`, the hot path is branchless —
   * events are captured into a no-op closure at factory time.
   *
   * Rationale for injection vs self-owned bus: cleaner separation of
   * concerns, less code (no re-implementation of `subscribe()` on the
   * compiler), and no fan-out coordination needed when multiple
   * subsystems want to observe compilation. See Wave 11 ADR §4.
   */
  forwardInnerEvents?: boolean;
  /**
   * Shared bus for lifecycle event forwarding. Only consulted when
   * `forwardInnerEvents === true`. See Wave 11 ADR §4.
   */
  eventBus?: DzupEventBus;
  /**
   * Compilation target hint. When set to `'codev-runtime'`, any tool
   * reference starting with `codev.` is treated as externally resolved
   * and will never raise an `UNRESOLVED_TOOL_REF` error. All other
   * validation rules remain in effect.
   *
   * This allows flows that reference `codev.*` namespaced tools
   * (e.g. `codev.planning.create_manifest`, `codev.intake.normalize`)
   * to compile cleanly without needing those tools registered in the
   * local resolver.
   */
  target?: "codev-runtime";
  /**
   * Reference validation policy. Defaults to `compat-v1`; `strict` rejects
   * legacy/disallowed roots and malformed control references during semantic
   * analysis without changing v1 runtime evaluation.
   */
  referencePolicy?: FlowReferencePolicy;
  /**
   * Optional declared binding names by reference root. Strict analysis uses
   * this snapshot to fail missing input/state/step references before lowering.
   */
  referenceBindings?: FlowReferenceBindings;
}

export interface FlowDocumentResolver {
  resolve(
    flowRef: string
  ): FlowDocumentV1 | null | Promise<FlowDocumentV1 | null>;
}

export interface PersonaResolver {
  resolve(ref: string): boolean; // true if persona exists
}

/**
 * Async variant of {@link PersonaResolver}. Mirrors {@link AsyncToolResolver}
 * — stage 3 awaits the result when `resolve()` returns a Promise.
 */
export interface AsyncPersonaResolver {
  resolve(ref: string): Promise<boolean>;
}

export type CompilationTarget =
  | "skill-chain"
  | "workflow-builder"
  | "pipeline"
  | "planning-dag";

/**
 * Structural summary of what a flow requires from a compilation target.
 *
 * Defined here (a leaf type module) rather than in `capability-manifest.ts` so
 * that `types.ts` does not depend on `capability-manifest.ts` — both modules
 * import this type from `types.js` in a single direction, keeping the module
 * graph acyclic. The public re-export is preserved from `capability-manifest.ts`
 * and the package barrel.
 */
export interface FlowRequirementSummary {
  schema: "dzupagent.flowRequirements/v1";
  target: CompilationTarget;
  semanticHash: string;
  nodeKinds: FlowNodeKind[];
  requiredCapabilities: string[];
  partialNodeKinds: FlowNodeKind[];
  unsupportedNodeKinds: FlowNodeKind[];
}

export type CompilationStage = 1 | 2 | 3 | 4;

export type FlowCompileSourceKind =
  | "flow-object"
  | "flow-json-string"
  | "flow-document"
  | "dzupflow-dsl";

export interface FlowCompileCorrelation {
  runId?: string;
  eventCorrelationId?: string;
}

export interface CompileInvocationOptions {
  sourceKind?: FlowCompileSourceKind;
  source?: unknown;
  correlation?: FlowCompileCorrelation;
  currentFlowRef?: string;
  fragmentExpansions?: FlowCompileFragmentEvidence[];
}

export interface CompilationDiagnostic {
  stage: CompilationStage;
  code: string;
  message: string;
  nodePath?: string;
  suggestion?: string;
  category?: FlowDiagnosticCategory;
}

export interface CompilationWarning {
  stage: 4;
  code: string;
  message: string;
  nodePath?: string;
  category?: FlowDiagnosticCategory;
}

export interface CompilationTargetReason {
  code:
    | "SEQUENTIAL_ONLY"
    | "BRANCH_PRESENT"
    | "PARALLEL_PRESENT"
    | "SUSPEND_PRESENT"
    | "FOR_EACH_PRESENT"
    | "RUNTIME_LEAF_PRESENT";
  message: string;
}

export interface CompilationResult {
  target: CompilationTarget;
  // The compiled artifact — typed as unknown here; each consumer casts to the right type
  artifact: unknown;
  warnings: CompilationWarning[];
  reasons: CompilationTargetReason[];
}

export type CompilationError = CompilationDiagnostic;

export interface CompileSuccess {
  compileId: string;
  target: CompilationTarget;
  artifact: unknown;
  warnings: CompilationWarning[];
  reasons: CompilationTargetReason[];
  /**
   * Machine-readable target and host capability requirements derived from the
   * canonical AST. Hosts can pass this directly to `resolveHostReadiness`
   * before starting execution.
   */
  requirements: FlowRequirementSummary;
  evidence: FlowCompileEvidence;
  diagnosticCountsByCategory?: Record<string, number>;
  /**
   * Document-level policy extracted from `FlowDocumentV1.policy`, propagated
   * from `compileDocument()`. Absent when the source had no top-level policy
   * block or when the compile entry point was `compile()` / `compileDsl()`.
   * Stage 3 (policy threading) — runtime wires this into `ExecutionContext`.
   */
  documentPolicy?: FlowDocumentPolicy;
  /**
   * Document-level durability profile extracted from `FlowDocumentV1.durability`
   * (P0 durability contract). Absent when the source declared no durability
   * block or when the entry point was `compile()` / `compileDsl()`. The runtime
   * (Stage 2+) reads this to decide checkpoint/resume behavior; here it is
   * surfaced as compile evidence only — no runtime behavior change.
   */
  documentDurability?: FlowDurabilityPolicy;
}

export interface CompileFailure {
  compileId: string;
  errors: CompilationDiagnostic[];
  diagnosticCountsByCategory?: Record<string, number>;
}

export type CompileResult = CompileSuccess | CompileFailure;

export interface FlowCompiler {
  compile(
    input: ParseInput,
    options?: CompileInvocationOptions
  ): Promise<CompileSuccess | CompileFailure>;
  compileDocument(document: unknown): Promise<CompileSuccess | CompileFailure>;
  compileDsl(source: unknown): Promise<CompileSuccess | CompileFailure>;
}

export interface FlowCompileEvidenceNode {
  type: string;
  id?: string;
}

export interface FlowCompileEvidence {
  schema: "dzupagent.flowCompileEvidence/v1";
  sourceKind: FlowCompileSourceKind;
  sourceHash: string;
  semanticHash: string;
  compileId: string;
  canonicalNodeIds: string[];
  canonicalNodePaths: Record<string, FlowCompileEvidenceNode>;
  loweredTarget: CompilationTarget;
  correlationIds: {
    compileId: string;
    eventCorrelationId: string;
    runId?: string;
  };
  composition?: FlowCompileCompositionEvidence;
}

export interface FlowCompileCompositionEvidence {
  subflows?: FlowCompileSubflowEvidence[];
  fragments?: FlowCompileFragmentEvidence[];
}

export interface FlowCompileSubflowEvidence {
  flowRef: string;
  instanceId: string;
  nodePath: string;
}

export interface FlowCompileFragmentEvidence {
  id: string;
  version: number;
  namespace: string;
  catalogRef: string;
  instanceId: string;
  invocationPath: string;
  expandedPaths: string[];
  exports: Record<string, string>;
}
