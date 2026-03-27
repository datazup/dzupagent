# @dzipagent/agent Architecture

## Purpose
`@dzipagent/agent` is the orchestration layer that turns lower-level core primitives into a production agent runtime. Its central type is `DzipAgent`, which supports direct generation, streaming, tool-calling loops, workflow composition, orchestration patterns, and safety guardrails.

## Main Responsibilities
- Provide `DzipAgent` for `generate()`, `stream()`, and tool-wrapped usage.
- Execute ReAct-style tool loops with iteration and budget controls.
- Apply guardrails (iteration/token/cost, stuck detection, cascading timeout, output filtering).
- Support multi-agent orchestration (supervisor, contract-net bidding, topology execution, map-reduce).
- Provide reusable workflow and pipeline runtimes (including checkpoints and templates).
- Support structured output generation and schema compatibility utilities.

## Module Structure
Top-level modules under `src/`:
- `agent/`: `DzipAgent`, tool loop, dynamic tool registry, state serialization helpers.
- `guardrails/`: `IterationBudget`, `StuckDetector`, `CascadingTimeout`.
- `workflow/`: workflow builder and compiled workflow executor.
- `orchestration/`: supervisor, map-reduce, merge strategies, contract-net, topology analysis/execution.
- `pipeline/`: runtime, loop executor, validator, analytics, checkpoint store, templates.
- `structured/`: structured output strategy detection and generation pipeline.
- `approval/`: human-in-the-loop approval gate.
- `security/`: `AgentAuth` and signed message support.
- `snapshot/`: snapshot creation/verification/compression and message migration.
- `templates/`, `tools/`, `streaming/`, `playground/`.

## How It Works (Generate Flow)
1. Construct `DzipAgent` with model, tools, guardrails, and optional hooks/config.
2. `generate()` prepares message context (system prompt, optional compression/summaries, memory context).
3. Agent binds tools to model and executes `runToolLoop`.
4. Guardrail budget is checked per iteration and token usage update.
5. Tool calls/results are appended into the message trace.
6. Final AI message is extracted and optional output filter is applied.
7. Summary state is updated for future turns.

## How It Works (Stream Flow)
1. `stream()` runs iterative model invocation.
2. Incremental content chunks emit `text` events.
3. Tool call/result phases emit stream events.
4. Budget warnings emit early for observability and control.
5. Completion/error events terminate the stream with final usage state.

## Main Features
- Unified agent API across interactive and programmatic contexts.
- Rich orchestration models: supervisor delegation, contract-net, topology-aware execution.
- Pipeline runtime with analytics and checkpointing.
- Built-in template library + runtime template composition.
- Structured output with strategy detection by model capabilities.
- Snapshot and signed-message utilities for portability and integrity.

## Integration Boundaries
- Depends on `@dzipagent/core`, `@dzipagent/context`, and `@dzipagent/memory-ipc`.
- Commonly hosted by `@dzipagent/server`.
- Often combined with `@dzipagent/codegen` tools and `@dzipagent/connectors` integrations.

## Extensibility Points
- Register tools dynamically with `DynamicToolRegistry`.
- Customize merge strategies in orchestration pipelines.
- Add custom workflow and pipeline node executors.
- Add/compose templates via `TemplateRegistry`.
- Plug in custom approval and output filtering policies.

## Quality and Test Posture
- Extensive test coverage across guardrails, workflows, orchestration, pipeline, structured output, approvals, and snapshots (`18` package-level tests).
