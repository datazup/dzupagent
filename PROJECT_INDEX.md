# DzupAgent Framework — Project Index

Generated: 2026-06-27

> Orientation aid only. Counts are approximate snapshots; verify live files with
> `rg`/`ls` before relying on any path. Authority for current state is the git
> log + `docs/`. DzupAgent is a reusable framework for multi-provider LLM agents
> with orchestration, memory, context, extensibility, and deployment runtime.

---

## Overview

**DzupAgent** is an open-source, MIT-licensed TypeScript framework for building
multi-provider LLM agent systems with sophisticated orchestration, memory,
context management, and runtime extensibility. It provides agent lifecycle
control, tool invocation, token budgeting, flow authoring, streaming, MCP
integration, and safe concurrent execution. The framework is designed for both
in-process (library) and deployed (server) runtimes, with adapters for Claude,
Codex, Gemini, Qwen, and other LLM providers.

**Key Roles:**

- Framework for codev-app agent orchestration (workers, rooms, flows, adapters)
- Shared runtime for Datazup apps requiring agent capabilities
- Basis for agent integration patterns across the ecosystem

---

## Workspaces (Yarn 4 Monorepo, 35 packages)

The monorepo is organized into 6 categories:

### Runtime Foundations (5 packages)

Core layer — required by all other packages.

| Package                 | Purpose                                                 | Version | LOC    | Files |
| ----------------------- | ------------------------------------------------------- | ------- | ------ | ----- |
| **@dzupagent/core**     | Event bus, models, utilities, plugins, MCP client       | ^3.0.0  | ~8500  | 112   |
| **@dzupagent/agent**    | Agent lifecycle, tool execution, streaming, context     | ^3.0.0  | ~10200 | 118   |
| **@dzupagent/memory**   | Memory scope builder, consolidation, sanitization       | ^3.0.0  | ~6500  | 92    |
| **@dzupagent/context**  | Context frame builder, merging, safe access             | ^3.0.0  | ~5200  | 71    |
| **@dzupagent/security** | Input sanitization, output validation, secrets handling | ^3.0.0  | ~3200  | 45    |

### Adapters & Orchestration (2 packages)

Integrations with external LLM providers and multi-agent patterns.

| Package                       | Purpose                                                   | Version | LOC   | Files |
| ----------------------------- | --------------------------------------------------------- | ------- | ----- | ----- |
| **@dzupagent/agent-adapters** | Claude, Codex, Gemini, Qwen adapters with fallback chains | ^3.0.0  | ~9800 | 142   |
| **@dzupagent/hitl-kit**       | Human-in-the-loop gates, approval workflows, escalation   | ^3.0.0  | ~4100 | 56    |

### Integrations (3 packages)

Higher-level integrations with common platforms and SDKs.

| Package                   | Purpose                                              | Version | LOC   | Files |
| ------------------------- | ---------------------------------------------------- | ------- | ----- | ----- |
| **@dzupagent/connectors** | Slack, GitHub, HTTP, database connectors             | ^3.0.0  | ~7200 | 94    |
| **@dzupagent/express**    | Express.js server integration, middleware, routes    | ^3.0.0  | ~5900 | 71    |
| **@dzupagent/app-tools**  | App-level tool registry, discoverability, validation | ^3.0.0  | ~3100 | 41    |

### Flow & Dialogue (3 packages)

Flow DSL, compiler, and execution runtime.

| Package                      | Purpose                                            | Version | LOC   | Files |
| ---------------------------- | -------------------------------------------------- | ------- | ----- | ----- |
| **@dzupagent/flow-dsl**      | Flow definition language (YAML, JSON, runtime AST) | ^3.0.0  | ~8900 | 112   |
| **@dzupagent/flow-compiler** | Flow compilation, validation, graph building       | ^3.0.0  | ~6400 | 85    |
| **@dzupagent/dialogue**      | Peer-to-peer dialogue orchestration and routing    | ^3.0.0  | ~4200 | 58    |

### Infrastructure (6 packages)

Cross-cutting infrastructure and observability.

| Package                           | Purpose                                        | Version | LOC   | Files |
| --------------------------------- | ---------------------------------------------- | ------- | ----- | ----- |
| **@dzupagent/cache**              | LRU caches, TTL invalidation, shared memory    | ^3.0.0  | ~2100 | 28    |
| **@dzupagent/otel**               | OpenTelemetry spans, metrics, cost attribution | ^3.0.0  | ~5600 | 73    |
| **@dzupagent/rag**                | RAG pipeline, vector store adapters, chunking  | ^3.0.0  | ~8200 | 107   |
| **@dzupagent/codegen**            | Code generation for agents, adapters, tools    | ^3.0.0  | ~9100 | 118   |
| **@dzupagent/knowledge-platform** | Knowledge base, hybrid search, ingestion       | ^3.0.0  | ~7500 | 98    |

### Testing & Validation (4 packages)

Testing infrastructure and deterministic evaluation.

| Package                  | Purpose                                           | Version | LOC   | Files |
| ------------------------ | ------------------------------------------------- | ------- | ----- | ----- |
| **@dzupagent/testing**   | Mock models, fixtures, deterministic LLM recorder | ^3.0.0  | ~5700 | 74    |
| **@dzupagent/evals**     | LLM-as-judge evaluation framework                 | ^3.0.0  | ~4800 | 63    |
| **@dzupagent/contracts** | Type contracts and schema validation              | ^3.0.0  | ~2900 | 37    |

### Deployment (3 packages)

Deployment runtimes and SDKs.

| Package                         | Purpose                                      | Version | LOC   | Files |
| ------------------------------- | -------------------------------------------- | ------- | ----- | ----- |
| **@dzupagent/server**           | Hono HTTP server, WebSocket, run persistence | ^3.0.0  | ~8600 | 112   |
| **@dzupagent/create-dzupagent** | Project scaffolding and CLI                  | ^3.0.0  | ~2200 | 28    |

---

## Entry Points & Main Exports

### Creating an Agent (In-Process)

```typescript
// Minimal agent
import { createAgent } from "@dzupagent/agent";
import { createClaudeAdapter } from "@dzupagent/agent-adapters";

const agent = await createAgent({
  name: "my-agent",
  model: createClaudeAdapter("claude-opus-4-1"),
  tools: [
    /* tool definitions */
  ],
});

// Stream responses
for await (const chunk of agent.stream(userMessage, { context })) {
  console.log(chunk);
}
```

### Agent Lifecycle

```typescript
import { createAgent, AgentStatus } from "@dzupagent/agent";

const agent = await createAgent({
  /* ... */
});

// Run agent
const result = await agent.run(prompt, { maxIterations: 10 });

// Get status
const status: AgentStatus = agent.status();

// Cleanup
await agent.cleanup();
```

### Memory & Context

```typescript
import { createMemoryScope } from "@dzupagent/memory";
import { createContextFrame } from "@dzupagent/context";

// Memory (tenant + agent scoped)
const memory = createMemoryScope({ tenantId, agentId });
await memory.store("key", { data: "value" });
const retrieved = await memory.retrieve("key");

// Context (safe, typed access)
const ctx = createContextFrame({
  user: { id: "...", name: "..." },
  session: { id: "..." },
});
ctx.get("user.id"); // type-safe access
ctx.require("user.id"); // throws if missing
```

### Tool Execution

```typescript
import { createToolRegistry } from "@dzupagent/app-tools";

const tools = createToolRegistry().define("list-files", {
  description: "List files in directory",
  parameters: { path: { type: "string" } },
  execute: async (params) => {
    /* ... */
  },
});

const result = await tools.execute("list-files", { path: "/tmp" });
```

### Flow Definition

```typescript
import { parseFlow } from "@dzupagent/flow-dsl";
import { compileFlow } from "@dzupagent/flow-compiler";

const flowDef = parseFlow(`
  agents:
    - name: researcher
      model: claude
    - name: reviewer
      model: codex

  flow:
    - step: researcher
      prompt: 'Research the topic'
    - step: reviewer
      prompt: 'Review the research'
`);

const compiled = await compileFlow(flowDef);
const result = await compiled.execute({ topic: "AI" });
```

### MCP Integration

```typescript
import { createMcpClient } from "@dzupagent/core";

const mcp = await createMcpClient({
  transport: "stdio", // or 'sse', 'websocket'
  command: "python -m mcp.server.anything",
  args: ["--config", "config.json"],
});

const tools = await mcp.getTools();
const result = await mcp.invokeTool("tool-name", { param: "value" });
```

### Server Deployment

```typescript
import { createDzupagentServer } from "@dzupagent/server";

const server = await createDzupagentServer({
  port: 3000,
  database: "postgresql://...",
  models: {
    default: createClaudeAdapter("claude-opus-4-1"),
    fallback: createCodexAdapter("gpt-5.5"),
  },
});

// Hono app with routes: POST /agents/runs, GET /agents/runs/:runId, etc.
server.app.listen(3000);
```

---

## Core Modules

### @dzupagent/core

The minimal foundation required by all packages.

**Responsibilities:**

- Event bus (discriminated union events)
- Model registry with circuit-breaker fallback
- Plugin system and lifecycle hooks
- MCP client wrapper (stdio, SSE, WebSocket transports)
- Typed error classes and recovery strategies
- Context manager and run state FSM

**Key Exports:**

```typescript
createEventBus(); // Typed event dispatch
createModelRegistry(); // Provider management
createMcpClient(); // MCP transport abstraction
(DzupEventBus, DzupEvent); // Type definitions
```

**Files:** 112 source files, ~8500 LOC

---

### @dzupagent/agent

Agent lifecycle, tool execution, tool calling loop, streaming.

**Responsibilities:**

- Agent creation and initialization
- Tool-calling loop (LLM → tool call → result → next)
- Streaming response adaptation (Claude/Codex/Gemini)
- Stop reasons and early exit handlers
- Token counting and budget enforcement
- Checkpoint/resume for long-running agents

**Key Exports:**

```typescript
createAgent(); // Agent factory
Agent.stream(); // Streaming response generator
Agent.run(); // Full execution with auto-retry
(AgentStatus, AgentEvent); // Type definitions
```

**Files:** 118 source files, ~10200 LOC

---

### @dzupagent/memory

Tenant + agent-scoped memory with consolidation.

**Responsibilities:**

- Memory scope builders (tenant, agent, session scoped)
- Storage backends (in-memory, PostgreSQL, Qdrant)
- Memory consolidation (summarization of old entries)
- Sanitization (PII removal for logs)
- Search and retrieval with metadata filtering

**Key Exports:**

```typescript
createMemoryScope()  // Scope builder
MemoryStore interface  // Backend contract
ConsolidationStrategy  // Summarization logic
```

**Files:** 92 source files, ~6500 LOC

---

### @dzupagent/context

Context frames for safe, typed state access.

**Responsibilities:**

- Immutable context frame builder
- Type-safe path access (e.g., `ctx.get('user.id')`)
- Safe defaults and fallbacks
- Context merging (child overrides parent)
- Sanitization hooks (removes secrets before logging)

**Key Exports:**

```typescript
createContextFrame()  // Frame builder
ContextFrame interface  // Safe accessor
```

**Files:** 71 source files, ~5200 LOC

---

### @dzupagent/agent-adapters

Provider-specific implementations (Claude, Codex, Gemini, Qwen, Crush).

**Responsibilities:**

- Provider API client wrappers
- Streaming response parsing
- Token counting per provider
- Model capability detection
- Fallback chain orchestration

**Key Exports:**

```typescript
createClaudeAdapter(); // Claude Opus/Sonnet/Haiku
createCodexAdapter(); // Codex GPT-5.5/6.0
createGeminiAdapter(); // Gemini 2.0
createQwenAdapter(); // Qwen family
// ... plus fallback chains
```

**Files:** 142 source files, ~9800 LOC

---

### @dzupagent/flow-compiler

Flow DSL → graph → executable.

**Responsibilities:**

- YAML/JSON flow parsing and validation
- Graph building with dependency analysis
- Circular dependency detection
- Compilation to executable bytecode
- Variable substitution and templating

**Key Exports:**

```typescript
compileFlow(); // Flow → executable
FlowGraph; // Graph representation
FlowValidator; // Compliance checking
```

**Files:** 85 source files, ~6400 LOC

---

## API Surface (by Domain)

### Agents

```typescript
createAgent(config);
agent.stream(prompt, options);
agent.run(prompt, options);
agent.status();
agent.cleanup();
agent.addEventListener(event, handler);
```

### Memory

```typescript
createMemoryScope(config);
memory.store(key, value);
memory.retrieve(key);
memory.search(query);
memory.consolidate();
memory.delete(key);
```

### Context

```typescript
createContextFrame(data);
frame.get(path);
frame.require(path);
frame.merge(other);
frame.sanitize();
```

### Tools

```typescript
createToolRegistry();
registry.define(name, schema, execute);
registry.execute(name, params);
registry.list();
registry.validate(name, params);
```

### Flows

```typescript
parseFlow(yaml);
compileFlow(def);
flow.execute(inputs);
flow.validate();
flow.getGraph();
```

### MCP

```typescript
createMcpClient(config);
mcp.getTools();
mcp.invokeTool(name, params);
mcp.onToolCall(handler);
mcp.disconnect();
```

### Server

```typescript
createDzupagentServer(config);
server.app; // Hono instance
server.createRun(agentDef);
server.getRun(runId);
server.listRuns();
```

---

## Standard Commands

### Root Workspace

```bash
# Build
yarn build                       # Build all 35 packages in dependency order
yarn build:deps                  # Rebuild only shared deps

# Test
yarn test                        # Run all vitest suites
yarn test:coverage               # Coverage report
yarn test:watch                  # Watch mode

# Type Checking
yarn typecheck                   # TypeScript strict mode
yarn typecheck:watch             # Watch mode

# Linting & Architecture
yarn lint                        # ESLint + Prettier
yarn lint:fix                    # Auto-fix
yarn check:cycles                # Detect dependency cycles
yarn check:boundaries            # Architecture boundary enforcement
yarn validate:agent-registry     # Provider registry validation

# Docs
yarn docs:build                  # Build API documentation
yarn docs:serve                  # Serve docs locally (port 3000)
```

### Per-Package

```bash
# Build a single package
yarn workspace @dzupagent/agent build

# Test a single package
yarn workspace @dzupagent/agent test

# Type check a single package
yarn workspace @dzupagent/agent typecheck
```

---

## Configuration Files

### Root Workspace

**`package.json`**

- Yarn 4 workspaces declaration
- Unified build/test/lint scripts
- Root dependencies (TypeScript, Vitest, ESLint, Turbo)

**`tsconfig.base.json`**

- Target: ES2022, module: NodeNext
- Strict mode enabled
- Path aliases: `@dzupagent/*` → `packages/*/src`

**`turbo.json`**

- Build/test/lint task definitions
- Caching configuration
- Pipeline dependencies

**`vitest.config.ts`**

- Test environment: node
- Pool: forks (process isolation)
- Coverage: 80% threshold

**`eslint.config.mjs`**

- Flat ESLint config (ESLint v10)
- Rules for TypeScript, Node.js

### Per-Package

Each package has:

- `tsconfig.json` — extends `../../tsconfig.base.json`
- `package.json` — name, version, exports, dependencies
- `vitest.config.ts` (optional) — package-specific overrides
- `vite.config.ts` (if library) — ESM build config

---

## Documentation

### Inside the Repository

**`README.md`**

- Quick start, architecture overview, key examples

**`CLAUDE.md`**

- Agent working rules, key commands, structure reference

**`CHANGELOG.md`**

- Version history and release notes

**`docs/`**

- Architecture decision records (ADRs)
- API documentation (auto-generated from TSDoc)
- Integration guides (Claude, Codex, Gemini, etc.)
- Example flows and use cases

### External Durable Docs

**`workspace-docs/repos/dzupagent/docs/`**

- Deep architectural documentation
- Design decisions and tradeoffs
- Capability matrix and roadmap

---

## Architecture Decisions

**Key ADRs:**

1. **Event-driven core** — All communication flows through event bus
2. **Plugin system** — Extensibility via hooks and module registration
3. **One-way dependencies** — Core ← Integrations ← Deployment (no cycles)
4. **Fail-open by default** — Degraded mode over hard failures (circuit breaker)
5. **Streaming-first** — All responses are async iterables
6. **Immutable context** — Context frames are frozen after creation
7. **Tool-calling loop** — Agent follows standard tool-calling protocol

---

## Scale Snapshot

| Metric                    | Value        |
| ------------------------- | ------------ |
| **Total Packages**        | 35           |
| **TypeScript Files**      | ~1,250       |
| **Test Files**            | ~350         |
| **Lines of Code (src)**   | ~130,000     |
| **Lines of Code (tests)** | ~95,000      |
| **Total Monorepo**        | ~225,000 LOC |
| **Node Version**          | ≥ 20.0.0     |
| **Package Manager**       | Yarn ≥ 4.0.0 |
| **TypeScript Version**    | ≥ 5.8.0      |

**Largest Packages by LOC:**

1. @dzupagent/agent (10,200 LOC, 118 files)
2. @dzupagent/codegen (9,100 LOC, 118 files)
3. @dzupagent/agent-adapters (9,800 LOC, 142 files)
4. @dzupagent/flow-dsl (8,900 LOC, 112 files)
5. @dzupagent/core (8,500 LOC, 112 files)

---

## Quick Reference

| Task             | Command                        |
| ---------------- | ------------------------------ |
| Build all        | `yarn build`                   |
| Test all         | `yarn test`                    |
| Type check       | `yarn typecheck`               |
| Lint + fix       | `yarn lint:fix`                |
| Check cycles     | `yarn check:cycles`            |
| Check boundaries | `yarn check:boundaries`        |
| Build docs       | `yarn docs:build`              |
| Check registry   | `yarn validate:agent-registry` |

---

## Key Integration Points

### Consuming in Codev App

```json
{
  "dependencies": {
    "@dzupagent/agent": "^3.0.0",
    "@dzupagent/agent-adapters": "^3.0.0",
    "@dzupagent/memory": "^3.0.0",
    "@dzupagent/app-tools": "^3.0.0",
    "@dzupagent/server": "^3.0.0"
  }
}
```

### Consuming in Other Apps

Select only the packages you need (tree-shakeable):

```typescript
// Minimal: agent + memory
import { createAgent } from "@dzupagent/agent";
import { createMemoryScope } from "@dzupagent/memory";

// Full orchestration: agent + flows + tools
import { createAgent } from "@dzupagent/agent";
import { compileFlow } from "@dzupagent/flow-compiler";
import { createToolRegistry } from "@dzupagent/app-tools";

// Deployment: server + all integrations
import { createDzupagentServer } from "@dzupagent/server";
```

---

## Notes

- **Live Dependency:** DzupAgent is consumed by codev-app and other apps via workspace links. Test all consuming apps after changes (`yarn typecheck` at workspace root).
- **Provider Health:** Check provider health before long runs with `yarn agent-planning:provider-health`.
- **Token Efficiency:** Context is expensive; compress large histories via memory consolidation.
- **Streaming:** All agent responses are async iterables for backpressure and cancellation support.
- **Publishing:** Packages are published to npm under `@dzupagent` scope.
