# 01 — Target Architecture

> **Gaps addressed**: G-13 (event bus), G-15 (plugin architecture), G-16 (structured errors), structural foundation for all other gaps

---

## 1. Package Dependency Graph

```
                    ┌──────────────────────┐
                    │  @dzipagent/server   │  ← HTTP/WS runtime (optional)
                    │  Hono + WebSocket     │
                    └──────────┬───────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
  ┌─────────▼──────┐ ┌────────▼───────┐ ┌────────▼───────┐
  │ @dzipagent/   │ │ @dzipagent/   │ │ @dzipagent/   │
  │   codegen      │ │    evals       │ │  connectors    │
  │ VFS, pipeline, │ │ LLM judge,     │ │ GitHub, Slack, │
  │ sandbox, tools │ │ scorers, A/B   │ │ HTTP, DB       │
  └────────┬───────┘ └────────┬───────┘ └────────┬───────┘
           │                  │                  │
           └──────────────────┼──────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  @dzipagent/agent │  ← Agent class, workflow engine,
                    │  DzipAgent,       │    orchestration, agents-as-tools
                    │  workflows, HITL   │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  @dzipagent/core  │  ← Zero-side-effect primitives
                    │  LLM, prompt,      │    (no I/O unless store injected)
                    │  memory, context,  │
                    │  router, streaming,│
                    │  event bus, MCP,   │
                    │  skills, errors    │
                    └───────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  @dzipagent/      │  ← Test-time only
                    │   test-utils       │    LLM recorder, mocks
                    └───────────────────┘
```

### Dependency Rules (Enforced by Boundary Tests)

1. **`core` imports NOTHING from other `@dzipagent/*` packages**
2. **`agent` depends only on `core`**
3. **`codegen` depends only on `core`** (may use `agent` types via peer dep)
4. **`server` depends on `core` + `agent`** (optional: `codegen`, `evals`, `connectors`)
5. **`evals` depends only on `core`**
6. **`connectors` depends only on `core`**
7. **`test-utils` depends only on `core`** (devDependency for all packages)
8. **`mcp` lives inside `core/src/mcp/`** (not a separate package — too tightly coupled with tool system)

---

## 2. Layer Architecture

### Layer 0: Core Primitives (`@dzipagent/core`)

**Principle**: Stateless, zero-I/O by default. All persistence is injected via interfaces.

```
core/src/
├── errors/                 ← NEW: Structured error types
│   ├── forge-error.ts      ForgeError class with code, recoverable, phase, suggestion
│   ├── error-codes.ts      Exhaustive error code enum
│   └── index.ts
├── events/                 ← NEW: Internal event bus
│   ├── event-bus.ts        Typed pub/sub (emit/on/off/once)
│   ├── event-types.ts      All DzipEvent discriminated union
│   └── index.ts
├── hooks/                  ← NEW: Lifecycle hook system
│   ├── hook-types.ts       AgentHooks, ToolHooks, PipelineHooks interfaces
│   ├── hook-runner.ts      Sequential hook execution with error isolation
│   └── index.ts
├── plugin/                 ← NEW: Plugin registration
│   ├── plugin-types.ts     DzipPlugin interface
│   ├── plugin-registry.ts  Registration, validation, conflict detection
│   └── index.ts
├── llm/                    ← ENHANCED
│   ├── model-registry.ts   + fallback chains, circuit breaker
│   ├── model-config.ts
│   ├── invoke.ts
│   ├── retry.ts
│   ├── prompt-cache.ts
│   ├── circuit-breaker.ts  ← NEW: health tracking, half-open state
│   └── provider-types.ts   ← NEW: ForgeProvider interface (non-LangChain)
├── mcp/                    ← NEW: MCP integration
│   ├── mcp-client.ts       Connect, discover, invoke MCP servers
│   ├── mcp-server.ts       Expose agents as MCP tools
│   ├── mcp-tool-bridge.ts  MCP ↔ LangChain StructuredTool conversion
│   ├── deferred-loader.ts  Lazy tool schema loading
│   └── index.ts
├── prompt/                 (existing, no changes)
├── memory/                 ← ENHANCED
│   ├── memory-service.ts   + confidence scoring, categories
│   ├── memory-types.ts
│   ├── memory-sanitizer.ts
│   ├── memory-consolidation.ts
│   ├── store-factory.ts    + InMemoryStore
│   ├── working-memory.ts   ← NEW: Zod-schema working memory
│   ├── observation-extractor.ts ← NEW: Background fact extraction
│   └── index.ts
├── context/                ← ENHANCED
│   ├── message-manager.ts
│   ├── context-eviction.ts
│   ├── completeness-scorer.ts
│   └── system-reminder.ts  ← NEW: Periodic instruction re-injection
├── persistence/            ← ENHANCED
│   ├── store-interfaces.ts ← NEW: AgentStore, RunStore, MemoryStore interfaces
│   ├── in-memory-store.ts  ← NEW: Dev/test store
│   ├── checkpointer.ts
│   ├── session.ts
│   └── index.ts
├── middleware/             (existing, minor additions)
├── router/                 (existing, no changes)
├── streaming/              ← ENHANCED
│   ├── sse-transformer.ts
│   ├── event-types.ts
│   └── stream-action-parser.ts ← NEW: Parse streaming output for actions
├── subagent/               (existing, enhanced in agent package)
├── skills/                 ← ENHANCED
│   ├── agents-md-parser.ts ← NEW: AGENTS.md format support
│   ├── hierarchical-walker.ts ← NEW: Git root → CWD discovery
│   └── ... existing files
└── index.ts                 60+ exports
```

### Layer 1: Agent Orchestration (`@dzipagent/agent`)

```
agent/src/
├── agent/
│   ├── dzip-agent.ts       ENHANCED: hooks, events, plugins, structured output
│   ├── agent-types.ts       + DzipAgentConfig with hooks, plugins
│   └── tool-loop.ts         ENHANCED: full ReAct for sub-agents
├── workflow/                ← NEW: General-purpose workflow engine
│   ├── workflow-builder.ts  Fluent API: then/branch/parallel/suspend
│   ├── workflow-runner.ts   LangGraph compilation, durable execution
│   ├── workflow-types.ts    Step, Branch, ParallelGroup schemas
│   ├── suspend-resume.ts   Checkpoint-based suspend/resume
│   └── index.ts
├── orchestration/           ← NEW: Multi-agent patterns
│   ├── orchestrator.ts      Sequential, parallel, supervisor, debate
│   ├── supervisor-agent.ts  Manager that delegates to specialists
│   ├── merge-strategies.ts  Result merging (concat, vote, synthesize)
│   └── index.ts
├── approval/                ← NEW: Human-in-the-loop
│   ├── approval-gate.ts     Pause execution, emit approval event
│   ├── approval-types.ts    auto, required, conditional
│   └── index.ts
├── context/
│   └── auto-compress.ts
├── guardrails/
│   ├── guardrail-types.ts
│   ├── iteration-budget.ts  ENHANCED: shared across parent/child
│   └── stuck-detector.ts    ← NEW: Detect circular/no-progress loops
├── tools/
│   └── create-tool.ts
└── index.ts
```

### Layer 2: Domain Packages

#### `@dzipagent/codegen` (enhanced)
```
codegen/src/
├── git/                     ← NEW: Git integration
│   ├── git-tools.ts         status, diff, commit, branch tools
│   ├── git-middleware.ts     Inject git context into agent state
│   ├── git-worktree.ts      Worktree isolation for parallel agents
│   ├── commit-message.ts    LLM-generated commit messages
│   └── index.ts
├── tools/                   ← ENHANCED
│   ├── edit-file.tool.ts    + search/replace blocks, unified diff
│   ├── multi-edit.tool.ts   ← NEW: Multiple edits in one call
│   ├── lint-validator.ts    ← NEW: Reject edits introducing errors
│   └── ... existing tools
├── repo-map/                ← NEW: Repository understanding
│   ├── symbol-extractor.ts  AST-based symbol extraction
│   ├── import-graph.ts      File → file dependency mapping
│   ├── relevance-ranker.ts  PageRank-style symbol importance
│   ├── repo-map-builder.ts  Condensed repo representation
│   └── index.ts
├── sandbox/                 ← ENHANCED
│   ├── sandbox-protocol.ts
│   ├── docker-sandbox.ts    + tiered permissions
│   ├── permission-tiers.ts  ← NEW: read-only, workspace-write, full-access
│   ├── mock-sandbox.ts
│   └── index.ts
├── validation/              ← NEW: Multi-file coherence
│   ├── import-validator.ts  Verify all imports resolve
│   ├── type-checker.ts      Cross-file type compatibility
│   ├── contract-validator.ts Backend↔frontend contract matching
│   └── index.ts
├── vfs/                     (existing)
├── generation/              (existing)
├── quality/                 (existing, enhanced)
├── adaptation/              (existing)
├── contract/                (existing)
├── context/                 (existing)
├── pipeline/                ← ENHANCED
│   ├── gen-pipeline-builder.ts + parallel(), branch(), mapReduce()
│   ├── graph-compiler.ts    ← NEW: Pipeline config → LangGraph StateGraph
│   └── ... existing
└── index.ts
```

#### `@dzipagent/evals` (new)
```
evals/src/
├── scorers/
│   ├── llm-judge.ts         Model-graded evaluation
│   ├── deterministic.ts     Rule-based scoring
│   ├── statistical.ts       pass@k, accuracy, etc.
│   └── composite.ts         Combine multiple scorers
├── runner/
│   ├── eval-runner.ts       Batch evaluation execution
│   ├── regression.ts        Track scores across runs
│   └── ab-testing.ts        Compare model/prompt variants
├── types.ts
└── index.ts
```

#### `@dzipagent/connectors` (new)
```
connectors/src/
├── connector-types.ts       ConnectorFactory → ToolDefinition[]
├── github/
│   ├── github-connector.ts  Repos, issues, PRs, files as tools
│   └── index.ts
├── http/
│   ├── http-connector.ts    Generic REST API as a tool
│   └── index.ts
├── slack/
│   ├── slack-connector.ts   Channels, messages, files
│   └── index.ts
├── database/
│   ├── db-connector.ts      Query execution tool
│   └── index.ts
└── index.ts
```

#### `@dzipagent/server` (new)
```
server/src/
├── app.ts                   Hono app factory
├── routes/
│   ├── agents.ts            CRUD for agent definitions
│   ├── runs.ts              Trigger, status, cancel, logs
│   ├── tools.ts             List available tools
│   ├── health.ts            Liveness + readiness probes
│   └── approval.ts          Approve/reject runs
├── middleware/
│   ├── auth.ts              API key validation
│   ├── rate-limit.ts        Per-key rate limiting
│   └── workspace.ts         Multi-tenant resolution
├── ws/
│   ├── ws-handler.ts        WebSocket subscriptions
│   └── event-bridge.ts      EventBus → WS push
├── persistence/
│   ├── postgres-agent-store.ts
│   ├── postgres-run-store.ts
│   └── drizzle-schema.ts    Agent + Run tables
└── index.ts
```

---

## 3. Cross-Cutting Concerns

### 3.1 Structured Error Types (G-16)

```typescript
// core/src/errors/forge-error.ts
export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly recoverable: boolean;
  readonly phase?: string;
  readonly suggestion?: string;
  readonly context?: Record<string, unknown>;

  constructor(opts: {
    code: ForgeErrorCode;
    message: string;
    recoverable?: boolean;
    phase?: string;
    suggestion?: string;
    context?: Record<string, unknown>;
    cause?: Error;
  }) { ... }
}

// core/src/errors/error-codes.ts
export type ForgeErrorCode =
  // Provider errors
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_AUTH_FAILED'
  | 'ALL_PROVIDERS_EXHAUSTED'
  // Budget errors
  | 'BUDGET_EXCEEDED'
  | 'TOKEN_LIMIT_EXCEEDED'
  | 'COST_LIMIT_EXCEEDED'
  | 'ITERATION_LIMIT_EXCEEDED'
  // Pipeline errors
  | 'PIPELINE_PHASE_FAILED'
  | 'VALIDATION_FAILED'
  | 'TEST_FAILED'
  | 'FIX_ESCALATION_EXHAUSTED'
  // Tool errors
  | 'TOOL_NOT_FOUND'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_TIMEOUT'
  | 'MCP_CONNECTION_FAILED'
  // Memory errors
  | 'MEMORY_WRITE_FAILED'
  | 'MEMORY_SEARCH_FAILED'
  | 'MEMORY_INJECTION_DETECTED'
  // Approval errors
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_TIMEOUT'
  // General
  | 'AGENT_STUCK'
  | 'INVALID_CONFIG'
  | 'INTERNAL_ERROR';
```

### 3.2 Event Bus (G-13)

```typescript
// core/src/events/event-types.ts
export type DzipEvent =
  | { type: 'agent:started'; agentId: string; runId: string }
  | { type: 'agent:completed'; agentId: string; runId: string; result: unknown }
  | { type: 'agent:failed'; agentId: string; runId: string; error: ForgeError }
  | { type: 'tool:called'; toolName: string; input: unknown }
  | { type: 'tool:result'; toolName: string; result: string; durationMs: number }
  | { type: 'tool:error'; toolName: string; error: ForgeError }
  | { type: 'memory:written'; namespace: string; key: string }
  | { type: 'memory:searched'; namespace: string; query: string; results: number }
  | { type: 'budget:warning'; level: 'warn' | 'critical'; usage: BudgetUsage }
  | { type: 'budget:exceeded'; reason: string }
  | { type: 'pipeline:phase_changed'; phase: string; previousPhase: string }
  | { type: 'pipeline:validation_failed'; errors: string[] }
  | { type: 'approval:requested'; runId: string; plan: unknown }
  | { type: 'approval:granted'; runId: string; approvedBy?: string }
  | { type: 'approval:rejected'; runId: string; reason?: string }
  | { type: 'mcp:connected'; serverName: string; toolCount: number }
  | { type: 'mcp:disconnected'; serverName: string }
  | { type: 'hook:error'; hookName: string; error: Error };

// core/src/events/event-bus.ts
export interface DzipEventBus {
  emit(event: DzipEvent): void;
  on<T extends DzipEvent['type']>(
    type: T,
    handler: (event: Extract<DzipEvent, { type: T }>) => void | Promise<void>
  ): () => void;  // returns unsubscribe function
  once<T extends DzipEvent['type']>(
    type: T,
    handler: (event: Extract<DzipEvent, { type: T }>) => void | Promise<void>
  ): () => void;
}

export function createEventBus(): DzipEventBus { ... }
```

### 3.3 Plugin Architecture (G-15)

```typescript
// core/src/plugin/plugin-types.ts
export interface DzipPlugin {
  name: string;
  version: string;

  // Called when plugin is registered
  onRegister?(ctx: PluginContext): void | Promise<void>;

  // Extend capabilities
  providers?: Array<{ tier: ModelTier; factory: () => BaseChatModel }>;
  tools?: StructuredToolInterface[];
  qualityDimensions?: QualityDimension[];
  middleware?: AgentMiddleware[];
  hooks?: Partial<AgentHooks>;
  skills?: SkillDefinition[];
  eventHandlers?: Partial<Record<DzipEvent['type'], (event: DzipEvent) => void>>;
}

export interface PluginContext {
  eventBus: DzipEventBus;
  modelRegistry: ModelRegistry;
  memoryService?: MemoryService;
}
```

### 3.4 Lifecycle Hooks (G-14)

```typescript
// core/src/hooks/hook-types.ts
export interface AgentHooks {
  // Run lifecycle
  onRunStart?: (ctx: HookContext) => Promise<void>;
  onRunComplete?: (ctx: HookContext, result: unknown) => Promise<void>;
  onRunError?: (ctx: HookContext, error: ForgeError) => Promise<void>;

  // Tool lifecycle
  beforeToolCall?: (toolName: string, input: unknown) => Promise<unknown | void>;
  afterToolCall?: (toolName: string, input: unknown, result: string) => Promise<string | void>;
  onToolError?: (toolName: string, error: Error) => Promise<void>;

  // Pipeline lifecycle
  onPhaseChange?: (phase: string, previousPhase: string) => Promise<void>;
  onApprovalRequired?: (plan: unknown) => Promise<void>;

  // Budget lifecycle
  onBudgetWarning?: (level: 'warn' | 'critical', usage: BudgetUsage) => Promise<void>;
  onBudgetExceeded?: (reason: string) => Promise<void>;
}

export interface HookContext {
  agentId: string;
  runId: string;
  eventBus: DzipEventBus;
  metadata: Record<string, unknown>;
}
```

---

## 4. Boundary Enforcement Test

To prevent architectural drift, add a test that verifies dependency rules:

```typescript
// __tests__/boundary.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

function getImports(dir: string): string[] {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(f => f.isFile() && f.name.endsWith('.ts'));
  const imports: string[] = [];
  for (const f of files) {
    const content = readFileSync(join(f.parentPath, f.name), 'utf8');
    const matches = content.matchAll(/from ['"](@forgeagent\/[^'"]+)/g);
    for (const m of matches) imports.push(m[1]);
  }
  return [...new Set(imports)];
}

describe('Package boundary enforcement', () => {
  it('core imports no other @forgeagent packages', () => {
    const imports = getImports(resolve('packages/forgeagent-core/src'));
    expect(imports).toEqual([]);
  });

  it('agent imports only @dzipagent/core', () => {
    const imports = getImports(resolve('packages/forgeagent-agent/src'));
    expect(imports.every(i => i === '@dzipagent/core')).toBe(true);
  });

  it('codegen imports only @dzipagent/core', () => {
    const imports = getImports(resolve('packages/forgeagent-codegen/src'));
    expect(imports.every(i => i === '@dzipagent/core')).toBe(true);
  });
});
```

---

## 5. Design Principles

1. **Stateless core, injected persistence** — Core primitives take store interfaces, never instantiate I/O
2. **Event-driven, not callback-spaghetti** — All side effects communicated via typed events
3. **Non-fatal by default** — Memory, hooks, middleware failures never break agent execution
4. **Plugin-first extensibility** — New capabilities via plugins, not core modifications
5. **Budget-aware everywhere** — Token/cost/iteration tracking propagates through all layers
6. **Security-first memory** — All stored content scanned for injection before persistence
7. **Graceful degradation** — Fallback chains at every level (provider, intent routing, tool execution)
8. **LangGraph compatibility** — All pipeline execution compiles to LangGraph StateGraphs
