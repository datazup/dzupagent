# @forgeagent/test-utils

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Experimental | **Coverage:** N/A | **Exports:** 7

| Metric | Value |
|--------|-------|
| Source Files | 4 |
| Lines of Code | 466 |
| Test Files | 1 |
| Internal Dependencies | `@forgeagent/core` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @forgeagent/test-utils
```
<!-- AUTO-GENERATED-END -->

Testing utilities for ForgeAgent. Provides mock LLM models, an LLM recorder for deterministic test replay, and factory helpers for creating test agents, stores, and event buses. Zero network dependencies -- all tests run fully offline.

## Installation

```bash
yarn add @forgeagent/test-utils --dev
# or
npm install @forgeagent/test-utils --save-dev
```

## Quick Start

```ts
import {
  MockChatModel,
  LLMRecorder,
  createTestAgent,
  createTestEventBus,
  waitForEvent,
} from '@forgeagent/test-utils'

// Mock model with scripted responses
const model = new MockChatModel([
  { content: 'I will review the code now.' },
  { content: 'Found 2 issues: ...' },
])

// Create a test agent with all dependencies wired
const agent = createTestAgent({ model, tools: [myTool] })
const result = await agent.generate('Review this code')

// Wait for a specific event
const bus = createTestEventBus()
const eventPromise = waitForEvent(bus, 'run:completed')
// ... trigger the event ...
const event = await eventPromise
```

### LLM Recorder

Record real LLM calls and replay them in tests for deterministic, offline testing:

```ts
import { LLMRecorder } from '@forgeagent/test-utils'

// Record mode: calls real LLM and saves fixtures
const recorder = new LLMRecorder({
  mode: 'record',
  fixtureDir: '__fixtures__/llm',
  model: realModel,
})

// Replay mode: returns saved fixtures, no network calls
const replayer = new LLMRecorder({
  mode: 'replay',
  fixtureDir: '__fixtures__/llm',
})
```

## API Reference

### MockChatModel

- `MockChatModel(responses)` -- LangChain-compatible chat model that returns scripted responses in order

**Types:** `MockResponse`

### LLMRecorder

- `LLMRecorder(config)` -- record/replay LLM calls for deterministic testing
  - `mode: 'record'` -- call the real model and save responses as fixtures
  - `mode: 'replay'` -- return saved fixtures without network calls
  - `mode: 'auto'` -- replay if fixture exists, otherwise record

**Types:** `RecorderConfig`, `RecorderMode`, `Fixture`

### Test Helpers

- `createTestEventBus()` -- in-memory event bus for testing
- `createTestRunStore()` -- in-memory run store
- `createTestAgentStore()` -- in-memory agent store
- `createTestAgent(config)` -- create a ForgeAgent with all test dependencies
- `createTestConfig(overrides)` -- create a ForgeAgentConfig with sensible defaults
- `waitForEvent(bus, type)` -- wait for a specific event with timeout

### Version

- `FORGEAGENT_TEST_UTILS_VERSION: string` -- `'0.1.0'`

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@forgeagent/core` | `0.1.0` | Core infrastructure |

## Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@langchain/core` | `>=1.0.0` | LangChain message/model types |
| `vitest` | `>=1.0.0` | Test framework |

## License

MIT
