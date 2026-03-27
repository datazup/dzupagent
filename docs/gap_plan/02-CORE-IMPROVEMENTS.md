# 02 — Core Package Improvements

> **Gaps addressed**: G-03 (provider fallback), G-13 (event bus), G-14 (hooks), G-15 (plugin), G-16 (errors), G-17 (circuit breaker), G-18 (in-memory store)

---

## 1. Provider-Level Fallback & Circuit Breaker (G-03, G-17)

### Problem
If the primary LLM provider (e.g., Anthropic) is down, DzipAgent fails completely. Gnana implements provider fallback chains; DzipAgent has none.

### Solution: Extend ModelRegistry

```typescript
// Enhanced ModelRegistry configuration
const registry = new ModelRegistry();

// Register multiple providers per tier with priority
registry.registerTier('codegen', [
  { priority: 1, factory: () => new ChatAnthropic({ model: 'claude-sonnet-4-6' }) },
  { priority: 2, factory: () => new ChatOpenAI({ model: 'gpt-4.1' }) },
  { priority: 3, factory: () => new ChatOpenAI({ model: 'gemini-2.5-pro', baseURL: '...' }) },
]);

// On invocation, try priority 1 first; on transient failure, try priority 2, etc.
const model = await registry.getModelWithFallback('codegen');
```

### Circuit Breaker Implementation

```typescript
// core/src/llm/circuit-breaker.ts
interface CircuitBreakerConfig {
  failureThreshold: number;     // failures before opening (default: 3)
  resetTimeoutMs: number;       // time in open state before half-open (default: 30_000)
  halfOpenMaxAttempts: number;  // attempts in half-open before re-closing (default: 1)
}

type CircuitState = 'closed' | 'open' | 'half-open';

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureAt = 0;

  canExecute(): boolean { ... }
  recordSuccess(): void { ... }
  recordFailure(): void { ... }
}
```

### Integration with ModelRegistry

```typescript
// Each provider entry gets its own circuit breaker
interface ProviderEntry {
  priority: number;
  factory: () => BaseChatModel;
  circuitBreaker: CircuitBreaker;
  healthCheck?: () => Promise<boolean>;
}

// getModelWithFallback() skips providers whose circuit is open
async getModelWithFallback(tier: ModelTier): Promise<BaseChatModel> {
  const entries = this.tiers.get(tier)?.sort((a, b) => a.priority - b.priority);
  for (const entry of entries) {
    if (!entry.circuitBreaker.canExecute()) continue;
    try {
      const model = entry.factory();
      // Optionally health-check before returning
      return model;
    } catch (err) {
      entry.circuitBreaker.recordFailure();
      eventBus.emit({ type: 'provider:failed', tier, priority: entry.priority });
    }
  }
  throw new ForgeError({
    code: 'ALL_PROVIDERS_EXHAUSTED',
    message: `All providers for tier "${tier}" are unavailable`,
    recoverable: false,
    suggestion: 'Check provider API keys and service status',
  });
}
```

**Files to create/modify**:
- `core/src/llm/circuit-breaker.ts` — NEW (~80 LOC)
- `core/src/llm/model-registry.ts` — MODIFY: add fallback chain logic (~60 LOC delta)
- `core/src/llm/provider-types.ts` — NEW: ProviderEntry, FallbackConfig (~30 LOC)

---

## 2. Internal Event Bus (G-13)

### Problem
DzipAgent has SSE streaming for output but no internal event system for decoupled communication between components.

### Solution

See `01-ARCHITECTURE.md` Section 3.2 for full type definitions.

**Key design decisions**:
- **Synchronous emit, async handlers** — `emit()` is fire-and-forget; handlers run in microtask queue
- **Error isolation** — Handler errors are caught and logged, never break the emitter
- **Typed discrimination** — Each event type narrows to its specific payload via TypeScript discriminated unions
- **Memory leak prevention** — `on()` returns an unsubscribe function; warn on >100 handlers per event type

**Files to create**:
- `core/src/events/event-bus.ts` — (~60 LOC)
- `core/src/events/event-types.ts` — (~80 LOC)
- `core/src/events/index.ts`

---

## 3. Lifecycle Hooks (G-14)

### Problem
DzipAgent has middleware (`wrapModelCall`, `wrapToolCall`, `beforeAgent`) but no lifecycle hooks. Gnana's hook system (`onRunStart`, `onAnalysisComplete`, `beforeToolCall`, etc.) is more intuitive.

### Solution

See `01-ARCHITECTURE.md` Section 3.4 for full type definitions.

**Key behaviors**:
- Hooks run **sequentially** (not parallel) to allow modification of inputs
- `beforeToolCall` can return a modified input or `void` (pass-through)
- `afterToolCall` can return a modified result or `void` (pass-through)
- Hook errors are caught, logged via event bus, and never break execution
- Multiple hooks of the same type are supported (from plugins)

**Integration with DzipAgent**:

```typescript
// In DzipAgent constructor
const agent = new DzipAgent({
  hooks: {
    onRunStart: async (ctx) => {
      await auditLog.record('agent:started', ctx);
    },
    beforeToolCall: async (name, input) => {
      if (name === 'delete_file') throw new Error('Blocked');
      return input;  // pass-through
    },
    onBudgetWarning: async (level, usage) => {
      if (level === 'critical') {
        await notifySlack(`Budget at ${usage.percent}%`);
      }
    },
  },
});
```

**Files to create**:
- `core/src/hooks/hook-types.ts` — (~40 LOC)
- `core/src/hooks/hook-runner.ts` — (~60 LOC)
- `core/src/hooks/index.ts`

---

## 4. Plugin Architecture (G-15)

### Problem
Adding new capabilities (MCP servers, connectors, quality dimensions) requires modifying core. No standardized extension mechanism.

### Solution

See `01-ARCHITECTURE.md` Section 3.3 for full type definitions.

**Plugin registration flow**:

```typescript
const forge = new ForgeInstance({
  modelRegistry,
  eventBus: createEventBus(),
});

// Register plugins
forge.use(mcpPlugin({
  servers: [
    { name: 'filesystem', transport: 'stdio', command: 'npx @mcp/fs' },
  ],
}));

forge.use(githubConnector({ token: process.env.GITHUB_TOKEN }));

forge.use(sentryPlugin({ dsn: process.env.SENTRY_DSN }));

// Plugins can contribute tools, providers, middleware, hooks, event handlers
// All resolved at DzipAgent creation time
const agent = forge.createAgent({
  id: 'code-reviewer',
  instructions: '...',
  model: 'codegen',  // resolved via registry
});
```

**Files to create**:
- `core/src/plugin/plugin-types.ts` — (~30 LOC)
- `core/src/plugin/plugin-registry.ts` — (~80 LOC)
- `core/src/plugin/index.ts`

---

## 5. In-Memory Store (G-18)

### Problem
`StoreFactory` throws `Error('In-memory store not yet implemented')` for `type: 'memory'`. This blocks local development and testing without PostgreSQL.

### Solution

```typescript
// core/src/persistence/in-memory-store.ts
export class InMemoryStore implements MemoryStore {
  private data = new Map<string, Map<string, unknown>>();

  async put(namespace: string, key: string, value: unknown, opts?: { index?: string[] }): Promise<void> {
    if (!this.data.has(namespace)) this.data.set(namespace, new Map());
    this.data.get(namespace)!.set(key, {
      value,
      text: opts?.index?.includes('text') ? String(value) : undefined,
      updatedAt: Date.now(),
    });
  }

  async get(namespace: string, key?: string): Promise<unknown> {
    const ns = this.data.get(namespace);
    if (!ns) return key ? undefined : [];
    if (key) return ns.get(key)?.value;
    return [...ns.values()].map(v => v.value);
  }

  async search(namespace: string, query: string, limit = 10): Promise<unknown[]> {
    // Simple keyword search (no embeddings)
    const ns = this.data.get(namespace);
    if (!ns) return [];
    const results: Array<{ value: unknown; score: number }> = [];
    const queryLower = query.toLowerCase();
    for (const entry of ns.values()) {
      const text = entry.text ?? JSON.stringify(entry.value);
      const score = text.toLowerCase().includes(queryLower) ? 1 : 0;
      if (score > 0) results.push({ value: entry.value, score });
    }
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.value);
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.data.get(namespace)?.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}
```

**Files to create/modify**:
- `core/src/persistence/in-memory-store.ts` — NEW (~60 LOC)
- `core/src/persistence/store-interfaces.ts` — NEW: Abstract interfaces (~40 LOC)
- `core/src/memory/store-factory.ts` — MODIFY: wire up InMemoryStore (~10 LOC delta)

---

## 6. Store Interface Abstraction (G-20)

### Problem
Persistence is coupled to LangGraph's PostgresStore. No abstraction for agent definitions or run history.

### Solution

```typescript
// core/src/persistence/store-interfaces.ts
export interface AgentStore {
  save(agent: AgentDefinition): Promise<void>;
  get(id: string): Promise<AgentDefinition | null>;
  list(filter?: { tags?: string[] }): Promise<AgentDefinition[]>;
  delete(id: string): Promise<void>;
  getVersions(id: string): Promise<AgentDefinition[]>;
}

export interface RunStore {
  create(run: CreateRunInput): Promise<Run>;
  update(id: string, update: Partial<Run>): Promise<void>;
  get(id: string): Promise<Run | null>;
  list(filter?: RunFilter): Promise<Run[]>;
  addLog(runId: string, entry: LogEntry): Promise<void>;
  getLogs(runId: string, filter?: LogFilter): Promise<LogEntry[]>;
}

export interface Run {
  id: string;
  agentId: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'rejected';
  input: unknown;
  output?: unknown;
  tokenUsage?: { input: number; output: number };
  costCents?: number;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

In-memory implementations for dev/test; Postgres implementations in `@dzipagent/server`.

---

## 7. Implementation Estimates

| Component | New Files | ~LOC | Priority | Depends On |
|-----------|-----------|------|----------|------------|
| Circuit breaker | 1 | 80 | P0 | — |
| Provider fallback in ModelRegistry | 1 modified + 1 new | 90 | P0 | Circuit breaker |
| Event bus | 3 | 140 | P0 | — |
| Lifecycle hooks | 3 | 100 | P1 | Event bus |
| Plugin architecture | 3 | 110 | P1 | Event bus, hooks |
| In-memory store | 1 | 60 | P0 | — |
| Store interfaces (Agent/Run) | 1 | 80 | P1 | — |
| Structured error types | 3 | 80 | P0 | — |
| **Total** | **~16 files** | **~740 LOC** | | |
