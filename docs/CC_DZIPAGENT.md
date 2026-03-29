# DzipAgent as Orchestrator for Claude Code & Codex CLI via JS SDKs

## Research Analysis & Architecture Proposal

---

## 1. Executive Summary

DzipAgent is uniquely positioned to serve as an orchestration layer between Anthropic's Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and OpenAI's Codex SDK (`@openai/codex-sdk`). Both SDKs work by spawning CLI subprocesses and communicating via JSONL over stdio — a pattern DzipAgent already implements successfully with its `GitExecutor` in `@dzipagent/codegen`. Combined with DzipAgent's mature orchestration engine (supervisor, contract-net, map-reduce, topology-based routing), event bus, circuit breaker, and plugin system, this creates a compelling multi-agent platform that can:

- Route tasks to the best agent (Claude or Codex) based on task type, cost, and provider health
- Run agents in parallel with fan-out/fan-in patterns
- Implement provider-level fallback when one agent fails
- Maintain unified observability, cost tracking, and session management
- Apply consistent security policies and sandboxing across both agents

**Key finding:** The value is real and significant. DzipAgent's existing architecture maps almost 1:1 to what's needed — the gap is primarily in building thin adapter layers, not new infrastructure.

---

## 2. SDK Landscape (Current State)

### 2.1 Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

> **Note:** Formerly `@anthropic-ai/claude-code` — the old package name is deprecated.

| Aspect | Details |
|--------|---------|
| **Primary API** | `query()` → `AsyncGenerator<SDKMessage>` |
| **Session mgmt** | `resume`, `continue`, `forkSession`, `listSessions()`, `getSessionInfo()` |
| **Streaming** | 20+ message types via async iteration |
| **Custom tools** | MCP servers (stdio/SSE/HTTP/in-process) + `tool()` helper with Zod |
| **Subagents** | First-class `agents` option with background support |
| **Hooks** | 18 hook events (PreToolUse, PostToolUse, SessionStart, etc.) |
| **Permissions** | 5 modes + `canUseTool` callback + allow/deny lists |
| **Cost control** | `maxBudgetUsd`, `maxTurns` |
| **Sandbox** | Full config: network domains, filesystem paths, unix sockets |
| **Abort** | `AbortController` + `query.interrupt()` |

### 2.2 Codex SDK (`@openai/codex-sdk`)

| Aspect | Details |
|--------|---------|
| **Primary API** | `Codex` → `Thread.run()` / `Thread.runStreamed()` |
| **Session mgmt** | `resumeThread(id)` — no discovery/listing/fork APIs |
| **Streaming** | 8 event types via async generator |
| **Custom tools** | MCP tool calls supported |
| **Subagents** | Not exposed in SDK |
| **Hooks** | None |
| **Permissions** | `approvalPolicy` with 4 modes |
| **Cost control** | Not exposed |
| **Sandbox** | 3 modes: read-only, workspace-write, danger-full-access |
| **Abort** | `AbortSignal` on TurnOptions |

### 2.3 Gemini CLI

| Aspect | Details |
|--------|---------|
| **Primary API** | `gemini` CLI binary — no official JS SDK for CLI agent mode yet |
| **Integration** | `child_process.spawn('gemini', [...])` with JSONL output parsing |
| **Models** | Gemini 2.5 Pro, Gemini 2.5 Flash, etc. |
| **Session mgmt** | File-based, similar to Claude/Codex pattern |
| **Streaming** | JSONL events over stdout |
| **Sandbox** | Google-managed sandboxing |
| **LLM API** | Available via `@langchain/google-genai` or OpenAI-compatible endpoint (`generativelanguage.googleapis.com/v1beta/openai/`) |
| **Strengths** | Long context (1M+ tokens), multimodal, competitive pricing, strong code understanding |

### 2.4 Qwen

| Aspect | Details |
|--------|---------|
| **Primary API** | OpenAI-compatible API via Alibaba Cloud DashScope |
| **Integration** | `ChatOpenAI` with custom `baseUrl` (`dashscope.aliyuncs.com/compatible-mode/v1`) |
| **Models** | Qwen3, Qwen-Coder, Qwen-Max, Qwen-Turbo |
| **Session mgmt** | API-based (no persistent CLI sessions) |
| **CLI** | No official agentic CLI — accessible via LangChain or direct API |
| **Strengths** | Strong multilingual support, competitive code generation, cost-effective, open-weight models available for self-hosting |

### 2.5 Crush

| Aspect | Details |
|--------|---------|
| **Primary API** | Local model runner CLI (`crush` binary) |
| **Integration** | `child_process.spawn('crush', [...])` |
| **Models** | Local/self-hosted models (Llama, CodeLlama, DeepSeek, etc.) |
| **Session mgmt** | Process-level |
| **Strengths** | Zero API cost, full data privacy, offline capability, low-latency for local tasks |
| **Limitations** | Limited to local hardware capabilities, no cloud-scale context windows |

### 2.6 Critical Observation

All agent integrations fall into two patterns:
1. **SDK-based** (Claude, Codex): Spawn CLI subprocess, communicate via JSONL over stdio
2. **API-based** (Gemini, Qwen): OpenAI-compatible HTTP API via LangChain `ChatOpenAI`
3. **CLI-based** (Gemini CLI, Crush): Direct `child_process.spawn` with output parsing

DzipAgent handles all three patterns:
- **Process overhead** per invocation — DzipAgent's circuit breaker and session reuse become valuable
- **Local file-based sessions** — orchestrator must manage session IDs for multi-turn
- **No built-in rate limiting** — DzipAgent's middleware pipeline fills this gap
- **Provider diversity** — ModelRegistry now supports `google` and `qwen` provider types natively

---

## 3. Value Proposition: Why DzipAgent as Orchestrator

### 3.1 Capabilities DzipAgent Already Has

| DzipAgent Feature | Orchestration Value |
|-------------------|-------------------|
| **ModelRegistry + Circuit Breaker** | Route to healthy provider; failover when Claude or Codex is down |
| **Supervisor Pattern** | Delegate subtasks to Claude (reasoning) vs Codex (code execution) |
| **Contract-Net Protocol** | Competitive bidding — both agents bid on tasks, best proposal wins |
| **Map-Reduce** | Split large codebases across agents, merge results |
| **Topology Engine** | Dynamic topology selection based on task characteristics |
| **Workflow Builder** | Declarative pipelines with suspend/resume for human-in-the-loop |
| **Pipeline Runtime** | DAG execution with fork/join, loops, checkpoints, retry policies |
| **DzipEventBus** | Unified event stream from both agents (139 event types) |
| **Plugin System** | Extend with custom routing logic, telemetry, cost tracking |
| **MCP Tool Bridge** | Share tools between agents via MCP protocol |
| **DynamicToolRegistry** | Hot-swap tools at runtime based on which agent is active |
| **Middleware Pipeline** | Cost attribution, request transformation, logging per agent |
| **GitExecutor Pattern** | Proven pattern for wrapping CLI tools — directly applicable |

### 3.2 What DzipAgent Adds That Neither SDK Has Alone

1. **Cross-agent task routing** — No SDK can route tasks to its competitor
2. **Provider-level health tracking** — Circuit breaker across both providers
3. **Unified cost management** — Track spend across Claude and Codex in one budget
4. **Consistent security policies** — Same permission rules regardless of which agent executes
5. **Workflow orchestration** — Multi-step pipelines spanning both agents
6. **Session correlation** — Link Claude sessions and Codex threads under one workflow ID
7. **Competitive execution** — Race both agents, take the faster/better result
8. **Specialized routing** — Claude for reasoning-heavy tasks, Codex for execution-heavy tasks

---

## 4. Architecture Design

### 4.1 Adapter Layer

```
┌──────────────────────────────────────────────────────────────────┐
│                      DzipAgent Orchestrator                      │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐          │
│  │  Workflow     │  │  Supervisor  │  │  Contract-Net │          │
│  │  Builder      │  │  Pattern     │  │  Protocol     │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘          │
│         │                 │                  │                   │
│  ┌──────▼─────────────────▼──────────────────▼────────────────┐  │
│  │          AdapterRegistry + TaskRouter                      │  │
│  │  (CircuitBreaker per adapter + pluggable routing strategy) │  │
│  └──┬──────────┬──────────┬──────────┬──────────┬─────────────┘  │
│     │          │          │          │          │                 │
│  ┌──▼───┐  ┌──▼───┐  ┌──▼────┐  ┌──▼───┐  ┌──▼────┐           │
│  │Claude│  │Codex │  │Gemini │  │Qwen  │  │Crush │           │
│  │Adapt.│  │Adapt.│  │Adapt. │  │Adapt.│  │Adapt.│           │
│  └──┬───┘  └──┬───┘  └──┬────┘  └──┬───┘  └──┬────┘           │
│     │         │         │          │         │                  │
│  ┌──▼───┐  ┌──▼───┐  ┌──▼────┐  ┌──▼───┐  ┌──▼────┐           │
│  │Agent │  │Codex │  │gemini │  │OAI   │  │crush │           │
│  │SDK   │  │SDK   │  │CLI    │  │compat│  │CLI   │           │
│  │(proc)│  │(proc)│  │(proc) │  │(HTTP)│  │(proc)│           │
│  └──────┘  └──────┘  └───────┘  └──────┘  └──────┘           │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                      DzipEventBus                          │  │
│  │  (unified events from all agents — 139+ event types)       │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 Adapter Interface

```typescript
interface AgentCLIAdapter {
  readonly providerId: string;                    // 'claude' | 'codex'

  // Core execution
  execute(input: AgentInput): AsyncGenerator<AgentEvent>;
  executeStreamed(input: AgentInput): AsyncGenerator<AgentStreamEvent>;

  // Session lifecycle
  resumeSession(sessionId: string): AsyncGenerator<AgentEvent>;
  listSessions?(): Promise<SessionInfo[]>;        // Claude only
  forkSession?(sessionId: string): Promise<string>; // Claude only

  // Control
  interrupt(): void;
  abort(signal: AbortSignal): void;

  // Health
  healthCheck(): Promise<HealthStatus>;

  // Configuration
  configure(opts: AdapterConfig): void;
}
```

### 4.3 Unified Event Mapping

Both SDKs emit different event types. The adapter normalizes them:

```typescript
// Claude SDK events → DzipEvent mapping
'assistant'          → 'agent:stream_delta'
'result'             → 'agent:completed' | 'agent:failed'
'system' (init)      → 'agent:started'
'stream_event'       → 'agent:stream_delta'
'tool_progress'      → 'tool:called' / 'tool:result'
'rate_limit'         → 'budget:warning'

// Codex SDK events → DzipEvent mapping
'thread.started'     → 'agent:started'
'turn.completed'     → 'agent:completed'
'turn.failed'        → 'agent:failed'
'item.completed'     → 'tool:result' (for CommandExecutionItem, FileChangeItem)
'item.started'       → 'tool:called'
'error'              → 'agent:failed'
```

### 4.4 Task Router Strategy

```typescript
interface TaskRoutingStrategy {
  route(task: TaskDescriptor): RoutingDecision;
}

// Example routing rules
const defaultStrategy: TaskRoutingStrategy = {
  route(task) {
    // Reasoning-heavy → Claude (stronger at analysis, planning)
    if (task.tags.includes('review') || task.tags.includes('architecture'))
      return { provider: 'claude', reason: 'reasoning-heavy task' };

    // Execution-heavy → Codex (full-auto sandbox mode)
    if (task.tags.includes('fix-tests') || task.tags.includes('implement'))
      return { provider: 'codex', reason: 'execution-heavy task' };

    // Cost-sensitive → whichever is cheaper for the model tier
    if (task.budgetConstraint === 'low')
      return { provider: cheaperProvider(task), reason: 'cost optimization' };

    // Default: use healthy provider with higher priority
    return { provider: 'auto', reason: 'priority-based with fallback' };
  }
};
```

---

## 5. Use Cases

### 5.1 Code Review Pipeline (Supervisor Pattern)

```
User request: "Review PR #42 for security, performance, and correctness"

DzipAgent Supervisor:
  ├── Claude Agent: security review (reasoning-heavy)
  ├── Codex Agent: run test suite, check for regressions (execution-heavy)
  └── Claude Agent: synthesize findings into PR comment
```

### 5.2 Bug Fix Race (Parallel + Best-of-N)

```
User request: "Fix the failing CI test in src/auth/login.test.ts"

DzipAgent Parallel:
  ├── Claude Agent: analyze + fix
  ├── Codex Agent: analyze + fix
  └── Judge Agent: compare both fixes, select the one that passes tests
```

### 5.3 Large Codebase Migration (Map-Reduce)

```
User request: "Migrate all React class components to hooks"

DzipAgent MapReduce:
  Map phase (parallel, chunked by directory):
    ├── Claude: src/components/auth/     (10 files)
    ├── Codex: src/components/dashboard/ (8 files)
    ├── Claude: src/components/settings/ (6 files)
    └── Codex: src/components/shared/    (12 files)
  Reduce phase:
    └── Claude: validate consistency, resolve cross-file imports
```

### 5.4 Failover Scenario (Circuit Breaker)

```
Normal operation:
  Task → Claude Agent (primary, priority=1)

Claude rate-limited (circuit opens):
  Task → Codex Agent (fallback, priority=2)

Claude recovers (circuit half-open → closed):
  Task → Claude Agent (primary restored)
```

### 5.5 Contract-Net Bidding

```
User request: "Optimize the database query in reports/monthly.sql"

DzipAgent Contract-Net:
  CFP broadcast → both agents
  Claude bids: { cost: 0.12, approach: "rewrite with CTEs", confidence: 0.9 }
  Codex bids:  { cost: 0.08, approach: "add indexes + EXPLAIN analysis", confidence: 0.7 }
  Award → Claude (higher confidence wins)
  Execute → Claude runs the optimization
```

### 5.6 System Prompt Optimization (PromptExperiment + PromptOptimizer)

```
Developer: "Our SQL generation prompt is producing inefficient queries"

DzipAgent PromptOptimizer:
  1. Load current prompt (PromptVersionStore v3)
  2. Run baseline eval: 50 test cases × 5 scorers → avg 0.72
  3. Analyze failures: 8 cases with queryEfficiency < 0.5
  4. Meta-model generates 3 candidate prompt rewrites
  5. Evaluate candidates:
     ├── Candidate A: avg 0.76 (+0.04)
     ├── Candidate B: avg 0.81 (+0.09) ✓
     └── Candidate C: avg 0.74 (+0.02)
  6. Statistical test: B vs baseline, p=0.008, significant
  7. Save v4, activate, report improvement
```

### 5.7 Domain-Aware Output Refinement

```
Agent generates SQL query → OutputRefinementLoop:
  1. Detect domain: SQL
  2. Score original: 0.65 (queryEfficiency: 0.4, injectionSafety: 0.9)
  3. Domain critique: "Subquery in WHERE can be rewritten as JOIN"
  4. Refine: rewrite with JOIN
  5. Score refined: 0.82 (+0.17, accepted)
  6. Verify no regression on other criteria
  7. Return refined query
```

---

## 6. Implementation Roadmap

### Phase 1: Adapter Layer (Foundation) — IMPLEMENTED
- [x] `@dzipagent/agent-adapters` package scaffolded
- [x] `AgentCLIAdapter` interface and unified `AgentEvent` types
- [x] `ClaudeAgentAdapter` — wraps `@anthropic-ai/claude-agent-sdk` `query()`
- [x] `CodexAdapter` — wraps `@openai/codex-sdk` `Codex`/`Thread`
- [x] `GeminiCLIAdapter` — wraps `gemini` CLI via `child_process`
- [x] `QwenAdapter` — OpenAI-compatible API wrapper (stub, expandable)
- [x] `CrushAdapter` — local model runner CLI wrapper (stub, expandable)
- [x] `AdapterRegistry` with circuit breaker per adapter
- [x] `TaskRouter` with pluggable strategies (tag-based, cost-optimized, round-robin, composite)
- [x] Gemini (`google`) and Qwen (`qwen`) added to core `ModelRegistry` provider types
- [x] Adapter error codes added to `ForgeErrorCode` union

### Phase 2: Routing & Fallback — IMPLEMENTED
- [x] Circuit breaker per adapter (reuses existing `CircuitBreaker` from core)
- [x] `TaskRouter` with 4 built-in strategies
- [x] `executeWithFallback()` with automatic fallback chain
- [x] `CostTrackingMiddleware` for cost tracking across all providers
- [x] `EventBusBridge` — adapter events → DzipEventBus

### Phase 3: Orchestration Patterns — IMPLEMENTED
- [x] `SupervisorOrchestrator` with multi-agent specialists (Claude + Codex + Gemini)
- [x] `ParallelExecutor` with result merging (first-wins, all, best-of-n)
- [x] `MapReduceOrchestrator` across agents with `LineChunker` and `DirectoryChunker`
- [x] `ContractNetOrchestrator` with `StaticBidStrategy` (FIPA Contract-Net protocol)

### Phase 4: Session & State Management — IMPLEMENTED
- [x] `SessionRegistry` (maps workflow IDs → Claude session IDs + Codex thread IDs)
- [x] Multi-turn conversation across agent switches via `executeMultiTurn()`
- [x] `WorkflowCheckpointer` with `InMemoryCheckpointStore` for checkpoint/resume
- [x] Session migration between providers via `switchProvider()` + `buildContextForHandoff()`

### Phase 5: Advanced Features — IMPLEMENTED
- [x] `MCPToolSharingBridge` — expose DzipAgent tools to all agents via MCP (Claude in-process, Codex dynamicTools, CLI systemPrompt)
- [x] Competitive execution (`ParallelExecutor.race()` — run Claude + Codex, take best result)
- [x] `ABTestRunner` with `LengthScorer`, `ExactMatchScorer`, `ContainsKeywordsScorer` + Welch's t-test
- [x] `CostOptimizationEngine` (adaptive routing with quality tracking, Jaccard similarity, exponential decay)
- [x] `CapabilityRouter` — provider-specific routing (Gemini for long-context, Qwen for multilingual, Crush for offline)

### Phase 6: Developer Experience (Bonus) — IMPLEMENTED
- [x] `createAdapterPlugin()` — DzipPlugin-compatible factory that auto-wires registry, event bridge, cost tracking, and session management
- [x] `OrchestratorFacade` + `createOrchestrator()` — high-level API: `run()`, `supervisor()`, `parallel()`, `race()`, `mapReduce()`, `bid()`, `chat()`

### Phase 7: Production Readiness — IMPLEMENTED
- [x] `AdapterGuardrails` + `AdapterStuckDetector` — stuck detection (repeated calls, error rate, idle), iteration/token/cost/duration budgets, blocked tools, output filtering
- [x] `AdapterWorkflowBuilder` + `defineWorkflow()` — declarative workflow DSL with sequential steps, parallel fan-out, branching, transforms, retries, and template resolution
- [x] `AgentIntegrationBridge` + `AdapterAsToolWrapper` — expose adapters as MCP-compatible tools, auto-routing composite tool, tool schema generation
- [x] `StreamingHandler` — transform adapter events to SSE/JSONL/NDJSON for real-time UIs, progress tracking, ReadableStream support

### Phase 8: Enterprise Features — IMPLEMENTED
- [x] `AdapterTracer` — distributed tracing with W3C traceparent propagation, child spans for tool calls, usage attribute tracking
- [x] `AdapterApprovalGate` — human-in-the-loop approval (auto/required/conditional modes), cost-based auto-approval, webhook notifications, timeout handling
- [x] `AdapterRecoveryCopilot` + `ExecutionTraceCapture` — recovery strategies (retry-different, increase-budget, escalate-human), execution trace capture for post-mortem
- [x] `AdapterHttpHandler` — framework-agnostic HTTP handler (POST /run, /supervisor, /parallel, /bid, GET /health, /cost), SSE streaming, API key auth, approval endpoints

### Phase 9: Production Deployment — IMPLEMENTED
- [x] `FileCheckpointStore` — file-system persistent CheckpointStore for durable workflow state across restarts
- [x] `RunManager` — run lifecycle tracking (pending/executing/completed/failed/cancelled), stats aggregation, auto-tracking via `trackRun()` wrapper
- [x] `ContextAwareRouter` — context-load estimation + routing to providers with sufficient context windows (safety margin, token estimation)
- [x] `ContextInjectionMiddleware` — priority-based context injection (required/optional chunks, prepend/system positioning, budget-aware trimming)
- [x] `AdapterLearningLoop` + `ExecutionAnalyzer` — execution recording, provider profiling (specialties/weaknesses/trends), failure pattern detection, recovery suggestions, performance reports
- [x] `StructuredOutputAdapter` + `JsonOutputSchema` + `RegexOutputSchema` — schema-validated output with retry-on-parse-failure, markdown JSON extraction, provider fallback

---

## 7. Improvements to the Original Document (cc_lg.md)

The original `cc_lg.md` research document is thorough but has several areas for improvement:

### 7.1 Factual Updates Needed

1. **SDK Package Name** — The document references `@anthropic-ai/claude-code` which is now deprecated. The current package is `@anthropic-ai/claude-agent-sdk`. The API examples (`ClaudeCodeSDK`, `session.chat()`) do not match the real API (`query()` async generator pattern).

2. **Codex SDK API** — The document's `Codex` example (`new Codex()`, `codex.startThread()`, `thread.run()`) is close to correct but the import should be `@openai/codex-sdk` and the constructor options differ from what's shown.

3. **Claude SDK API Example** (lines 84-92) — The `ClaudeCodeSDK` class and `session.chat()` pattern shown in the document do not exist. The real API is:
   ```typescript
   import { query } from '@anthropic-ai/claude-agent-sdk';
   const conversation = query({ prompt: 'Review this codebase', options: { ... } });
   for await (const message of conversation) { /* handle */ }
   ```

### 7.2 Missing Analysis

1. **Subprocess Architecture** — Both SDKs spawn CLI subprocesses, which is the single most important architectural detail for orchestration decisions. The document mentions this for Codex SDK but doesn't emphasize its implications for session management, resource usage, and orchestration design.

2. **No comparison of event/streaming models** — Claude has 20+ message types; Codex has 8 event types. This asymmetry matters for building a unified orchestrator.

3. **Session management asymmetry** — Claude has rich session APIs (list, fork, tag, rename); Codex has only `resumeThread()`. The document treats them as roughly equivalent.

4. **Missing: orchestrator pattern** — The document frames the choice as "CLI vs SDK" binary. It misses the third option: use an orchestration framework (like DzipAgent) that wraps both SDKs and adds cross-cutting concerns.

### 7.3 Structural Improvements

1. **Remove duplicate comparison table** — The same table appears twice (lines 262-276 and 334-347).
2. **Add concrete code for the hybrid approach** — Section mentions hybrid but provides no implementation guidance.
3. **Add cost comparison** — Neither SDK section discusses pricing/cost differences between Claude and Codex models.
4. **Add latency benchmarks** — The document discusses performance theoretically but provides no measured data.

---

## 8. Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|------------|
| SDK API instability (Codex is v0.x) | Breaking changes in adapter layer | Pin SDK versions; adapter abstraction isolates changes |
| CLI subprocess overhead at scale | High memory/CPU with many parallel agents | Limit concurrency; reuse sessions; pool processes |
| Session state is local file-based | Can't distribute across workers | Build session proxy or use shared filesystem |
| Cost overruns with parallel execution | 2x+ API costs when racing agents | Budget middleware; configurable max concurrent |
| Model capability drift | Routing rules become stale | A/B testing; periodic re-evaluation of routing heuristics |
| Claude SDK package rename | Import breakage | Already use new name; add migration note |

---

## 9. Conclusion

DzipAgent provides genuine, significant value as an orchestrator between Claude Code and Codex CLI:

1. **The architecture already exists** — Supervisor, contract-net, map-reduce, circuit breaker, event bus, and plugin system are built and tested. The gap is adapter code, not infrastructure.

2. **The SDKs are structurally similar** — Both spawn CLI subprocesses and emit JSONL events. A thin adapter layer can normalize them into DzipAgent's existing `AgentCLIAdapter` pattern (proven with `GitExecutor`).

3. **The value compounds** — Cross-agent routing, unified cost tracking, competitive execution, and provider failover are capabilities neither SDK can offer alone. These become increasingly valuable as organizations scale their AI-assisted development workflows.

4. **Low implementation risk** — Phase 1 (adapters) is ~2-3 days of work. Each subsequent phase is independently valuable and can ship incrementally.

**Recommendation:** Phase 1 is now implemented with 5 adapters (Claude, Codex, Gemini, Qwen, Crush), a registry with circuit breaker, and a task router with 4 strategies. Next step: integration testing with a supervisor workflow that delegates code review to Claude, test execution to Codex, and long-context analysis to Gemini.

---

## References

- [Claude Agent SDK (TypeScript)](https://github.com/anthropics/claude-agent-sdk-typescript) — `@anthropic-ai/claude-agent-sdk`
- [OpenAI Codex SDK (TypeScript)](https://github.com/openai/codex/tree/main/sdk/typescript) — `@openai/codex-sdk`
- [Claude Code Docs](https://code.claude.com/docs/en/sdk)
- [Codex CLI Docs](https://developers.openai.com/codex)
- [DzipAgent Framework](./../../dzipagent/) — `@dzipagent/agent`, `@dzipagent/core`
