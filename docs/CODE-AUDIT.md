# Code Quality Audit

## Findings

### CODE-001 - High - Drizzle persistence boundaries repeatedly erase schema types with `any`

Impact: Persistent stores can drift from Drizzle schema contracts without TypeScript catching it. These classes perform writes, reads, and row-to-domain conversion for scheduled jobs, triggers, mailbox DLQ, A2A tasks, and related runtime state, so a column rename, nullable-field change, or row shape mismatch can compile and fail only in runtime paths.

Evidence: `packages/server/src/triggers/trigger-store.ts:87` disables `@typescript-eslint/no-explicit-any` and defines `type AnyDrizzle = any`, then injects it into `DrizzleTriggerStore` at `packages/server/src/triggers/trigger-store.ts:106`. The same pattern exists in `packages/server/src/schedules/schedule-store.ts:86`, `packages/server/src/persistence/drizzle-dlq-store.ts:21`, and `packages/server/src/a2a/drizzle-a2a-task-store.ts:27`. The A2A store even defines a typed `DrizzleA2ADatabase` at `packages/server/src/a2a/drizzle-a2a-task-store.ts:20`, but the constructor still takes `AnyDrizzle` at `packages/server/src/a2a/drizzle-a2a-task-store.ts:60`.

Remediation: Replace local `AnyDrizzle` aliases with a shared typed DB interface derived from the repository's Drizzle schema, or with narrow per-store interfaces that model only the operations each store uses. Keep row conversion behind explicit parser/mapper functions and add type-level compile tests for representative store methods.

### CODE-002 - Medium - Streaming and non-streaming tool execution duplicate the same policy stack

Impact: The agent tool path has two near-parallel implementations for timeout classification, schema extraction, argument validation, lifecycle event emission, stuck detection, and result/error shaping. Any future fix to approval, telemetry, timeout, validation, or governance behavior must be patched twice, which increases regression risk between `generate()` and streaming execution.

Evidence: The non-streaming path in `packages/agent/src/agent/tool-loop.ts` defines timeout classification at `packages/agent/src/agent/tool-loop.ts:738`, event emitters starting at `packages/agent/src/agent/tool-loop.ts:751`, approval handling at `packages/agent/src/agent/tool-loop.ts:1134`, parallel execution ordering at `packages/agent/src/agent/tool-loop.ts:1593`, and timeout racing at `packages/agent/src/agent/tool-loop.ts:1643`. The streaming path repeats equivalent helpers in `packages/agent/src/agent/run-engine.ts:500`, `packages/agent/src/agent/run-engine.ts:506`, `packages/agent/src/agent/run-engine.ts:513`, `packages/agent/src/agent/run-engine.ts:521`, and timeout handling at `packages/agent/src/agent/run-engine.ts:722`.

Remediation: Extract a shared tool execution policy module that accepts mode-specific adapters for message construction and event output. Keep a focused parity test that runs the same tool scenarios through streaming and non-streaming execution and asserts identical lifecycle statuses.

### CODE-003 - Medium - Timeout detection depends on parsing human-readable error messages

Impact: Timeout classification is a fragile invariant. If an error message changes, is localized, is wrapped by another layer, or comes from a tool with a similar string, the lifecycle status can silently flip between `timeout` and generic `error`, which affects event consumers and retry/circuit-breaker logic.

Evidence: `packages/agent/src/agent/tool-loop.ts:738` classifies timeouts with `/timed out after \d+ms/.test(msg)`, while `packages/agent/src/agent/run-engine.ts:506` repeats the same message regex. Both timeout helpers construct the message string themselves at `packages/agent/src/agent/tool-loop.ts:1655` and `packages/agent/src/agent/run-engine.ts:734`, coupling classification to text formatting instead of a typed error.

Remediation: Introduce a `ToolTimeoutError` or `ForgeError` code for timeout failures and classify by `instanceof` or error code. Keep the message for humans, but make lifecycle status derive from typed metadata.

### CODE-004 - Medium - Several runtime modules are large enough to hide unrelated responsibilities and invariants

Impact: Large files concentrate multiple behaviors, making review and regression testing harder. This is true maintainability risk rather than formatting noise because the largest files mix policy decisions, event emission, state transitions, parsing/validation, and fallback behavior.

Evidence: Static line counts show `packages/agent/src/agent/tool-loop.ts` at 1,665 lines, `packages/flow-ast/src/validate.ts` at 1,522 lines, `packages/agent-adapters/src/recovery/adapter-recovery.ts` at 1,281 lines, `packages/agent/src/agent/run-engine.ts` at 1,070 lines, and `packages/agent/src/pipeline/pipeline-runtime.ts` at 1,024 lines. In `tool-loop.ts`, the same file owns core loop config (`packages/agent/src/agent/tool-loop.ts:77`), lifecycle event emission (`packages/agent/src/agent/tool-loop.ts:751`), governance/approval handling (`packages/agent/src/agent/tool-loop.ts:1134`), parallel scheduling (`packages/agent/src/agent/tool-loop.ts:1554`), and timeout racing (`packages/agent/src/agent/tool-loop.ts:1643`). In `validate.ts`, the file implements a hand-rolled schema surface and every node validator in one module (`packages/flow-ast/src/validate.ts:1`, `packages/flow-ast/src/validate.ts:510`, `packages/flow-ast/src/validate.ts:554`).

Remediation: Split by responsibility, not by arbitrary line count. Good first candidates are shared tool lifecycle helpers, timeout/error helpers, flow node validators grouped by node family, and adapter recovery terminal-result builders. Preserve public exports while moving internals behind package-private modules.

### CODE-005 - Medium - Coverage gates do not cover all runtime packages and zero-test detection is package-level only

Impact: The repo has meaningful quality gates, but they leave blind spots. File-level untested code can accumulate inside packages that have any tests, and packages without `test:coverage` scripts are excluded from the workspace coverage gate entirely.

Evidence: `scripts/check-runtime-test-inventory.mjs:127` only fails packages whose total test count is zero. A static inventory found 655 production source files without a same-name or nearby `__tests__` match, concentrated in `packages/core` (134), `packages/server` (97), `packages/agent` (91), `packages/codegen` (60), `packages/memory` (36), and `packages/agent-adapters` (36). Examples with no direct test match include `packages/codegen/src/sandbox/e2b-sandbox.ts`, `packages/codegen/src/sandbox/fly-sandbox.ts`, `packages/code-edit-kit/src/atomic-multi-edit.tool.ts`, and `packages/memory/src/sharing/memory-space-manager.ts`. `scripts/check-workspace-coverage.mjs:70` discovers only packages with a `test:coverage` script, and `coverage-thresholds.json:8` tracks a subset explicitly; packages such as `@dzupagent/flow-ast`, `@dzupagent/flow-compiler`, `@dzupagent/app-tools`, and `@dzupagent/code-edit-kit` have normal `test` scripts but no `test:coverage` script (`packages/flow-ast/package.json:17`, `packages/app-tools/package.json:17`, `packages/code-edit-kit/package.json:17`).

Remediation: Add a file-level critical-source inventory for high-risk packages and require explicit waivers for untested runtime files above a complexity threshold. Add `test:coverage` scripts or explicit coverage waivers for runtime packages that currently sit outside the coverage gate.

### CODE-006 - Medium - Stored memory-sharing records are trusted after shallow shape checks

Impact: Shared memory spaces and pending share requests are persisted as generic records and later cast into domain objects. The current guards check only a few top-level fields, so corrupted or older records with malformed participants, requests, permissions, or retention policy can flow into permission checks and writes.

Evidence: `MemorySpaceManager.create` stores a full `SharedMemorySpace` by casting it to `Record<string, unknown>` at `packages/memory/src/sharing/memory-space-manager.ts:121`. `reviewPullRequest` casts the first stored pending record directly to `PendingShareRequest` at `packages/memory/src/sharing/memory-space-manager.ts:302`. The helpers at `packages/memory/src/sharing/memory-space-manager.ts:742` and `packages/memory/src/sharing/memory-space-manager.ts:750` validate only `id`, `name`, `owner`, `request`, and `status`, then `toSpace` and `toPending` cast the full object at `packages/memory/src/sharing/memory-space-manager.ts:746` and `packages/memory/src/sharing/memory-space-manager.ts:754`.

Remediation: Replace shallow predicates with full runtime decoders for `SharedMemorySpace` and `PendingShareRequest`, including participant permissions, request shape, timestamps, and optional policies. Add tests for malformed stored records and backward-compatible migrations.

### CODE-007 - Low - A2A task list says it batch-loads messages but still executes one query per task

Impact: The comment and implementation disagree, and future maintainers may assume list performance has already been addressed. This is a maintainability and scalability trap in a route-facing persistent store.

Evidence: `packages/server/src/a2a/drizzle-a2a-task-store.ts:174` says `Batch-load messages for all tasks`, but the implementation loops over rows and performs a separate `select().from(a2aTaskMessages).where(eq(...))` for each row at `packages/server/src/a2a/drizzle-a2a-task-store.ts:176`.

Remediation: Either implement actual batch loading with an `IN` query grouped by `taskId`, or change the comment and add a limit/justification test so the N+1 behavior is explicit.

### CODE-008 - Low - Flow lowering can continue with stub tool nodes after a missing semantic resolution

Impact: This keeps downstream compilation alive after an invariant violation, but it can also make failures harder to localize because a missing semantic resolution becomes a warning plus a synthetic tool node. That is useful for best-effort diagnostics, but fragile if any caller treats lowered output as executable.

Evidence: `packages/flow-compiler/src/lower/_shared.ts:289` notes that the semantic stage should already have caught unresolved refs, then emits a warning and creates a stub `ToolNode` at `packages/flow-compiler/src/lower/_shared.ts:295`.

Remediation: Make the behavior mode-explicit: diagnostic lowering may emit stubs, executable lowering should fail closed. Add tests that prove unresolved actions cannot reach executable runtime paths unless a caller explicitly requests best-effort output.

### CODE-009 - Low - A generated timestamped Vitest config artifact is checked into the source tree

Impact: The file is not part of the package source contract and embeds an absolute local path. It adds noise to audits and file discovery, and it can confuse tooling that scans package roots for config files.

Evidence: `packages/flow-ast/vitest.config.ts.timestamp-1776633817137-64c36d7a19afd.mjs:1` is a generated JavaScript copy of the Vitest config. It imports Vitest through an absolute file URL at `packages/flow-ast/vitest.config.ts.timestamp-1776633817137-64c36d7a19afd.mjs:2` and carries an inline sourcemap with absolute workspace paths at `packages/flow-ast/vitest.config.ts.timestamp-1776633817137-64c36d7a19afd.mjs:13`.

Remediation: Remove the artifact and add `*.timestamp-*.mjs` or the exact Vitest temporary pattern to `.gitignore` if this can be regenerated by local tooling.

### CODE-010 - Info - Some package test scripts still allow empty suites even where tests now exist

Impact: This is not a current zero-test failure for the inspected packages, but it weakens future regression detection: a bad test glob, moved test directory, or accidental deletion could still exit successfully.

Evidence: `packages/connectors-documents/package.json:17`, `packages/connectors-browser/package.json:17`, `packages/eval-contracts/package.json:17`, and `packages/agent-types/package.json:20` use `vitest run --passWithNoTests`. Current source does contain tests for `connectors-documents` and `connectors-browser`, so this is a guardrail weakness rather than proof of missing tests.

Remediation: Remove `--passWithNoTests` from packages that intentionally maintain tests. Keep it only for truly type-only packages, and document those package-level exceptions in the runtime test inventory denylist or a test-policy file.

### CODE-011 - Info - Root barrel files remain very broad public surfaces

Impact: Broad root exports increase accidental API commitments and make refactors more expensive. This is lower severity because the repo already has a server API surface report, but the current source still exposes many route, persistence, deploy, security, and compatibility internals through package roots.

Evidence: `packages/server/src/index.ts:16` starts route exports and continues through persistence, middleware, queues, deployment, security, and docs until the version export at `packages/server/src/index.ts:536`. `packages/core/src/index.ts:9` similarly aggregates config, errors, events, plugin, LLM, prompt, security, tools, and telemetry exports through `packages/core/src/index.ts:807`. The server package has only the root and `./ops` subpath in `packages/server/package.json:10`, so most public surface remains root-based.

Remediation: Continue moving operational and unstable surfaces behind explicit subpaths, with deprecation windows for root exports. Keep the existing `server-api-surface-report` check as the compatibility ledger, but pair it with an allowlist that distinguishes stable root API from transitional exports.

## Scope Reviewed

Reviewed current source and configuration for the code quality domain in the `dzupagent` Yarn workspace. The review started from `context/repo-snapshot.md` from the prepared audit pack, then selectively inspected source/config files under `packages/*`, root quality scripts, and package manifests.

The review focused on type-unsafety, duplication, complexity hotspots, zero-test and coverage-gate blind spots, dead/stale code artifacts, and fragile invariants. Generated dependency directories and old audit artifacts were not used as evidence for findings. I did not run build, typecheck, lint, tests, or coverage.

## Strengths

The repository has a strong baseline of quality automation: root `verify` chains runtime test inventory, drift checks, domain-boundary checks, terminal tool event guards, build, typecheck, lint, and tests (`package.json:29`). There are also focused scripts for coverage, server API surface tracking, package tiers, capability matrix freshness, and waiver expiry.

The codebase already contains many targeted tests, especially in `packages/server`, `packages/agent`, `packages/agent-adapters`, `packages/codegen`, and connector packages. Several recent hardening decisions are visible in source, including durable `executionRunId` checks, approval gating, memory/context package boundary comments, and server API surface tooling.

The strongest quality pattern is explicit invariant tooling where it exists: `check-terminal-tool-event-guards`, `check-domain-boundaries`, `check-workspace-coverage`, and the package-scoped scripts give future work concrete gates rather than relying only on review discipline.

## Open Questions Or Assumptions

I treated `packages/server` and `packages/playground` as maintenance surfaces per the repository guidance, so server findings are framed as maintenance/code-quality risks rather than invitations to add new product capability there.

The zero-test inventory is a static heuristic based on same-name or nearby test files. It can miss broad integration tests that cover a source file indirectly, so the finding is about guardrail precision and review visibility, not a claim that those files are entirely untested.

No runtime validation was run for this audit. Findings are based on source inspection, package manifests, and static shell inventory only.

## Recommended Next Actions

1. Replace `AnyDrizzle` in the server persistence stores with typed DB interfaces and add compile-level store contract checks.
2. Extract shared tool execution lifecycle helpers from `tool-loop.ts` and `run-engine.ts`, then add streaming/non-streaming parity tests for timeout, approval, validation, and telemetry cases.
3. Introduce typed timeout errors and remove message-regex timeout classification.
4. Extend quality gates with file-level critical-source test inventory and add coverage scripts or explicit waivers for runtime packages outside the current coverage gate.
5. Remove the timestamped Vitest artifact and tighten ignore rules for generated temporary config files.

## Finding Manifest

```json
{
  "domain": "code quality",
  "counts": { "critical": 0, "high": 1, "medium": 5, "low": 3, "info": 2 },
  "findings": [
    { "id": "CODE-001", "severity": "high", "title": "Drizzle persistence boundaries repeatedly erase schema types with any", "file": "packages/server/src/triggers/trigger-store.ts" },
    { "id": "CODE-002", "severity": "medium", "title": "Streaming and non-streaming tool execution duplicate the same policy stack", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "CODE-003", "severity": "medium", "title": "Timeout detection depends on parsing human-readable error messages", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "CODE-004", "severity": "medium", "title": "Several runtime modules are large enough to hide unrelated responsibilities and invariants", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "CODE-005", "severity": "medium", "title": "Coverage gates do not cover all runtime packages and zero-test detection is package-level only", "file": "scripts/check-runtime-test-inventory.mjs" },
    { "id": "CODE-006", "severity": "medium", "title": "Stored memory-sharing records are trusted after shallow shape checks", "file": "packages/memory/src/sharing/memory-space-manager.ts" },
    { "id": "CODE-007", "severity": "low", "title": "A2A task list says it batch-loads messages but still executes one query per task", "file": "packages/server/src/a2a/drizzle-a2a-task-store.ts" },
    { "id": "CODE-008", "severity": "low", "title": "Flow lowering can continue with stub tool nodes after a missing semantic resolution", "file": "packages/flow-compiler/src/lower/_shared.ts" },
    { "id": "CODE-009", "severity": "low", "title": "A generated timestamped Vitest config artifact is checked into the source tree", "file": "packages/flow-ast/vitest.config.ts.timestamp-1776633817137-64c36d7a19afd.mjs" },
    { "id": "CODE-010", "severity": "info", "title": "Some package test scripts still allow empty suites even where tests now exist", "file": "packages/connectors-documents/package.json" },
    { "id": "CODE-011", "severity": "info", "title": "Root barrel files remain very broad public surfaces", "file": "packages/server/src/index.ts" }
  ]
}
```
