# @forgeagent/test-utils Architecture

## Purpose
`@forgeagent/test-utils` provides deterministic testing utilities for ForgeAgent packages and applications. It focuses on offline-first model simulation and predictable event/store setup.

## Main Responsibilities
- Provide a mock chat model for scripted, deterministic responses.
- Provide record/replay fixture tooling for LLM call behavior.
- Provide helpers for creating test event bus/store/agent configuration.
- Reduce boilerplate in package-level unit tests.

## Module Structure
Top-level modules under `src/`:
- `mock-model.ts`: `MockChatModel` implementation.
- `llm-recorder.ts`: fixture-based record/replay wrapper.
- `test-helpers.ts`: helpers for run store, agent store, event bus, config, and event waiting.
- `index.ts`: export surface and version constant.

## How It Works
1. Test creates a mocked model or recorder-wrapped model.
2. Test helper functions bootstrap in-memory stores and event bus.
3. Assertions run against deterministic outputs/events.
4. Optional recorder mode captures real model outputs for future replay.

## Main Features
- Zero-network deterministic testing mode.
- Replayable fixture model behavior for stable CI.
- Shared test factory methods to keep suites concise.
- Compatible with core event/run store abstractions.

## Integration Boundaries
- Depends on `@forgeagent/core` utilities and peer LangChain/Vitest types.
- Used broadly by other ForgeAgent packages in unit/integration tests.

## Extensibility Points
- Add additional factory helpers for new runtime abstractions.
- Add fixture serializers for new model output variants.

## Quality and Test Posture
- Small focused package with direct tests of mock model behavior and helper correctness.
