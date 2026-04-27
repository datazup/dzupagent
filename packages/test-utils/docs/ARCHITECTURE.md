# @dzupagent/test-utils Architecture

## Scope
`@dzupagent/test-utils` is a Node.js/TypeScript package that provides deterministic testing helpers for DzupAgent-adjacent code. The package surface is defined by [`src/index.ts`](../src/index.ts) and currently includes:
- model doubles (`MockChatModel`),
- fixture-backed model recording/replay (`LLMRecorder`),
- generic test helper factories (`createTestEventBus`, stores/config helpers, wait helpers),
- a lightweight Express route dispatch harness (`createExpressRouteHarness`),
- reusable MCP publisher compatibility suite scaffolding (`describeMcpPublisherCompatibilitySuite`).

Out of scope:
- production runtime wiring,
- HTTP server hosting,
- networked observability/export pipelines,
- persisted datastore integrations beyond in-memory test stores.

## Responsibilities
- Provide a deterministic LangChain-compatible chat model double for unit/integration tests.
- Provide fixture-driven record/replay wrappers around chat models for repeatable offline test behavior.
- Reduce boilerplate for common DzupAgent test setup (event bus, stores, minimal agent definitions, polling/wait utilities).
- Provide a route-level harness for exercising Express handlers without booting an actual HTTP server.
- Provide a shared MCP compatibility assertion suite that consumers can bind to any GET/POST test harness implementation.

## Structure
Top-level source layout under `src/`:
- [`index.ts`](../src/index.ts): package export barrel and version constant.
- [`mock-model.ts`](../src/mock-model.ts): `MockChatModel` and `MockResponse` type.
- [`llm-recorder.ts`](../src/llm-recorder.ts): `LLMRecorder`, fixture types, and internal replay/record model wrappers.
- [`test-helpers.ts`](../src/test-helpers.ts): event/store/config factories, `waitForEvent`, `waitForCondition`.
- [`express-route-harness.ts`](../src/express-route-harness.ts): in-process Express request/response harness.
- [`mcp-compatibility.ts`](../src/mcp-compatibility.ts): reusable Vitest compatibility suite for MCP-style publishers.
- `src/__tests__/`: focused tests for mock model behavior, route harness, MCP compatibility helper, and wait helper.

Build/test metadata:
- [`package.json`](../package.json): publish surface, scripts, dependencies.
- [`tsup.config.ts`](../tsup.config.ts): ESM bundle + declarations from `src/index.ts`.
- [`vitest.config.ts`](../vitest.config.ts): Node environment, include patterns, coverage thresholds.

## Runtime and Control Flow
### Mock model flow
1. Test instantiates `MockChatModel` with string or object responses.
2. Each `_generate(...)` call logs input messages and timestamp.
3. Response selection is round-robin (`callIndex % responses.length`).
4. Returned value is an `AIMessage` generation payload compatible with `BaseChatModel` expectations.
5. `callCount`, `callLog`, and `reset()` expose deterministic inspection hooks.

### Recorder flow
1. `LLMRecorder` is constructed with `fixtureDir` and mode (`record`, `replay`, `passthrough`).
2. `wrap(model)` returns:
- original model in `passthrough`,
- `ReplayModel` in `replay`,
- `RecordingModel` in `record`.
3. Fixture key is derived from message content via SHA-256 (first 16 hex chars) unless custom `hashInput` is provided.
4. Replay mode loads fixture JSON and emits synthetic `AIMessage` output.
5. Record mode calls the real model, normalizes content to string, persists fixture JSON, and returns equivalent generation output.

### Express harness flow
1. Consumer passes `createApp()` factory into `createExpressRouteHarness(...)`.
2. `dispatch(...)` builds a synthetic `Request` stream and a custom `Response` implementation linked to the app prototype.
3. App `handle(...)` is invoked directly.
4. Harness resolves on `finish`, rejects on response error or timeout.
5. Captured status, headers, payload, chunks, and completion state are exposed via `ExpressRouteHarnessResponse.state`.

### MCP compatibility suite flow
1. Consumer calls `describeMcpPublisherCompatibilitySuite(...)` inside test files.
2. Utility registers Vitest `it(...)` cases for core MCP behavior (metadata tools route, initialize, null-id, notification, malformed request).
3. Optional cases are included when tool-call/resources/resource-template expectations are supplied.
4. Assertions are applied to harness responses, while `prepareCase` allows per-test fixture setup.

## Key APIs and Types
Exported primary APIs (from [`index.ts`](../src/index.ts)):
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

Exported key types:
- `MockResponse`
- `RecorderConfig`, `RecorderMode`, `Fixture`
- `ExpressRouteDispatchInput`, `ExpressRouteHarness`, `ExpressRouteHarnessResponse`, `ExpressRouteHarnessState`
- `McpCompatibilityCaseName`, `McpCompatibilityHarness`, `McpCompatibilityResponse`, `McpCompatibilityToolCallCase`, `McpPublisherCompatibilitySuiteOptions`

Version marker:
- `dzupagent_TEST_UTILS_VERSION` is exported as a string constant.

## Dependencies
Runtime dependency:
- `@dzupagent/core`: in-memory stores, event bus utilities, model registry, MCP descriptor/resource template types.

Peer dependencies:
- `@langchain/core`: base chat model/message contracts used by mock/recorder implementations.
- `express`: type and runtime contract expected by the route harness.
- `vitest`: required because `mcp-compatibility.ts` imports `describe`, `it`, and `expect` directly.

Node built-ins:
- `crypto`, `fs`, `path`, `events`, `stream`.

Build/runtime characteristics:
- ESM-only package (`"type": "module"`).
- Node 20 target via `tsup`.
- Declarations emitted with strict TypeScript compiler flags.

## Integration Points
Primary consumers are test suites in DzupAgent packages/apps that need deterministic model behavior or protocol assertions.

Notable integration seams:
- LangChain chat model contract: `MockChatModel` and recorder wrappers implement `BaseChatModel` behavior through `_generate`.
- Dzup core contract: helper factories return `InMemoryRunStore`, `InMemoryAgentStore`, `DzupEventBus`, `ModelRegistry` and typed event waiters.
- Express app contract: harness dispatches directly against `app.handle(...)` with synthetic request/response objects.
- MCP publisher contract: compatibility suite validates expected JSON-RPC and metadata behavior through a consumer-provided transport harness.

## Testing and Observability
Current automated tests under `src/__tests__/` cover:
- `mock-model.test.ts`: response ordering, cycling, call logging/counting, reset behavior, tool call payload support.
- `express-route-harness.test.ts`: successful route dispatch and timeout failure behavior.
- `mcp-compatibility.test.ts`: validates all default and optional compatibility suite branches against a fake dispatcher.
- `wait-for-condition.test.ts`: immediate success, async polling, timeout error path.

Coverage configuration (Vitest v8 provider):
- Include: `src/**/*.ts`
- Exclude tests/fixtures/index barrel
- Thresholds: statements 40%, branches 30%, functions 30%, lines 40%

Observability notes:
- Package does not emit telemetry; observability is intentionally local and test-driven (call logs, captured events, captured response state).

## Risks and TODOs
- Version drift risk: [`package.json`](../package.json) is `0.2.0`, while `dzupagent_TEST_UTILS_VERSION` in [`src/index.ts`](../src/index.ts) is currently `0.1.0`.
- ESM/CJS compatibility risk: [`llm-recorder.ts`](../src/llm-recorder.ts) uses `require('node:fs')` in `listFixtures()`, which may be fragile in strict ESM execution contexts.
- Fixture collision risk: default hash uses message content only; tests with identical prompts across scenarios share fixture names unless `hashInput` or scenario-specific paths are used.
- MCP helper coupling: `mcp-compatibility.ts` imports Vitest globals directly, so the module is test-runner-coupled and not reusable outside Vitest without adaptation.
- Documentation drift in README: README claims and metrics (e.g., export count and mode names) can diverge from implementation; architecture docs should continue to be refreshed from `src/` first.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

