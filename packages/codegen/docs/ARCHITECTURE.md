# @dzipagent/codegen Architecture

## Purpose
`@dzipagent/codegen` provides the generation pipeline and execution environment for code-producing agents. It combines virtual filesystem staging, LLM generation services, sandboxed validation, quality scoring, and pipeline orchestration for iterative code synthesis.

## Main Responsibilities
- Stage generated code safely in an in-memory filesystem (`VirtualFS`).
- Generate/edit files using LLM-aware generation services and tools.
- Validate generated outputs through lint/test/typecheck-capable sandbox protocols.
- Score quality across multiple dimensions and enforce contract/import coherence.
- Build multi-phase generation pipelines with retry and escalation strategies.
- Integrate git context, worktrees, PR/review helpers, and repo mapping.

## Module Structure
Top-level modules under `src/`:
- `vfs/`: `VirtualFS`, snapshots, checkpoints.
- `generation/`: code generation service, code block parsing, incremental generation, test generation.
- `sandbox/`: Docker/E2B/Fly/Mock/WASM/K8s backends, hardening, pools, volumes, audit.
- `quality/` + `validation/`: quality scorer, dimensions, coverage/import/contract validators.
- `pipeline/`: pipeline builder/executor, phase conditions, fix escalation strategy.
- `tools/`: file write/edit/multi-edit/generate/validate/test tools.
- `git/`, `repomap/`, `review/`, `pr/`, `ci/`, `migration/`, `conventions/`, `adaptation/`, `context/`.

## How It Works (Generation Flow)
1. Generation request enters with target path + intent/context.
2. `CodeGenService` builds prompt/context and requests model output.
3. Output is parsed into code blocks and written into `VirtualFS`.
4. Validation tools run via sandbox protocol (lint/typecheck/tests).
5. `QualityScorer` computes weighted quality dimensions.
6. If quality/validation fails, pipeline escalates fix strategy and retries.
7. Successful artifacts can be persisted/applied outside VFS.

## Pipeline Architecture
- `GenPipelineBuilder` defines ordered phases and predicates.
- `PipelineExecutor` runs phases with shared state and result capture.
- `fix-escalation` defines progressively stronger remediation attempts.
- Phase conditions (`allOf`, `anyOf`, `hasFilesMatching`, etc.) gate execution.

## Main Features
- Multi-backend sandboxing for safe execution and verification.
- Incremental code editing and test-generation helpers.
- Contract extraction and API coherence checks.
- Repo map and symbol/import graph extraction for context-aware generation.
- Git automation tools and PR/review utilities for autonomous fix loops.

## Integration Boundaries
- Depends on `@dzipagent/core` for shared agent primitives.
- Commonly consumed by `@dzipagent/agent` workflows and server-run pipelines.
- Supports LangGraph/LangChain tool interfaces via exported tool factories.

## Extensibility Points
- Implement custom `SandboxProtocol` providers.
- Add custom quality dimensions and scoring weights.
- Add new pipeline phase types and escalation logic.
- Add language/framework adapters and conventions detectors.

## Quality and Test Posture
- Test suite includes tool editing, import/lint validation, and sandbox backends; architecture favors isolatable modules for high testability.
