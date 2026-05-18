# @dzupagent/test-utils Architecture

## Scope
`@dzupagent/test-utils` is a package of deterministic testing helpers for DzupAgent ecosystem code. Its publish surface is defined by `src/index.ts` and currently covers:
- LangChain-compatible model doubles and recorder wrappers (`MockChatModel`, `LLMRecorder`).
- In-memory test setup helpers for Dzup core primitives (`createTestEventBus`, store/config helpers, polling helpers).
- An in-process Express route harness (`createExpressRouteHarness`) for route tests without binding a real socket.
- A reusable Vitest suite factory for MCP publisher compatibility checks (`describeMcpPublisherCompatibilitySuite`).

Out of scope:
- production runtime orchestration,
- persistence beyond in-memory stores,
- transport hosting,
- non-Vitest testing framework adapters.

## Responsibilities
- Provide stable offline model behavior for tests via scripted responses.
- Provide record/replay/passthrough wrappers for chat model interactions backed by JSON fixtures.
- Reduce test setup boilerplate for event bus and core in-memory stores.
- Provide deterministic request/response capture for Express route-level tests.
- Standardize MCP publisher behavior assertions across packages through one compatibility suite helper.

## Structure
Source layout under `src/`:
- `index.ts`: export barrel and package version constant.
- `mock-model.ts`: `MockChatModel` and `MockResponse`.
- `llm-recorder.ts`: `LLMRecorder`, recorder config/types, internal replay/record wrappers.
- `test-helpers.ts`: event/store/config factories plus `waitForEvent` and `waitForCondition`.
- `express-route-harness.ts`: synthetic request/response dispatch against `app.handle(...)`.
- `mcp-compatibility.ts`: compatibility suite generator built on Vitest APIs.
- `__tests__/`: focused tests for mock model behavior, route harness, MCP suite helper, and condition polling.

Package/build metadata:
- `package.json`: scripts, dependency contracts, export map.
- `tsup.config.ts`: ESM bundle from `src/index.ts` with type declarations.
- `vitest.config.ts`: Node test environment and coverage thresholds.

## Runtime and Control Flow
`MockChatModel` flow:
1. Constructor normalizes string/object responses and falls back to one empty response if input is empty.
2. `_generate(...)` appends call metadata (`messages`, timestamp) to an internal log.
3. Response selection is cyclic (`callIndex % responses.length`).
4. Returns LangChain generation output with `AIMessage` and optional `tool_calls`.
5. `callCount`, `callLog`, and `reset()` support deterministic assertions.

`LLMRecorder` flow:
1. `LLMRecorder` is initialized with `fixtureDir`, `mode`, and optional hash override.
2. `wrap(model)` behavior by mode:
- `passthrough`: returns the original model unchanged.
- `replay`: returns `ReplayModel`, which hashes input and loads fixture JSON.
- `record`: returns `RecordingModel`, which invokes the real model then writes fixture JSON.
3. Default fixture key is SHA-256 of serialized message content (first 16 hex chars).
4. Replay emits synthetic `AIMessage` from fixture output content.
5. Record serializes message input/output and writes fixture metadata (`recordedAt`).

Express route harness flow:
1. `createExpressRouteHarness(createApp, options)` creates a dispatcher.
2. `dispatch(...)` builds a synthetic readable `Request` (method/url/body/headers/params/query).
3. A synthetic `Response` object inherits from `app.response` and captures status/headers/chunks/payload.
4. Harness calls `app.handle(req, res, next)` directly.
5. Promise resolves on `finish`, rejects on explicit response error or timeout.

MCP compatibility suite flow:
1. Consumer calls `describeMcpPublisherCompatibilitySuite(options)` inside a Vitest test file.
2. Helper registers default cases for tool listing, initialize, null-id handling, notification semantics, and invalid-request handling.
3. Optional cases are added for tool calls, resources listing, and resource template listing when expectations are provided.
4. `prepareCase` hook allows case-specific harness setup before each assertion.

## Key APIs and Types
Primary exports:
- `MockChatModel`
- `LLMRecorder`
- `createTestEventBus`
- `createTestRunStore`
- `createTestAgentStore`
- `createTestAgent`
- `createTestConfig`
- `waitForEvent`
- `waitForCondition`
- `createExpressRouteHarness`
- `describeMcpPublisherCompatibilitySuite`
- `dzupagent_TEST_UTILS_VERSION`

Exported types:
- `MockResponse`
- `RecorderConfig`, `RecorderMode`, `Fixture`
- `ExpressRouteDispatchInput`, `ExpressRouteHarness`, `ExpressRouteHarnessResponse`, `ExpressRouteHarnessState`
- `McpCompatibilityCaseName`, `McpCompatibilityHarness`, `McpCompatibilityResponse`, `McpCompatibilityToolCallCase`, `McpPublisherCompatibilitySuiteOptions`

Important behavior notes from current code:
- `createTestAgent(...)` returns an `AgentExecutionSpec` object, not a runnable agent instance.
- `RecorderMode` values are exactly `'record' | 'replay' | 'passthrough'`.
- `mcp-compatibility.ts` imports `describe/it/expect` directly from Vitest, so this helper is coupled to Vitest.

## Dependencies
Runtime dependency:
- `@dzupagent/core` (`0.2.0`): event bus factory, model registry, in-memory run/agent stores, and MCP type contracts.

Peer dependencies:
- `@langchain/core >=1.0.0`: `BaseChatModel`, message types.
- `express >=4.22.1 <5`: route harness request/response contract.
- `vitest >=1.0.0`: required for MCP compatibility helper runtime imports.

Node built-ins used:
- `node:crypto`, `node:fs`, `node:path`, `node:events`, `node:stream`.

Build/runtime characteristics:
- ESM-only package (`"type": "module"`).
- Node target `node20` via `tsup`.
- Public exports constrained to `dist/index.js` and `dist/index.d.ts`.

## Integration Points
- LangChain model tests: `MockChatModel` and recorder wrappers provide `BaseChatModel`-compatible `_generate(...)` behavior.
- Dzup core tests: helper factories produce `InMemoryRunStore`, `InMemoryAgentStore`, `DzupEventBus`, and `ModelRegistry` wiring for isolated tests.
- Express route tests: harness can validate middleware/handlers in-process through direct `app.handle(...)` dispatch.
- MCP endpoint tests: compatibility suite can be bound to any custom GET/POST harness implementation and reused across MCP publishers.

## Testing and Observability
Current tests in `src/__tests__/`:
- `mock-model.test.ts`: sequencing, cycling, call-state tracking, reset behavior, tool call payload path, empty response fallback, `_llmType`.
- `express-route-harness.test.ts`: successful route dispatch and timeout rejection path.
- `mcp-compatibility.test.ts`: validates all default cases plus optional tool-call/resources/resource-templates branches.
- `wait-for-condition.test.ts`: immediate success, async polling success, and timeout error message path.

Coverage configuration in `vitest.config.ts`:
- Include: `src/**/*.ts`
- Exclude: tests/specs, `__tests__`, fixtures, `index.ts`
- Thresholds: statements 40, branches 30, functions 30, lines 40

Observability model:
- No telemetry pipeline is built into this package.
- Local observability is test-facing via in-memory event capture (`createTestEventBus`) and response capture state in `ExpressRouteHarnessResponse.state`.

## Risks and TODOs
- `README.md` currently describes APIs/modes that differ from implementation in `src/` (for example mode naming and helper semantics); README should be reconciled with code to avoid consumer confusion.
- `LLMRecorder.listFixtures()` uses `require('node:fs')` inside an ESM package, which is potentially fragile depending on runtime/tooling behavior.
- Fixture hashing defaults to message content only; collisions are possible across scenarios with identical prompts unless custom hashing or isolated fixture directories are used.
- MCP compatibility helper is intentionally tied to Vitest imports, limiting direct reuse in other test runners.
- `dzupagent_TEST_UTILS_VERSION` is hard-coded and must be kept in sync manually with `package.json` version.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

