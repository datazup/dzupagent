# ADR-0007: flow-compiler layer ownership and boundary contract

## Status

Accepted — 2026-05-07

## Context

`packages/agent-adapters/src/workflow/adapter-workflow.ts` contains an
ownership comment (lines 8-22) that names `@dzupagent/flow-compiler` as the
canonical owner of FlowDocument/FlowNode parsing, semantic resolution, target
routing, and graph lowering. The package exists at
`dzupagent/packages/flow-compiler/` and is versioned alongside the rest of
the framework, but until this ADR there was no single document declaring:

- which package owns the layer,
- what the boundary contract is between the flow compiler and its consumers,
- which packages may or may not take a runtime dependency on it, and
- why the adapter workflow builder intentionally avoids importing it.

The gap was surfaced as finding L-02 in the 2026-05-06 agent-adapters audit.
The architecture test at
`packages/agent-adapters/src/__tests__/architecture-doc.test.ts` (lines 82-84)
already asserts that `@dzupagent/flow-ast`, `@dzupagent/flow-dsl`, and
`@dzupagent/flow-compiler` are listed in the authoring-surfaces matrix, but
that matrix document (`docs/flow-orchestration-authoring-surfaces.md`) is
a table, not an ADR. An ADR is needed to record the decision, the reasoning,
and the explicit dependency rules that make the boundary enforceable.

## Decision

### Package ownership

`@dzupagent/flow-compiler` is a first-class, independently versioned package
in the DzupAgent framework. It lives at `dzupagent/packages/flow-compiler/`
and is published as `@dzupagent/flow-compiler`. No other package owns it.

### What the layer is

The flow compiler is a four-stage compilation pipeline that turns a
`FlowDocumentV1` or `dzupflow/v1` DSL input into a lowered artifact:

1. **Stage 1 — Parse** (`@dzupagent/flow-ast:parseFlow`): JSON/object →
   `FlowNode` AST.
2. **Stage 2 — Shape validation** (`validateShape`): structural rule
   enforcement (node kinds, edge constraints, required fields).
3. **Stage 3 — Semantic resolution** (`semanticResolve`): tool and persona
   reference resolution via an injected resolver; halts on any error.
4. **Stage 4 — Route + lower** (`routeTarget` → `lowerSkillChain` /
   `lowerPipelineFlat` / `lowerPipelineLoop`): emits a `skill-chain`,
   `workflow-builder`, or `pipeline` artifact that a host-selected runtime
   can execute.

The package owns FlowDocument/FlowNode parsing semantics, graph validation,
semantic resolution, target routing, and lowering. Its public surface is the
`createFlowCompiler` factory and the types in `./types.ts`.

### Boundary contract — what may depend on flow-compiler

| Consumer | Allowed runtime dep | Rationale |
|---|---|---|
| `@dzupagent/flow-dsl` | No | DSL normalization must not depend on compilation; it feeds the compiler |
| `@dzupagent/flow-ast` | No | The AST parser is a lower-layer input to the compiler |
| `@dzupagent/agent` | Yes (optional) | Agents may receive a compiled `FlowCompileEvidence` or artifact as input, but the agent package must not import the compiler directly; it receives already-compiled artifacts via dependency injection |
| `@dzupagent/agent-adapters` | **No runtime dep** | The adapter workflow builder (`AdapterWorkflowBuilder`) compiles to `@dzupagent/core:PipelineDefinition`, not to a compiler artifact. It must never import `@dzupagent/flow-compiler` at runtime; the shared contract is `PipelineDefinition` only |
| Consuming apps (e.g. `codev-app`) | Yes | Application code that accepts user-authored flows calls `createFlowCompiler` to compile them before handing the artifact to a runtime |
| `@dzupagent/evals` | Yes (test fixtures) | May compile flows as test inputs; these are integration test dependencies |

`@dzupagent/agent-adapters` is the critical case. The package's own
`workflow-ownership.ts` records `flowCompilerDependency: 'none'`. This is
intentional: the `AdapterWorkflowBuilder` is a provider-oriented fluent DSL
that targets `PipelineRuntime`; adding a runtime edge to `@dzupagent/flow-compiler`
would create a transitive dependency on `@dzupagent/flow-ast` and
`@dzupagent/flow-dsl` in every downstream adapter package, which is not
warranted by the capability the builder provides.

### Boundary contract — what the compiler may depend on

The compiler may depend on:

- `@dzupagent/flow-ast` (peer dep) — provides `parseFlow` and `FlowNode` types.
- `@dzupagent/flow-dsl` (dep) — provides `prepareFlowInputFromDsl` for the
  `compileDsl()` convenience method.
- `@dzupagent/core` (peer dep) — provides `DzupEvent` / `DzupEventBus` for
  lifecycle event forwarding.

The compiler must not depend on:

- `@dzupagent/agent` — no agent-level concepts belong in a compiler.
- `@dzupagent/agent-adapters` — no adapter-layer concepts belong in a compiler.
- `@dzupagent/memory*`, `@dzupagent/rag`, `@dzupagent/context` — runtime
  services are irrelevant to static compilation.
- Any consuming application package.

## Consequences

### Positive

- The boundary is machine-checkable: a future CI lint rule can assert that
  `packages/agent-adapters` has no `import` of `@dzupagent/flow-compiler`
  at runtime (the architecture test at `src/__tests__/architecture-doc.test.ts`
  already validates the authoring-surfaces matrix).
- The adapter layer stays independently installable. Consumers that use only
  `@dzupagent/agent-adapters` do not pull in the full compiler + AST chain.
- The compiler stays independently testable: stage-by-stage unit tests do not
  need adapter registries, provider secrets, or LLM clients.
- `FlowCompileEvidence` (sourceKind, sourceHash, compileId, canonical node IDs,
  lowered target, correlation IDs) provides a stable cross-system correlation
  token without requiring runtime dependencies in the consumers that carry it.

### Negative / Trade-offs

- There is no single "compile and run" entry point in the framework. Application
  code must wire `createFlowCompiler` → artifact → runtime executor itself. This
  is intentional: the runtime choice (PipelineRuntime, SkillChainRunner, future
  targets) belongs to the application.
- Two parallel workflow DSLs (`FlowDocumentV1` / `AdapterWorkflowBuilder`) share
  only the `PipelineDefinition` contract, not semantic equivalence. Documentation
  and the authoring-surfaces matrix (`docs/flow-orchestration-authoring-surfaces.md`)
  must continue to clearly distinguish them.

## Migration path

No code changes are required by this ADR. The boundary already exists in code
(`workflow-ownership.ts`) and in documentation (authoring-surfaces matrix). This
ADR formalises the decision so future contributors have a single record to
consult before adding new dependencies between the compiler and its consumers.

If a future requirement calls for `agent-adapters` to accept compiled flow
artifacts as a first-class input (e.g. "compile a flow document, then hand it
to AdapterWorkflowBuilder"), the correct path is to add an explicit
`fromCompiledArtifact(artifact: CompileSuccess)` factory on
`AdapterWorkflowBuilder` that operates on the already-lowered `PipelineDefinition`
— not to add a runtime import of the compiler inside the adapter package.

## Related

- `dzupagent/packages/flow-compiler/src/index.ts` — public compiler surface
- `dzupagent/packages/agent-adapters/src/workflow/adapter-workflow.ts` — ownership comment (lines 8-22)
- `dzupagent/packages/agent-adapters/src/workflow/workflow-ownership.ts` — machine-readable boundary assertion
- `dzupagent/docs/flow-orchestration-authoring-surfaces.md` — authoring surface matrix
- `dzupagent/packages/agent-adapters/src/__tests__/architecture-doc.test.ts` — architectural contract tests
- L-02 finding, agent-adapters audit 2026-05-06
