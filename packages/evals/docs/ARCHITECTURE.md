# @dzipagent/evals Architecture

## Purpose
`@dzipagent/evals` is the evaluation subsystem for agent outputs. It supports deterministic and LLM-judge scoring, dataset loading/filtering/sampling, benchmark suites, and concurrent runner execution with regression checks.

## Main Responsibilities
- Represent eval datasets as immutable collections.
- Execute evaluators/scorers over datasets with concurrency controls.
- Aggregate multi-scorer results into composite reports.
- Provide benchmark suites for common task categories.
- Detect performance regressions against baseline scores.

## Module Structure
Top-level modules under `src/`:
- `dataset/`: dataset model and loaders (JSON, JSONL, CSV).
- `scorers/`: deterministic, enhanced deterministic, and LLM-judge scorers.
- `composite-scorer.ts`: weighted score combination.
- `runner/` + `eval-runner.ts`: concurrent execution, progress, abort, regression checks.
- `benchmarks/`: benchmark runner and built-in suites (`qa`, `tool-use`, `multi-turn`, `code-gen`, `vector-search`).
- `types.ts`: shared data contracts.

## How It Works
1. Build/load dataset entries.
2. Configure one or more scorers.
3. `EvalRunner` executes cases concurrently and captures per-scorer metrics.
4. Aggregation computes pass rates, averages, and detailed case-level output.
5. Optional regression step compares against baseline thresholds.
6. Report formatters produce CI-friendly artifacts.

## Main Features
- Deterministic validation modes (exact/contains/regex/schema-style checks).
- LLM-as-judge evaluation with criterion-level reasoning.
- Weighted composite scoring for nuanced quality bars.
- Reproducible sampling for stable benchmark subsets.
- Built-in benchmark suites aligned to common agent workloads.

## Integration Boundaries
- Depends on `@dzipagent/core` for base runtime compatibility.
- Used in CI and quality gates for agent/codegen release confidence.
- LLM scorer mode plugs into user-provided model invocation function.

## Extensibility Points
- Add custom scorer implementations.
- Add custom benchmark suites.
- Add organization-specific report formatters and regression policies.

## Quality and Test Posture
- Test suite validates dataset parsing, scorers, and runner behavior including enhanced evaluator paths.
