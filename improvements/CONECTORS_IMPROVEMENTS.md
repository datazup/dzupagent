# Connectors/Core Gap Analysis and Improvement Plan

## Scope

Analyzed packages:

- `packages/codegen`
- `packages/connectors`
- `packages/connectors-browser`
- `packages/connectors-documents`
- `packages/domain-nl2sql`
- `packages/scraper`
- `packages/core` (focused on integration points used by the above)

## Executive Summary

The codebase has strong breadth and generally clean modularization, but there are concrete implementation gaps and interface inconsistencies that will slow adoption and increase maintenance cost:

1. Some features are currently stubs/placeholders, not full implementations.
2. Connector/tool interfaces are inconsistent across packages (`DynamicStructuredTool` vs `createForgeTool`-style wrappers vs custom tool object).
3. `domain-nl2sql` duplicates core/connectors contract types locally to avoid build-order issues, which risks drift.
4. Packaging/testing maturity is uneven (`connectors-browser`, `connectors-documents`, `scraper`, `domain-nl2sql`).
5. Several options are exposed in APIs but not actually honored in execution paths.

---

## Severity-Ranked Findings

## High

1. **`codegen` validate tool is a placeholder, not real validation**
- Evidence: `packages/codegen/src/tools/validate.tool.ts:11-19`
- Current behavior: returns a fixed JSON message saying validation should be done elsewhere.
- Gap: tool contract implies functional validation but does not perform it.
- Risk: false confidence in pipeline validation coverage.

2. **`domain-nl2sql` schema retrieval has incomplete vector-example retrieval**
- Evidence: `packages/domain-nl2sql/src/tools/tool-schema-retrieval.ts:247-270`
- Current behavior: TODO comment + empty `examples = []` placeholder when collection exists.
- Gap: feature advertised in docs/architecture is not functionally wired for query embedding lookup.
- Risk: reduced SQL quality (loss of few-shot/example grounding) and misleading expectations.

3. **`scraper` extraction options are partially ignored**
- Evidence:
  - `packages/scraper/src/scraper.ts:159-165` (`_options` unused in HTTP path)
  - `packages/scraper/src/scraper.ts:168-171` (browser path does not accept extraction options)
  - `packages/scraper/src/http-fetcher.ts:54` and `packages/scraper/src/browser-pool.ts:163` (hardcoded `{ mode: 'all', cleanHtml: true }`)
- Gap: caller-provided extraction mode/cleaning/maxLength does not propagate end-to-end.
- Risk: API promises are not met; consumers cannot control output size/format as documented.

4. **`connectors-browser` screenshot tool accepts `fullPage` input but does not use it**
- Evidence:
  - input defines `fullPage`: `packages/connectors-browser/src/browser-connector.ts:176-181`
  - capture call ignores it: `packages/connectors-browser/src/browser-connector.ts:199`
  - capture implementation has no input parameter: `packages/connectors-browser/src/extraction/screenshot-capture.ts:10-30`
- Gap: exposed option is non-functional.
- Risk: unexpected behavior and potential context/token blow-ups when users expect viewport-only captures.

## Medium

5. **Packaging inconsistency for browser/doc connectors (`main`/`types` point to `src`)**
- Evidence:
  - `packages/connectors-browser/package.json:5-6`
  - `packages/connectors-documents/package.json:5-6`
- Gap: unlike other packages using `dist`, these expose TS source directly.
- Risk: consumer build friction, ESM resolution inconsistency, accidental runtime/toolchain incompatibility.

6. **Connector abstraction is fragmented**
- Evidence:
  - canonical connectors use `DynamicStructuredTool`: `packages/connectors/src/connector-types.ts:19`
  - browser/docs use `createForgeTool`: `packages/connectors-browser/src/browser-connector.ts:6`, `packages/connectors-documents/src/document-connector.ts:6`
  - scraper returns custom `{ name, schema, invoke }` object: `packages/scraper/src/scraper.ts:99-147`
- Gap: no unified connector/tool adapter contract.
- Risk: duplicated adapters, uneven DX, harder composition and policy enforcement.

7. **`domain-nl2sql` duplicates shared interfaces locally**
- Evidence:
  - local mirror contracts in `packages/domain-nl2sql/src/types/index.ts:10-67`
  - inline mirrored schema interfaces in `packages/domain-nl2sql/src/tools/tool-schema-retrieval.ts:14-53`
- Gap: avoiding build-order by duplication.
- Risk: drift from `@dzipagent/core` and `@dzipagent/connectors` contracts, latent runtime/type mismatches.

8. **`scraper` exposes `respectRobotsTxt` config but has no enforcement**
- Evidence:
  - config field exists: `packages/scraper/src/types.ts:40`
  - default set: `packages/scraper/src/http-fetcher.ts:15`
  - no call site logic for robots parsing/enforcement in fetch path.
- Gap: policy flag is effectively inert.
- Risk: legal/compliance surprises for production crawling.

9. **`domain-nl2sql` package has test script but no tests**
- Evidence: source tree contains no test files under `packages/domain-nl2sql/src` (static scan).
- Gap: critical query-generation/safety code is untested at package level.
- Risk: regressions in SQL safety and correctness.

10. **`scraper` package has test script but no tests**
- Evidence: source tree contains no test files under `packages/scraper/src` (static scan).
- Gap: crawler/fetching/extraction behavior lacks safety net.
- Risk: silent regressions, especially around fallback behavior and extraction quality.

## Low

11. **`domain-nl2sql` toolkit header comment drift**
- Evidence: comment says Full has 15 tools: `packages/domain-nl2sql/src/tools/index.ts:7`; actual factory returns 14: `:80-87`.
- Gap: docs/comment mismatch.
- Risk: confusion for integrators and maintainers.

12. **Legacy `Connector`/`ConnectorConfig` abstraction in `connectors` is underutilized**
- Evidence: `packages/connectors/src/connector-types.ts:7-20`.
- Gap: package exports generic interface, but implementations are per-factory and not aligned with browser/docs/scraper.
- Risk: dead abstraction and unclear extension path.

---

## Cross-Package Refactoring Plan (Reusability + Better Abstractions)

## 1) Introduce a single connector runtime contract

Create a shared interface in `core` (or dedicated `@dzipagent/connector-runtime`) and migrate all connector packages:

- `ConnectorTool` (uniform invoke signature + metadata + zod/json-schema)
- `ToolExecutionContext` (trace id, tenant scope, cancellation, budget)
- `ToolExecutionResult<T>` (typed payload, structured errors, warnings, truncation metadata)
- `ConnectorLifecycle` (`init`, `health`, `dispose`)

Outcome:
- `connectors`, `connectors-browser`, `connectors-documents`, `scraper` all emit compatible tool objects.
- no adapter shims per package.

## 2) Remove duplicated domain contracts by adding stable shared ports

Define stable ports in `core`:

- `SqlConnectorPort`
- `VectorStorePort`
- `EmbeddingProviderPort`

Then in `domain-nl2sql`, import these ports directly and drop local mirrored types.

Outcome:
- no type drift
- clearer ownership of shared contracts
- easier semver governance

## 3) Extract shared web acquisition/extraction primitives

Current overlap:
- `connectors-browser` crawler and screenshot extraction
- `scraper` browser/http fetching and extraction

Refactor into reusable modules:

- `web-fetch-runtime` (http + browser + retry policy + UA strategy)
- `dom-content-extractor` (structured extraction, metadata, markdown/text/html modes)
- `crawl-policy` (depth limits, include/exclude patterns, robots policy)

Outcome:
- less duplicated behavior
- consistent semantics for extraction modes and safety flags

## 4) Standardize error model on `ForgeError`

Many packages return plain strings for errors. Move to structured failures:

- `code`: stable error code
- `recoverable`: bool
- `suggestion`: optional action
- `context`: constrained payload

Outcome:
- better orchestration decisions
- better telemetry and policy handling

## 5) Add capability-level testing baseline for each package

Minimum test bars:

- `domain-nl2sql`: safety validator, structure validator, RLS injection, schema retrieval fallbacks, tool wiring.
- `scraper`: extraction-mode propagation, fallback rules, robots flag behavior, timeout/retry behavior.
- `connectors-browser`: crawl queue behavior, auth flow branching, screenshot option propagation.
- `connectors-documents`: parser fail paths, chunk strategy edge cases.
- `connectors/sql`: per-dialect smoke validation and DDL/schema discovery normalization checks.

---

## Proposed New Core Features

## A. `Connector Orchestrator` in `@dzipagent/core`

Purpose: provide shared runtime for connector invocation with policy and telemetry.

Key capabilities:
- policy hooks (allow/deny/approve/log) using `risk-classifier`
- rate limits and retries
- per-tool timeout + cancellation
- cost/latency instrumentation
- structured result envelopes

## B. `Policy-Aware Network Client`

Purpose: unify outbound HTTP behavior used by `connectors`, `scraper`, browser helpers.

Features:
- allowlist/blocklist by host/path
- SSRF guards
- retry + circuit breaker profile
- response size limits
- redact-before-log middleware

## C. `Schema Intelligence Service` for SQL domains

Purpose: shared service for schema retrieval + embeddings + cache + invalidation.

Features:
- embedding provider integration (fixes NL2SQL TODO path)
- caching keyed by tenant/data-source/hash
- schema drift detection events
- table/column relevance scoring plug-ins

## D. `Unified Tool Telemetry`

Purpose: one event schema for all tool calls.

Features:
- begin/success/failure events
- standard dimensions (tool id, connector id, tenant, latency, retries, truncation)
- export adapters (logs, OpenTelemetry, metrics)

---

## Phased Implementation Roadmap

## Phase 0 (Immediate Bug/Gap Fixes)

1. Implement real logic in `createValidateTool` or remove/deprecate it.
2. Wire NL2SQL example retrieval with an embedding provider interface.
3. Propagate `extractMode` and extraction options through `scraper` paths.
4. Honor `fullPage` in browser screenshot tool.
5. Align `connectors-browser` and `connectors-documents` package entry points to `dist`.

## Phase 1 (Interface Unification)

1. Introduce shared connector runtime contract in `core`.
2. Add compatibility adapters for old tool signatures.
3. Migrate one package at a time (`connectors` -> `connectors-documents` -> `connectors-browser` -> `scraper`).

## Phase 2 (Port/Contract Cleanup)

1. Add shared ports in `core`.
2. Remove duplicated contracts from `domain-nl2sql`.
3. Introduce compile-time conformance tests to detect drift.

## Phase 3 (Policy + Telemetry)

1. Add connector orchestrator runtime with policy hooks.
2. Standardize events and error envelopes.
3. Integrate with existing event bus and tool stats tracker.

---

## Concrete Refactoring Targets

## `packages/codegen`

- Replace placeholder `createValidateTool` with scorer-backed implementation.
- Return typed quality summary + violations, not advisory placeholder text.

## `packages/connectors`

- Evolve `Connector` interface to support async lifecycle and structured outputs.
- Add test suite for SQL adapters/dialects (currently missing coverage).

## `packages/connectors-browser`

- Add real support for screenshot mode controls (`fullPage`, quality, clip).
- Add test coverage beyond screenshot capture (crawler/auth/extraction semantics).
- Move package outputs to `dist` and add `exports` map consistency with other packages.

## `packages/connectors-documents`

- Move package outputs to `dist` and add `exports` map consistency.
- Add parsing/chunking guardrails (size limits, chunk count limits, error taxonomies).

## `packages/domain-nl2sql`

- Complete vector example retrieval path.
- Replace local contract mirrors with shared ports.
- Add tests for safety/structure validators and execution behavior.
- Optional: provide executable workflow builder wrappers instead of only static workflow descriptors.

## `packages/scraper`

- Respect extraction options end-to-end.
- Implement robots policy handling or remove flag until implemented.
- Unify tool output contract with connector runtime.
- Add package tests (fallback, retry, extraction modes, browser-pool lifecycle).

## `packages/core` (integration support)

- Provide connector runtime primitives and shared ports.
- Provide policy-aware network client and standardized tool telemetry contract.
- Add facade exports for connector/runtime contracts to reduce package-level custom contracts.

---

## Suggested Initial PR Breakdown

1. **PR-1 (Bugfixes)**
- `codegen` validate tool real implementation
- `connectors-browser` `fullPage` option wiring
- `scraper` extraction mode propagation

2. **PR-2 (Packaging consistency)**
- `connectors-browser` and `connectors-documents` entrypoint normalization to `dist`
- add tests/lint scripts parity with monorepo standards

3. **PR-3 (Core contract foundation)**
- add shared connector/tool runtime contracts in `core`
- add compatibility adapter package

4. **PR-4 (Domain contract cleanup)**
- migrate `domain-nl2sql` to shared ports
- implement NL2SQL embedding-based example retrieval

