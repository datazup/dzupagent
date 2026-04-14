# @dzupagent/codegen Architecture

## 1. Purpose And Scope

`@dzupagent/codegen` is the code-production runtime for DzupAgent. It combines:

- in-memory artifact staging (`VirtualFS`, `CopyOnWriteVFS`, patching, snapshots),
- LLM-driven generation and incremental editing,
- isolated execution backends (Docker/cloud/WASM/K8s),
- quality, conventions, and architecture guardrails,
- orchestration helpers for pipelines, CI fix loops, and PR lifecycle workflows.

This package is intentionally broad: it provides building blocks used by higher-level agents rather than a single monolithic "generate app" entrypoint.

## 2. Implementation Snapshot

Current package shape (from `packages/codegen/src`):

- `159` TypeScript files total
- `120` non-test TypeScript files
- `39` `*.test.ts` files
- `46` exported classes
- very large exported API surface via [`src/index.ts`](./src/index.ts)

The package depends on:

- `@dzupagent/core` for model registry, token accounting, semantic store abstractions, and shared runtime types
- `@dzupagent/agent` for `PipelineRuntime` integration in `PipelineExecutor`
- optional peers for advanced parsing/runtime:
  - `web-tree-sitter` + `tree-sitter-wasms`
  - `quickjs-emscripten` (WASM sandbox runtime)
  - `esbuild-wasm` (WASM TS transpilation)

## 3. High-Level Architecture

## 3.1 Layered View

1. **State Layer**
   - `vfs/*`: file state, snapshots, patches, checkpoints, workspace bridging

2. **Generation Layer**
   - `generation/*`: LLM file generation, code block parsing, incremental generation, test-spec generation
   - `tools/*`: LangChain/LangGraph tools for editing/generation/validation/testing

3. **Execution Layer**
   - `sandbox/*`: protocol + providers + security + pooling/auditing/volume abstractions

4. **Validation & Governance Layer**
   - `quality/*`, `validation/*`, `conventions/*`, `guardrails/*`

5. **Orchestration Layer**
   - `pipeline/*`, `correction/*`, `ci/*`, `pr/*`, `review/*`, `git/*`

6. **Code Intelligence Layer**
   - `repomap/*`, `chunking/*`, `search/*`, `contract/*`, `migration/*`, `context/*`, `adaptation/*`

## 3.2 End-To-End Flow (Typical)

```text
User Intent/Plan
  -> select context (TokenBudgetManager)
  -> generate/edit code (CodeGenService + tools)
  -> stage in VFS (VirtualFS / CopyOnWriteVFS)
  -> run checks (SandboxProtocol + WorkspaceRunner + Quality/Validators)
  -> enforce policies (ConventionGate + GuardrailEngine)
  -> orchestrate retries/escalation (PipelineExecutor + fix escalation + self-correction loop)
  -> integrate with git/PR/CI lifecycle helpers
```

## 4. Subsystem Breakdown

## 4.1 Virtual Filesystem And State Management

Key modules:

- [`vfs/virtual-fs.ts`](./src/vfs/virtual-fs.ts): `Map`-backed in-memory file store with `diff` and `merge`.
- [`vfs/cow-vfs.ts`](./src/vfs/cow-vfs.ts): copy-on-write forks with conflict detection and merge strategies (`ours` / `theirs` / `manual`).
- [`vfs/parallel-sampling.ts`](./src/vfs/parallel-sampling.ts): run N forked attempts and commit winner.
- [`vfs/patch-engine.ts`](./src/vfs/patch-engine.ts): unified diff parse/apply with fuzz matching and rollback-capable patch sets.
- [`vfs/vfs-snapshot.ts`](./src/vfs/vfs-snapshot.ts): pluggable persistence for snapshot save/load.
- [`vfs/checkpoint-manager.ts`](./src/vfs/checkpoint-manager.ts): shadow-git checkpointing for real workdir rollback.
- [`vfs/workspace-runner.ts`](./src/vfs/workspace-runner.ts): push VFS to sandbox, run command, optionally sync changed files back.

Notable characteristics:

- cheap branching for speculative generation is first-class (`CopyOnWriteVFS`).
- patching is structured and typed (hunk-level result diagnostics).
- checkpointing is non-fatal and isolated from user `.git` metadata.

## 4.2 Generation Engine

Key modules:

- [`generation/code-gen-service.ts`](./src/generation/code-gen-service.ts): model invocation wrapper; builds prompt from target path + purpose + optional context/reference files.
- [`generation/code-block-parser.ts`](./src/generation/code-block-parser.ts): fenced code extraction and language detection by extension.
- [`generation/incremental-gen.ts`](./src/generation/incremental-gen.ts): section-aware replace/add/delete editing and focused incremental prompts.
- [`generation/test-generator.ts`](./src/generation/test-generator.ts): test strategy detection + export extraction + prompt/spec generation.

Core behavior:

- output extraction prefers largest fenced block.
- generation is language-hinted by target file extension.
- incremental editing tracks changed vs preserved lines for analysis.

## 4.3 Sandbox Infrastructure

Core contract:

- [`sandbox/sandbox-protocol.ts`](./src/sandbox/sandbox-protocol.ts): `execute`, `uploadFiles`, `downloadFiles`, `cleanup`, `isAvailable`.

Provider implementations:

- [`sandbox/docker-sandbox.ts`](./src/sandbox/docker-sandbox.ts)
- [`sandbox/e2b-sandbox.ts`](./src/sandbox/e2b-sandbox.ts)
- [`sandbox/fly-sandbox.ts`](./src/sandbox/fly-sandbox.ts)
- [`sandbox/k8s/k8s-sandbox.ts`](./src/sandbox/k8s/k8s-sandbox.ts)
- [`sandbox/wasm/wasm-sandbox.ts`](./src/sandbox/wasm/wasm-sandbox.ts)
- [`sandbox/mock-sandbox.ts`](./src/sandbox/mock-sandbox.ts)
- provider selector: [`sandbox/sandbox-factory.ts`](./src/sandbox/sandbox-factory.ts)

Security & reliability helpers:

- permission tiers: [`sandbox/permission-tiers.ts`](./src/sandbox/permission-tiers.ts)
- security profiles: [`sandbox/security-profile.ts`](./src/sandbox/security-profile.ts)
- hardened Docker flags + escape detection: [`sandbox/sandbox-hardening.ts`](./src/sandbox/sandbox-hardening.ts)
- pooled reuse: [`sandbox/pool/sandbox-pool.ts`](./src/sandbox/pool/sandbox-pool.ts)
- reset strategies: [`sandbox/pool/sandbox-reset.ts`](./src/sandbox/pool/sandbox-reset.ts)
- audit decorator + hash chain store: [`sandbox/audit/audited-sandbox.ts`](./src/sandbox/audit/audited-sandbox.ts), [`sandbox/audit/memory-audit-store.ts`](./src/sandbox/audit/memory-audit-store.ts)
- in-memory volume manager: [`sandbox/volumes/memory-volume-manager.ts`](./src/sandbox/volumes/memory-volume-manager.ts)

WASM path details:

- filesystem and capabilities are usable even without QuickJS runtime.
- runtime execution is optional and guarded by dynamic imports.
- TS transpilation supports `esbuild-wasm` or regex-based fallback.

## 4.4 Quality, Validation, Conventions, Guardrails

Quality and validation:

- scorer: [`quality/quality-scorer.ts`](./src/quality/quality-scorer.ts)
- built-in dimensions: [`quality/quality-dimensions.ts`](./src/quality/quality-dimensions.ts)
  - type strictness
  - lint cleanliness heuristics
  - test presence heuristics
  - completeness checks
  - JSDoc checks
- import coherence:
  - VFS-centric validator: [`validation/import-validator.ts`](./src/validation/import-validator.ts)
  - multi-file graph validator: [`quality/import-validator.ts`](./src/quality/import-validator.ts)
- contract validation: [`quality/contract-validator.ts`](./src/quality/contract-validator.ts)
- static coverage approximation: [`quality/coverage-analyzer.ts`](./src/quality/coverage-analyzer.ts)

Conventions:

- detection: [`conventions/convention-detector.ts`](./src/conventions/convention-detector.ts)
- enforcement and prompt injection: [`conventions/convention-enforcer.ts`](./src/conventions/convention-enforcer.ts)
- gate abstraction: [`quality/convention-gate.ts`](./src/quality/convention-gate.ts)

Architecture guardrails:

- rule engine: [`guardrails/guardrail-engine.ts`](./src/guardrails/guardrail-engine.ts)
- types/reporting: [`guardrails/guardrail-types.ts`](./src/guardrails/guardrail-types.ts), [`guardrails/guardrail-reporter.ts`](./src/guardrails/guardrail-reporter.ts)
- learning conventions from codebase: [`guardrails/convention-learner.ts`](./src/guardrails/convention-learner.ts)
- built-in rules (`layering`, import restriction, naming, security, type-safety, contract compliance):
  - [`guardrails/rules/index.ts`](./src/guardrails/rules/index.ts)

## 4.5 Pipeline And Control Flow

Primary pipeline modules:

- declarative config builder: [`pipeline/gen-pipeline-builder.ts`](./src/pipeline/gen-pipeline-builder.ts)
- runtime executor: [`pipeline/pipeline-executor.ts`](./src/pipeline/pipeline-executor.ts)
- escalation policy: [`pipeline/fix-escalation.ts`](./src/pipeline/fix-escalation.ts)
- phase predicates: [`pipeline/phase-conditions.ts`](./src/pipeline/phase-conditions.ts)
- optional gate stage: [`pipeline/guardrail-gate.ts`](./src/pipeline/guardrail-gate.ts)

Execution model:

- phases are topologically sorted by `dependsOn`,
- then executed in pipeline order with per-phase timeout/retry logic,
- state is mutable shared context (`Record<string, unknown>`),
- optional guardrail gate can fail a phase post-generation.

## 4.6 Self-Correction And Learning Loop

Modules:

- [`correction/self-correction-loop.ts`](./src/correction/self-correction-loop.ts)
- [`correction/reflection-node.ts`](./src/correction/reflection-node.ts)
- [`correction/lesson-extractor.ts`](./src/correction/lesson-extractor.ts)
- [`correction/correction-types.ts`](./src/correction/correction-types.ts)

Loop stages:

1. evaluate current snapshot,
2. reflect root cause (LLM or fallback heuristic),
3. apply fix via injected fixer,
4. iterate with cost/iteration guards,
5. extract reusable lessons after success.

This subsystem is strongly interface-driven (`CodeEvaluator`, `CodeFixer`) to keep execution strategy pluggable.

## 4.7 Code Intelligence (Map, AST, Search)

Modules:

- regex symbols: [`repomap/symbol-extractor.ts`](./src/repomap/symbol-extractor.ts)
- AST symbols with tree-sitter fallback: [`repomap/tree-sitter-extractor.ts`](./src/repomap/tree-sitter-extractor.ts)
- import graph: [`repomap/import-graph.ts`](./src/repomap/import-graph.ts)
- budgeted repo map: [`repomap/repo-map-builder.ts`](./src/repomap/repo-map-builder.ts)
- AST chunking: [`chunking/ast-chunker.ts`](./src/chunking/ast-chunker.ts)
- semantic indexing/search: [`search/code-search-service.ts`](./src/search/code-search-service.ts)

Design intent:

- provide compact, high-signal context to generation/reflection loops,
- support semantic retrieval via `SemanticStore` from `@dzupagent/core`,
- degrade gracefully when tree-sitter dependencies are unavailable.

## 4.8 Git, PR, CI, Review, Migration, Adaptation

Git helpers:

- executor/tools/context/worktrees:
  - [`git/git-executor.ts`](./src/git/git-executor.ts)
  - [`git/git-tools.ts`](./src/git/git-tools.ts)
  - [`git/git-middleware.ts`](./src/git/git-middleware.ts)
  - [`git/git-worktree.ts`](./src/git/git-worktree.ts)

PR + review:

- state machine and action planning: [`pr/pr-manager.ts`](./src/pr/pr-manager.ts)
- review feedback parsing: [`pr/review-handler.ts`](./src/pr/review-handler.ts)
- static review rules and markdown formatting:
  - [`review/review-rules.ts`](./src/review/review-rules.ts)
  - [`review/code-reviewer.ts`](./src/review/code-reviewer.ts)

CI fix loop:

- monitor and categorize failures: [`ci/ci-monitor.ts`](./src/ci/ci-monitor.ts)
- route to strategy: [`ci/failure-router.ts`](./src/ci/failure-router.ts)
- generate attempt prompts: [`ci/fix-loop.ts`](./src/ci/fix-loop.ts)

Migration and framework/language adaptation:

- framework mapping/guides: [`adaptation/framework-adapter.ts`](./src/adaptation/framework-adapter.ts)
- file path mapping: [`adaptation/path-mapper.ts`](./src/adaptation/path-mapper.ts)
- language-specific prompt and commands: [`adaptation/languages/language-config.ts`](./src/adaptation/languages/language-config.ts)
- migration planning and prompt scaffolding: [`migration/migration-planner.ts`](./src/migration/migration-planner.ts)

## 5. Public Feature Catalog

## 5.1 Core Generation Features

- LLM file generation with reference/context injection.
- incremental section-level regeneration.
- test specification generation from exports and file role.
- code block extraction and language detection.

## 5.2 Safety And Validation Features

- multi-backend isolated command execution.
- sandbox security tiers and hardened flags.
- audit trails with secret redaction and hash-chain verification.
- quality scoring dimensions and import/contract validation.
- convention and guardrail-based policy gates.

## 5.3 Orchestration Features

- configurable multi-phase pipelines with retries/timeouts.
- fix escalation policies (`targeted` -> `expanded` -> `escalated`).
- self-correction loop with reflection and lesson extraction.
- CI failure routing and automated fix attempt prompt generation.
- PR lifecycle state transitions and review feedback consolidation.

## 5.4 Code Intelligence Features

- regex and AST symbol extraction.
- import graph and repo map generation.
- AST-aware chunking for better embedding/search quality.
- semantic code search over chunked source.
- phase-aware token budget management for context packing.

## 6. How To Use (Practical Recipes)

## 6.1 Minimal File Generation

```ts
import { CodeGenService } from '@dzupagent/codegen'
import type { ModelRegistry } from '@dzupagent/core'

const codegen = new CodeGenService(modelRegistry as ModelRegistry, {
  modelTier: 'codegen',
})

const result = await codegen.generateFile(
  {
    filePath: 'src/services/user.service.ts',
    purpose: 'User CRUD service with input validation',
    context: { stack: 'node + typescript + vitest' },
  },
  'You are a strict TypeScript generator. Return complete compilable code.'
)
```

## 6.2 VFS-Centric Workflow With Quality Checks

```ts
import {
  VirtualFS,
  QualityScorer,
  builtinDimensions,
  validateImports,
} from '@dzupagent/codegen'

const vfs = new VirtualFS()
vfs.write('src/foo.ts', 'export const foo = 1')
vfs.write('src/foo.test.ts', 'import { foo } from "./foo.js"; test("x", () => expect(foo).toBe(1))')

const importCheck = validateImports(vfs)
const scorer = new QualityScorer().addDimensions(builtinDimensions)
const quality = await scorer.evaluate(vfs.toSnapshot())
```

## 6.3 Execute Checks In A Sandbox

```ts
import { createSandbox, WorkspaceRunner } from '@dzupagent/codegen'

const sandbox = createSandbox({ provider: 'mock' }) // or docker/e2b/fly
const runner = new WorkspaceRunner(sandbox)

const run = await runner.run(vfs, {
  command: 'npm test',
  timeoutMs: 60_000,
  syncBack: false,
})
```

## 6.4 Build And Run A Pipeline

```ts
import { PipelineExecutor, DEFAULT_ESCALATION } from '@dzupagent/codegen'

const executor = new PipelineExecutor({
  defaultTimeoutMs: 120_000,
  defaultMaxRetries: 1,
})

const result = await executor.execute(
  [
    {
      id: 'generate',
      name: 'Generate',
      execute: async (state) => ({ ...state, generated: true }),
      maxRetries: 2,
      retryStrategy: 'backoff',
    },
    {
      id: 'validate',
      name: 'Validate',
      dependsOn: ['generate'],
      execute: async () => ({ valid: true, escalation: DEFAULT_ESCALATION }),
    },
  ],
  {}
)
```

## 6.5 Enforce Architecture Guardrails

```ts
import {
  GuardrailEngine,
  GuardrailReporter,
  createBuiltinRules,
  runGuardrailGate,
} from '@dzupagent/codegen'

const engine = new GuardrailEngine().addRules(createBuiltinRules())
const reporter = new GuardrailReporter({ format: 'text' })

const gate = runGuardrailGate(
  { engine, strictMode: false, reporter },
  guardrailContext
)
```

## 6.6 Semantic Code Search

```ts
import { CodeSearchService } from '@dzupagent/codegen'

const search = new CodeSearchService(semanticStore, {
  collectionName: 'code_chunks',
})
await search.init()
await search.indexFiles(filesToIndex)

const results = await search.search('authentication middleware', {
  limit: 10,
  language: 'typescript',
})
```

## 6.7 CI Failure Routing

```ts
import { generateFixAttempts } from '@dzupagent/codegen'

const attempts = generateFixAttempts(ciFailures, {
  maxTotalAttempts: 5,
})
// each attempt includes a strategy-specific prompt
```

## 7. Extension Points

Most important customization seams:

- **Sandbox backend**: implement `SandboxProtocol`.
- **Quality model**: add custom `QualityDimension` and plug into `QualityScorer`.
- **Pipeline control**: custom `PhaseConfig` logic + conditions + retries/timeouts.
- **Guardrails**: add `GuardrailRule` implementations and/or tune severity overrides.
- **Convention inference/enforcement**: extend detector/enforcer and `ConventionGate`.
- **Context packing**: implement custom `FileRoleDetector` and `PhasePriorityMatrix`.
- **Correction loop**: inject custom `CodeEvaluator`/`CodeFixer`.
- **Search backend**: supply any `SemanticStore` implementation from `@dzupagent/core`.

## 8. Current Implementation Notes And Trade-Offs

1. `GenPipelineBuilder` is a configuration DSL, not a graph compiler. Domain layers must still define concrete graph topology/routing.
2. `PipelineExecutor` supports dependency checks, retries, and timeouts, but actual runtime node graph wiring is sequential after topological sort.
3. Several modules intentionally use regex heuristics for portability (conventions, review, import/contract checks). This is fast but less precise than full AST analysis.
4. Tree-sitter and WASM runtimes are optional; many features degrade gracefully when these peers are missing.
5. `createWriteFileTool` returns action metadata rather than mutating VFS directly; callers are expected to apply state updates.
6. Docker sandbox is hardened by default and configured for strict isolation; workflows needing broad write/network capabilities should choose/tune provider/profile accordingly.

## 9. Testing Posture

The package includes extensive unit tests in `src/__tests__`, covering:

- VFS behaviors (`virtual-fs`, `cow-vfs`, snapshots, patch engine, workspace runner),
- sandbox protocols and limits (mock/docker/wasm/k8s/factory/hardening),
- generation helpers (incremental edits, test generation, parser utilities),
- quality and guardrails,
- pipeline executor and correction loop,
- code search/repo map and migration planner,
- git and review utilities, with partial CI/PR coverage.

Use package-local checks:

```bash
yarn workspace @dzupagent/codegen test
yarn workspace @dzupagent/codegen typecheck
yarn workspace @dzupagent/codegen lint
```

For monorepo validation use top-level Turbo commands (`yarn test`, `yarn verify`, etc.).

## 10. Feature-To-Test Coverage Matrix

This matrix maps major implemented features to the tests that currently exercise them.

## 10.1 VFS, Patching, Checkpointing, Workspace Bridging

- `VirtualFS` core behavior:
  - `src/__tests__/vfs.test.ts`
- `CopyOnWriteVFS` (fork/merge/conflicts/depth):
  - `src/__tests__/vfs/cow-vfs.test.ts`
  - `src/__tests__/vfs/cow-vfs-extended.test.ts`
- snapshots:
  - `src/__tests__/vfs-snapshot.test.ts`
- unified patch engine:
  - `src/__tests__/patch-engine.test.ts`
- workspace execution bridge:
  - `src/__tests__/workspace-runner.test.ts`
- shadow git checkpoint manager:
  - `src/__tests__/checkpoint-manager.test.ts`

## 10.2 Sandbox Providers, Security, Limits

- protocol/factory/provider selection:
  - `src/__tests__/sandbox-protocol-and-factory.test.ts`
- infrastructure and integration-oriented behavior:
  - `src/__tests__/sandbox-infrastructure.test.ts`
- security and resource constraints:
  - `src/__tests__/sandbox-limits.test.ts`
- WASM sandbox behaviors:
  - `src/__tests__/wasm-sandbox.test.ts`
- K8s sandbox adapter:
  - `src/__tests__/k8s-sandbox.test.ts`

## 10.3 Generation And Tools

- incremental editing + test-spec generation:
  - `src/__tests__/incremental-gen-and-test-generator.test.ts`
- edit/multi-edit tools:
  - `src/__tests__/edit-file-tool.test.ts`
  - `src/__tests__/multi-edit-tool.test.ts`
- validate tool:
  - `src/__tests__/validate-tool.test.ts`
- lint validator:
  - `src/__tests__/lint-validator.test.ts`
- tool integration suite:
  - `src/__tests__/tools-suite.test.ts`

## 10.4 Quality, Validation, Conventions, Guardrails

- quality scorer:
  - `src/__tests__/quality-scorer.test.ts`
- built-in quality dimensions:
  - `src/__tests__/quality-dimensions.test.ts`
- import validation:
  - `src/__tests__/import-validator.test.ts`
- convention gate:
  - `src/__tests__/convention-gate.test.ts`
- convention detection + framework/language adapters:
  - `src/__tests__/convention-detector-and-adapters.test.ts`
- architecture guardrails and rules:
  - `src/__tests__/guardrails.test.ts`

## 10.5 Pipeline And Self-Correction

- pipeline executor:
  - `src/__tests__/pipeline-executor.test.ts`
  - `src/__tests__/pipeline-executor-extended.test.ts`
- self-correction loop:
  - `src/__tests__/self-correction-loop.test.ts`
  - `src/__tests__/self-correction-loop-extended.test.ts`
- lesson extractor + reflection node:
  - `src/__tests__/lesson-extractor-and-reflection.test.ts`

## 10.6 Code Intelligence And Context Management

- tree-sitter extraction:
  - `src/__tests__/tree-sitter-extractor.test.ts`
- AST chunking:
  - `src/__tests__/ast-chunker.test.ts`
- repo map:
  - `src/__tests__/repo-map.test.ts`
- import graph (extended):
  - `src/__tests__/import-graph-extended.test.ts`
- semantic search service:
  - `src/__tests__/code-search-service.test.ts`
- token budget and role/priority selection:
  - `src/__tests__/token-budget.test.ts`

## 10.7 Git, Review, Contract Validation, Migration

- git executor:
  - `src/__tests__/git-executor.test.ts`
- git tools:
  - `src/__tests__/git-tools.test.ts`
- code review engine and markdown formatting:
  - `src/__tests__/code-review.test.ts`
- contract validator scenarios (within code review suite):
  - `src/__tests__/code-review.test.ts`
- migration planner:
  - `src/__tests__/migration-planner.test.ts`

## 11. Coverage Gaps And Recommendations

Based on the current suite, these modules have weaker or no direct dedicated tests:

- `src/ci/*` (monitor, failure-router, fix-loop)
- `src/pr/*` (PR state machine, review handler)
- parts of `src/sandbox/audit/*`, `src/sandbox/pool/*`, and `src/sandbox/volumes/*`
- `src/generation/code-gen-service.ts` and `src/generation/code-block-parser.ts` direct unit coverage is limited compared to surrounding utilities
- `src/git/git-worktree.ts` and `src/git/commit-message.ts` direct dedicated tests are not visible in the current package test inventory

Recommended update policy when adding/changing features:

1. Add or update at least one dedicated `*.test.ts` for each changed module.
2. Add one cross-module integration test when behavior spans VFS + sandbox + validation/pipeline.
3. Update this matrix in the same PR so architecture and test coverage stay synchronized.
