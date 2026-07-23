import type {
  AsyncToolResolver,
  AsyncToolsetResolver,
  FlowDiagnosticCategory,
  FlowDataClassification,
  FlowDocumentV1,
  FlowDocumentPolicy,
  FlowDurabilityPolicy,
  FlowNodeKind,
  ToolResolver,
  ToolsetResolver,
} from "@dzupagent/flow-ast";
import type {
  FlowReferenceBindings,
  FlowReferencePolicy,
} from "@dzupagent/flow-ast/expressions";
import type { ParseInput } from "@dzupagent/flow-ast";
import type { DzupEventBus } from "@dzupagent/core/events";

import type { ProfileRegistry } from "./profile-registry.js";
import type { FlowCompiledClassificationEnvelope } from "./classification-envelope-types.js";

/**
 * Compile-time value categories used by strict reference analysis.
 *
 * This is intentionally smaller than JSON Schema. It is sufficient for
 * scalar-vs-collection checks without pretending that opaque schema refs have
 * been resolved. `unknown` means no sound type is available; `any` preserves
 * an explicitly untyped authored input.
 */
export type FlowReferenceValueType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "credential"
  | "null"
  | "any"
  | "unknown";

/** Compile-time admission posture; unattended flows fail closed. */
export type FlowAdmissionProfile = "interactive" | "unattended";

/** Types for the first declared name below each reference root. */
export type FlowReferenceTypeBindings = Readonly<
  Record<
    string,
    Readonly<Record<string, FlowReferenceValueType | undefined>> | undefined
  >
>;

/**
 * Explicit output-port contracts by stable step id.
 *
 * The current v1 AST declares state destinations but not canonical step-port
 * names. Hosts therefore supply port names deliberately instead of the
 * compiler guessing that a state key is also a portable step port.
 */
export type FlowReferencePortBindings = Readonly<
  Record<
    string,
    Readonly<Record<string, FlowReferenceValueType | undefined>> | undefined
  >
>;

/** Classifications for the first declared name below each reference root. */
export type FlowReferenceClassificationBindings = Readonly<
  Record<
    string,
    Readonly<Record<string, FlowDataClassification | undefined>> | undefined
  >
>;

/** Explicit output-port classifications by stable step id. */
export type FlowReferencePortClassificationBindings = Readonly<
  Record<
    string,
    Readonly<Record<string, FlowDataClassification | undefined>> | undefined
  >
>;

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
   * `interactive` preserves compatibility defaults. `unattended` requires
   * strict reference analysis and explicit classification for every document
   * input before compilation can succeed.
   */
  admissionProfile?: FlowAdmissionProfile;
  /**
   * Additional host/late-bound names by reference root. The compiler derives
   * ordinary document inputs, state outputs, step ids, and loop symbols, then
   * unions this snapshot for host-owned context, secret, artifact, or external
   * state names before strict analysis.
   */
  referenceBindings?: FlowReferenceBindings;
  /**
   * Optional host types for late-bound context, state, secret, artifact, or
   * external step symbols. The compiler unions these with document input types
   * and types inferred from explicit node outputs.
   */
  referenceTypeBindings?: FlowReferenceTypeBindings;
  /**
   * Canonical output ports for stable step ids. Required for strict
   * `steps.<id>.<port>` references because the v1 AST does not yet define
   * portable port names. Supplying a port contract does not make the step
   * initially available; execution order is analyzed separately.
   */
  referencePortBindings?: FlowReferencePortBindings;
  /**
   * Optional host classifications for late-bound context, state, secret,
   * artifact, or external symbols. Classifications merge monotonically; a
   * host declaration cannot downgrade a more restrictive document or
   * compiler-derived value.
   */
  referenceClassificationBindings?: FlowReferenceClassificationBindings;
  /**
   * Classifications for reviewed canonical output ports. Kept separate from
   * value types because a schema category does not imply a security level.
   */
  referencePortClassificationBindings?: FlowReferencePortClassificationBindings;
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
  /**
   * Stable editor-facing location. DSL parse diagnostics use source lines;
   * semantic reference diagnostics use UTF-16 offsets relative to nodePath.
   */
  span?: CompilationSourceSpan;
}

export interface CompilationWarning {
  stage: CompilationStage;
  code: string;
  message: string;
  nodePath?: string;
  suggestion?: string;
  category?: FlowDiagnosticCategory;
  span?: CompilationSourceSpan;
}

export type CompilationSourceSpan =
  | {
      kind: "source-lines";
      lineStart: number;
      columnStart: number;
      lineEnd: number;
      columnEnd: number;
    }
  | {
      kind: "node-field-offsets";
      start: number;
      end: number;
    };

export interface FlowEditorDiagnostic {
  severity: "error" | "warning";
  stage: CompilationStage;
  code: string;
  message: string;
  nodePath?: string;
  suggestion?: string;
  category?: FlowDiagnosticCategory;
  span?: CompilationSourceSpan;
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
  /**
   * Immutable value/port classification and primitive policy projection.
   * Every compiler-produced success includes it; the optional marker preserves
   * source compatibility for hosts that construct legacy result fixtures.
   */
  classificationEnvelope?: FlowCompiledClassificationEnvelope;
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
  analyzeStrictReferenceMigration(
    sources: readonly StrictReferenceMigrationSource[]
  ): Promise<StrictReferenceMigrationReport>;
}

export interface FlowReferenceCompletion {
  kind: "binding" | "step-port";
  label: string;
  insertText: string;
  root: string;
  name: string;
  stepId?: string;
  valueType: FlowReferenceValueType;
  classification?: FlowDataClassification;
}

export interface FlowReferenceAuthoringSnapshot {
  schema: "dzupagent.flowReferenceAuthoring/v1";
  bindings: FlowReferenceBindings;
  types: FlowReferenceTypeBindings;
  ports: FlowReferencePortBindings;
  classifications: FlowReferenceClassificationBindings;
  portClassifications: FlowReferencePortClassificationBindings;
  completions: FlowReferenceCompletion[];
}

export interface FlowReferenceAuthoringOptions {
  referenceBindings?: FlowReferenceBindings;
  referenceTypeBindings?: FlowReferenceTypeBindings;
  referencePortBindings?: FlowReferencePortBindings;
  referenceClassificationBindings?: FlowReferenceClassificationBindings;
  referencePortClassificationBindings?: FlowReferencePortClassificationBindings;
}

export type StrictReferenceMigrationSource =
  | { id: string; kind: "flow"; input: ParseInput }
  | { id: string; kind: "document"; input: unknown }
  | { id: string; kind: "dsl"; input: unknown };

export type StrictReferenceMigrationStatus =
  | "ready"
  | "changes-required"
  | "invalid";

export interface StrictReferenceMigrationItem {
  id: string;
  kind: StrictReferenceMigrationSource["kind"];
  status: StrictReferenceMigrationStatus;
  compatibilityDiagnostics: CompilationDiagnostic[];
  compatibilityWarnings: CompilationWarning[];
  strictDiagnostics: CompilationDiagnostic[];
  blockingReferenceCodes: string[];
}

export interface StrictReferenceMigrationSummary {
  total: number;
  ready: number;
  changesRequired: number;
  invalid: number;
  diagnosticsByCode: Record<string, number>;
  compilerDiagnosticsByCode: Record<string, number>;
}

export interface StrictReferenceMigrationReport {
  schema: "dzupagent.strictReferenceMigration/v1";
  summary: StrictReferenceMigrationSummary;
  items: StrictReferenceMigrationItem[];
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
