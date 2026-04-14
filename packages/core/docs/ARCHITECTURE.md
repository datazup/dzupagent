# @dzupagent/core Architecture

## Purpose
`@dzupagent/core` is the foundation layer for the DzupAgent stack. It centralizes shared runtime concerns so higher-level packages (`agent`, `server`, `codegen`, `otel`, etc.) do not re-implement model invocation, eventing, identity, routing, security, plugins, or vector search plumbing.

## Main Responsibilities
- Provide core abstractions for model registration/invocation and retry/circuit-breaker behavior.
- Provide reusable event bus and protocol primitives for agent and tool lifecycle events.
- Provide shared security policy, classification, auditing, and output filtering building blocks.
- Provide registry/routing layers that decide which agent/capability handles an input.
- Provide plugin + hook lifecycle for extensibility.
- Re-export memory and context capabilities used across packages.

## Module Structure
Top-level modules under `src/`:
- `llm/`: model registry, invocation helpers, retry logic, and circuit breaker.
- `events/`: event bus and typed event payload contracts.
- `prompt/`: prompt fragments, template rendering, template cache/resolver.
- `pipeline/`: pipeline definition/schema/layout/checkpoint serialization.
- `protocol/`: adapter/bridge/router/serialization for cross-runtime message transport.
- `security/`: PII detector, secrets scanner, policy evaluator, monitor, audit support.
- `identity/`: Forge URI identity model, delegation, signing, trust scoring, key management.
- `registry/`: capability matching and semantic/vector capability discovery.
- `router/`: intent router with keyword fast path and LLM fallback classifier.
- `mcp/`: MCP client/server bridge and sampling/resource loading support.
- `vectordb/`: vector adapters (Pinecone/Qdrant/pgvector/Chroma), embeddings, semantic store.
- `plugin/` + `hooks/`: plugin registration/discovery and lifecycle hook execution.
- `middleware/`, `observability/`, `streaming/`, `subagent/`, `concurrency/`, `persistence/`, `formats/`, `skills/`, `config/`.

## How It Works (Runtime Flow)
1. Caller resolves configuration and obtains a container/event bus.
2. `ModelRegistry` resolves the selected tier/provider model.
3. Invocation path runs through retry + timeout + circuit-breaker guard.
4. Events are emitted on the shared event bus for tool/agent lifecycle and downstream integrations.
5. Optional security/policy/output modules process request and response artifacts.
6. Optional routing/registry layers determine agent dispatch or capability match.
7. Optional persistence/checkpoint/session helpers store execution state.

## Public API Surface
The package exports a broad API via `src/index.ts` including:
- Infrastructure primitives (`ForgeContainer`, `ForgeError`, `createEventBus`).
- LLM pipeline (`ModelRegistry`, `invokeWithTimeout`, `CircuitBreaker`).
- Prompt/template system (`PromptResolver`, fragment composer, template engine).
- Protocol/router/registry APIs.
- Plugin/hook APIs.
- Security and vector retrieval APIs.
- Version constant: `dzupagent_CORE_VERSION`.

## Main Features
- High-coverage shared base (200+ source files, 40+ tests) for multi-package reuse.
- Strong typed contracts at boundaries (events, protocol messages, policies, manifests).
- Multiple fallback strategies (keyword -> LLM classifier, noop-friendly components, retry/circuit breaking).
- Built-in compatibility with multi-agent patterns and sub-agent merge/reducer workflows.
- Vector-native capability discovery and semantic retrieval support.

## Integration Boundaries
- Upstream: consumed by almost every DzupAgent package.
- Downstream dependencies: `@dzupagent/memory` and `@dzupagent/context` are integrated/re-exported.
- External peers: LangChain/LangGraph/Zod ecosystem and optional memory-ipc integration.

## Extensibility Points
- Register new models/providers through `ModelRegistry`.
- Add plugins via `PluginRegistry` and hook into lifecycle events.
- Implement new vector adapters/embedding providers.
- Extend security monitor/policy evaluator rules.
- Introduce new protocol adapters and route strategies.

## Quality and Test Posture
- Broad unit-test coverage across core modules (`src/__tests__`, plus module-scoped test folders).
- Architecture emphasizes composable services with isolated utility modules, reducing coupling between subsystems.
