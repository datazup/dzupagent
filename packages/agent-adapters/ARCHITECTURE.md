# @dzupagent/agent-adapters Architecture

This document describes the current implementation of `@dzupagent/agent-adapters` in `packages/agent-adapters`.

Scope:
- Architecture and module boundaries
- Per-adapter deep dive: invocation, prompt handling, event mapping, gaps
- Feature inventory with implementation behavior
- Memory/context/prompt integration opportunities
- Practical usage patterns
- Current caveats and operational guidance

Context snapshot: analyzed from source as of April 2026.

---

## 1. Purpose and Design Goals

`@dzupagent/agent-adapters` is a provider-agnostic orchestration layer around multiple AI agent runtimes (SDK and CLI-based). It standardizes:

- A single adapter contract (`AgentCLIAdapter`)
- A single event protocol (`AgentEvent` stream)
- Routing and fallback across providers
- Higher-level orchestration patterns (parallel, supervisor, map-reduce, contract-net)
- Governance and operations (cost tracking, guardrails, approvals, recovery, tracing, HTTP exposure)

Core principle: all provider integrations must look the same to orchestration code.

---

## 2. High-Level Architecture

```text
Application / Service
  |
  | uses
  v
OrchestratorFacade (optional convenience facade)
  |
  +-- AdapterRegistry (routing + health + circuit-breaker + fallback)
  |     |
  |     +-- Router Strategy (tag/cost/round-robin/capability/context/learning/...)
  |     +-- Adapters (claude/codex/gemini/qwen/crush/goose/openrouter)
  |
  +-- EventBusBridge (adapter events -> DzupEventBus)
  +-- CostTrackingMiddleware (optional)
  +-- SessionRegistry (chat/multi-turn)
  +-- Pattern Orchestrators
  |     +-- ParallelExecutor
  |     +-- SupervisorOrchestrator
  |     +-- MapReduceOrchestrator
  |     +-- ContractNetOrchestrator
  |
  +-- Optional control plane components
        +-- AdapterGuardrails
        +-- AdapterApprovalGate
        +-- AdapterRecoveryCopilot
        +-- AdapterTracer / StreamingHandler
        +-- WorkflowCheckpointer / FileCheckpointStore / RunManager
        +-- AdapterHttpHandler
        +-- Plugin + MCP bridges
```

---

## 3. Core Contracts

### 3.1 Adapter Interface

Contract lives in `@dzupagent/adapter-types` and is re-exported by this package.

Key interface: `AgentCLIAdapter`
- `execute(input)` -> `AsyncGenerator<AgentEvent>`
- `resumeSession(sessionId, input)`
- `interrupt()`
- `healthCheck()`
- `configure(opts)`
- `getCapabilities()`
- optional: `listSessions()`, `forkSession()`, `warmup()`

### 3.2 Unified Event Model

All adapters normalize into `AgentEvent` variants:
- `adapter:started`
- `adapter:message`
- `adapter:tool_call`
- `adapter:tool_result`
- `adapter:stream_delta`
- `adapter:completed`
- `adapter:failed`
- `adapter:progress`
- `recovery:cancelled`

This is the backbone for middleware, streaming, tracing, and orchestration.

### 3.3 AgentInput Fields

```typescript
interface AgentInput {
  prompt: string
  systemPrompt?: string        // see section 4 for per-adapter semantics
  resumeSessionId?: string
  maxTurns?: number
  maxBudgetUsd?: number
  workingDirectory?: string
  signal?: AbortSignal
  options?: Record<string, unknown>
  correlationId?: string
}
```

### 3.4 Task and Routing Contracts

`TaskDescriptor` carries routing metadata:
- `prompt`, `tags`
- `preferredProvider`
- `requiresReasoning`, `requiresExecution`
- budget hints and working directory metadata

Routers implement `TaskRoutingStrategy.route(task, availableProviders)` and return:
- selected provider (`provider`)
- routing reason
- confidence
- ordered fallback providers

---

## 4. Per-Adapter Deep Dive

### 4.1 Claude (`ClaudeAgentAdapter`)

**File:** `src/claude/claude-adapter.ts`

**Invocation:** SDK-based via `@anthropic-ai/claude-agent-sdk`. The SDK spawns the `claude` CLI binary as a child process and streams JSONL back.

**Prompt handling:**
- `prompt` → passed as the main query string to `query()`
- `systemPrompt` → passed as `options.systemPrompt`

> **Critical detail:** The Claude Agent SDK `systemPrompt` option accepts two forms:
> - **Plain string** — *replaces* the entire Claude Code system prompt. Claude loses its tool definitions, CLAUDE.md awareness, memory, git context, permission rules. This makes Claude behave as a vanilla LLM, not as a coding agent.
> - **Preset object** — keeps the Claude Code system prompt and appends/decorates it:
>   ```typescript
>   { type: 'preset', preset: 'claude_code', append: 'Always explain reasoning.' }
>   ```
>
> Our adapter currently passes systemPrompt as a **plain string**, which fully replaces the Claude Code system prompt. This is almost always the wrong behavior for agentic use — callers typically want `append` semantics, not replacement. **This is a known gap** (see Section 10.1).

**Event mapping:**
| SDK message type | AgentEvent emitted |
|---|---|
| `system` | `adapter:started` (captures sessionId, model) |
| `assistant` | `adapter:message` (text extracted from content blocks) |
| `tool_progress` (started) | `adapter:tool_call` |
| `tool_progress` (completed/failed) | `adapter:tool_result` |
| `stream_event` | `adapter:stream_delta` |
| `result` (success) | `adapter:completed` |
| `result` (failure) | `adapter:failed` |

**Capabilities:** Resume ✓, Fork ✓, Streaming ✓, Tool Calls ✓, Cost Usage ✓, `listSessions` ✓, `forkSession` ✓, `warmup` ✓

**Silently drops:** Unknown message types, unknown content block types

**Gaps:**
- systemPrompt replacement vs append (see above)
- Permission mode mapping is basic: `sandbox` modes map to `'default'` or `'bypassPermissions'`
- Cached token usage not extracted

---

### 4.2 Codex (`CodexAdapter`)

**File:** `src/codex/codex-adapter.ts`

**Invocation:** SDK-based via `@openai/codex-sdk`. The SDK is itself a thin launcher that spawns the platform-specific Codex CLI binary (`@openai/codex-linux-x64` etc.) as a child process, writes the prompt to `stdin`, and reads JSONL `ThreadEvent` lines from `stdout`. There is no "pure API" path — the binary is always what executes.

**Prompt handling:**
- `prompt` → passed as string to `thread.runStreamed(input.prompt, { signal })`
- `systemPrompt` → passed via `CodexOptions.config.instructions` CLI config key, which maps to `--config instructions="..."` on the binary. The `config` field is a key-value map flattened into CLI flags. This is additive — it layers on top of Codex's built-in system behavior rather than replacing it (unlike Claude).

Priority chain for systemPrompt:
1. `input.systemPrompt` (per-request, highest priority)
2. `config.providerOptions.systemPrompt` (static adapter-level default)
3. Nothing — no instructions flag sent

**SDK interface note:** The adapter declares its own internal TypeScript interfaces for SDK types. These were previously wrong and caused silent empty output. As of the April 2026 fix, they now match the real SDK:
- `AgentMessageItem.text` (not `.content`)
- `CommandExecutionItem.aggregated_output` (not `.output`)
- `FileChangeItem.changes[{path, kind}]` (not `.filePath`/`.diff`/`.action`)
- `McpToolCallItem.tool` + `.server` + `.arguments` (not `.toolName`/`.input`)
- No `finalResponse` field on `StreamedTurn` (removed dead code path)
- `TurnFailedEvent.error` is `{message: string}` object (not a plain string)
- Sandbox mode `full-access` maps to `danger-full-access` (not `full-access`)

**Event mapping:**
| SDK event | AgentEvent emitted |
|---|---|
| `thread.started` | `adapter:started` |
| `item.completed` → `agent_message` | `adapter:message` (uses `.text`) |
| `item.completed` → `command_execution` | `adapter:tool_call` + `adapter:tool_result` (uses `.aggregated_output`) |
| `item.completed` → `file_change` | `adapter:tool_result` (summarizes `.changes[]` array as `kind: path` lines) |
| `item.completed` → `mcp_tool_call` | `adapter:tool_call` + `adapter:tool_result` (toolName = `server/tool`) |
| `item.completed` → `reasoning` | `adapter:message` (uses `.text`) |
| `item.completed` → `web_search` | `adapter:tool_call` only (SDK has no results field on WebSearchItem) |
| `item.completed` → `error` | `adapter:failed` |
| `turn.completed` | usage extracted only, no event emitted |
| `turn.failed` | `adapter:failed` (error from `.error.message`) |
| (after stream ends) | `adapter:completed` (with accumulated finalResponse) |

**Capabilities:** Resume ✓, Fork ✗, Streaming ✓, Tool Calls ✓, Cost Usage ✓, `warmup` ✓

**Silently drops:** `todo_list` items, `item.started`, `turn.started`, unknown item types

**Gaps:**
- `web_search` only emits `tool_call`, never `tool_result` — web search results are invisible to callers
- No `developer_instructions` support (the Codex CLI also has this config key for a separate developer-level system prompt)
- No per-thread `systemPrompt` for `resumeSession` — resume uses the same instance config

---

### 4.3 Gemini CLI (`GeminiCLIAdapter`)

**File:** `src/gemini/gemini-adapter.ts`

**Invocation:** CLI-based via `gemini` binary with JSONL output. Extends `BaseCliAdapter`.

**Prompt handling:**
- `prompt` → `-p` flag
- `systemPrompt` → `--system-prompt` flag (additive — layers on top of Gemini's system behavior)

**Sandbox mode mapping:**
| AdapterConfig | Gemini CLI flag |
|---|---|
| `read-only` | `--sandbox sandbox` |
| `workspace-write` | `--sandbox workspace` |
| `full-access` | `--sandbox none` |

**Event mapping:** Via `mapGeminiEvent()` helper with field aliasing.

**Capabilities:** Resume ✓, Fork ✗, Streaming ✓, Tool Calls ✓, Cost Usage ✓

**Note:** Uses provider ID `gemini` — conflicts with `GeminiSDKAdapter`. Only one can be registered at a time.

---

### 4.4 Gemini SDK (`GeminiSDKAdapter`)

**File:** `src/gemini/gemini-sdk-adapter.ts`

**Invocation:** SDK-based via `@google/generative-ai`. Pure API call — no binary spawn.

**Prompt handling:**
- `prompt` → passed to `generateContentStream()`
- `systemPrompt` → `systemInstruction` field in model config

**Gaps:**
- No session persistence — generates a random UUID per execution
- `resumeSession()` throws (not supported)
- Uses provider ID `gemini` — conflicts with `GeminiCLIAdapter`

**Capabilities:** Resume ✗, Fork ✗, Streaming ✓, Tool Calls ✓, Cost Usage ✓, `warmup` ✓

---

### 4.5 Crush (`CrushAdapter`)

**File:** `src/crush/crush-adapter.ts`

**Invocation:** CLI-based via `crush` binary with JSONL output. Extends `BaseCliAdapter`.

**Prompt handling:**
- `prompt` → `--prompt` flag
- `systemPrompt` → `--system` flag

**Provider options:** `quantization`, `gpuLayers`, `contextSize` for local model configuration.

**Capabilities:** Resume ✗, Fork ✗, Streaming ✓, Tool Calls ✓, Cost Usage ✗ (local model)

---

### 4.6 Goose (`GooseAdapter`)

**File:** `src/goose/goose-adapter.ts`

**Invocation:** CLI-based via `goose run --headless` with JSONL output. Extends `BaseCliAdapter`.

**Prompt handling:**
- `prompt` → positional `--prompt` flag
- `systemPrompt` → `--system` flag

**Special:** Supports `options.recipe` for Goose recipe files.

**Capabilities:** Resume ✓, Fork ✗, Streaming ✓, Tool Calls ✓, Cost Usage ✗ (local/custom)

---

### 4.7 Qwen (`QwenAdapter`)

**File:** `src/qwen/qwen-adapter.ts`

**Invocation:** CLI-based via `qwen` binary pointing to DashScope endpoint. Extends `BaseCliAdapter`.

**Prompt handling:**
- `prompt` → `--prompt` flag
- `systemPrompt` → `--system` flag

**Environment:** Injects `DASHSCOPE_API_KEY` from `config.apiKey`.

**Capabilities:** Resume ✓, Fork ✗, Streaming ✓, Tool Calls ✓, Cost Usage ✗

---

### 4.8 OpenRouter (`OpenRouterAdapter`)

**File:** `src/openrouter/openrouter-adapter.ts`

**Invocation:** HTTP API via native `fetch` — no SDK, no binary spawn.

**Prompt handling:**
- `prompt` → `{ role: 'user', content: prompt }` in messages array
- `systemPrompt` → `{ role: 'system', content: systemPrompt }` prepended to messages array

**Streaming:** SSE stream parsed via custom `parseSSE()` generator.

**Default model:** `anthropic/claude-sonnet-4-5-20250514`

**Capabilities:** Resume ✗, Fork ✗, Streaming ✓, Tool Calls ✓, Cost Usage ✓

**Gaps:** No session persistence, `resumeSession()` throws.

---

### 4.9 BaseCliAdapter

**File:** `src/base/base-cli-adapter.ts`

Abstract base class for all CLI-backed adapters. Provides:
- `spawnAndStreamJsonl()` — spawns child process, reads JSONL from stdout
- `filterSensitiveEnvVars()` — strips sensitive keys from child process env
- Automatic `adapter:started` on first event
- Synthesizes `adapter:completed` if stream ends without terminal event
- AbortController composition (caller signal + internal)
- Binary availability check via `assertReady()`

Template methods subclasses must implement:
- `getBinaryName()` — binary to spawn
- `buildArgs(input)` — CLI arguments
- `mapProviderEvent(record, sessionId)` — JSONL record → AgentEvent

---

### 4.10 Capability Matrix

| Provider | Resume | Fork | Streaming | Tool Calls | Cost | `systemPrompt` semantics |
|---|:---:|:---:|:---:|:---:|:---:|---|
| claude | ✓ | ✓ | ✓ | ✓ | ✓ | **Replaces** Claude Code system prompt (gap — should append) |
| codex | ✓ | ✗ | ✓ | ✓ | ✓ | Additive via `--config instructions` |
| gemini CLI | ✓ | ✗ | ✓ | ✓ | ✓ | Additive via `--system-prompt` |
| gemini SDK | ✗ | ✗ | ✓ | ✓ | ✓ | Additive via `systemInstruction` |
| qwen | ✓ | ✗ | ✓ | ✓ | ✗ | Additive via `--system` |
| crush | ✗ | ✗ | ✓ | ✓ | ✗ | Additive via `--system` |
| goose | ✓ | ✗ | ✓ | ✓ | ✗ | Additive via `--system` |
| openrouter | ✗ | ✗ | ✓ | ✓ | ✓ | Standard `system` role message |

---

## 5. Runtime Execution Flow

Typical `registry.executeWithFallback(input, task)` flow:

1. Resolve currently healthy/enabled providers.
2. Ask router for primary decision + fallback chain.
3. Build ordered provider list: primary → declared fallbacks → remaining healthy.
4. Execute provider stream.
5. Success is considered valid only when `adapter:completed` is observed.
6. On failure (or missing completion), record failure/circuit state and try next provider.
7. Throw `ALL_ADAPTERS_EXHAUSTED` when all options fail.

Important behavior:
- If a provider stream ends without `adapter:completed`, registry treats it as failure and can synthesize `adapter:failed`.
- Circuit breakers from `@dzupagent/core` are integrated per provider.

---

## 6. Feature Inventory by Subsystem

### 6.1 Adapter Registry and Health

`AdapterRegistry` provides:
- registration/unregistration
- enable/disable by provider
- router strategy injection
- fallback execution
- circuit breaker integration
- health status (`getHealthStatus`) and detailed health (`getDetailedHealth`)
- global warmup (`warmupAll`)

It emits lifecycle and provider reliability events to `DzupEventBus` when configured.

### 6.2 Routing Strategies

Available strategies:
- `TagBasedRouter`
- `CostOptimizedRouter` (static rank)
- `RoundRobinRouter`
- `CompositeRouter`
- `CapabilityRouter` (capability matrix scoring)
- `ContextAwareRouter` (context-window fit)
- `LearningRouter` (history-based scoring)
- `CostOptimizationEngine` (adaptive cost-quality routing)

Context routing helpers:
- `ContextInjectionMiddleware` — inject prioritized context chunks under token budgets.

Default context window assumptions in `ContextAwareRouter`:
- claude: 200k, codex: 128k, gemini: 1M, qwen: 128k, crush: 32k, goose: 128k, openrouter: 200k

### 6.3 Orchestration Patterns

`OrchestratorFacade` (optional high-level API) wires registry, event bridge, cost tracking, sessions.

Facade methods:
- `run(prompt, options)`
- `chat(prompt, options)`
- `parallel(prompt, options)`
- `race(prompt, providers?)`
- `supervisor(goal, options)`
- `mapReduce(input, options)`
- `bid(prompt, options)`
- `getCostReport()`
- `shutdown()`

Lower-level orchestrators:
- `ParallelExecutor`: `first-wins`, `all`, `best-of-n`
- `SupervisorOrchestrator`: decomposition + dependency-aware delegation
- `MapReduceOrchestrator`: chunk/map/reduce with bounded concurrency
- `ContractNetOrchestrator`: bid/score/award/fallback

### 6.4 Workflow DSL

`AdapterWorkflowBuilder` and `defineWorkflow()` compile declarative flows into `PipelineRuntime` (`@dzupagent/agent`).

Supported nodes:
- `step(...)`
- `parallel([...], mergeStrategy)`
- `branch(condition, branches)`
- `transform(id, fn)`
- `loop(config)`

Workflow features:
- templating (`{{prev}}`, `{{state.key}}`)
- per-step routing tags and preferred provider
- retries and step timeout
- skip conditions
- event callbacks (`workflow:*`, `step:*`, `parallel:*`, `branch:*`)
- validation via `WorkflowValidator`

### 6.5 State, Sessions, and Persistence

State/session modules:
- `SessionRegistry`: workflow-oriented multi-turn conversation and provider session mapping
- `WorkflowCheckpointer`: checkpoint/resume for long-running workflows
- `InMemoryCheckpointStore` and `FileCheckpointStore`
- `RunManager`: run lifecycle tracking, stats, pruning, stream-wrapping

### 6.6 Middleware and Safety Controls

Middleware foundation:
- `MiddlewarePipeline`
- `createCostTrackingMiddleware(...)`
- `createGuardrailsMiddleware(...)`
- `createTracingMiddleware(...)`

Safety/governance modules:
- `AdapterGuardrails`: iteration/token/cost/duration limits, blocked tools, stuck detection, output filtering
- `AdapterApprovalGate`: `auto` / `required` / `conditional` with timeout, webhook notify, audit store
- `AdapterRecoveryCopilot`: multi-strategy recovery with trace capture, backoff/jitter, escalation handling

### 6.7 Structured Output and Streaming

Structured output:
- `StructuredOutputAdapter`
- `JsonOutputSchema<T>` (with Zod validation and markdown JSON extraction)
- `RegexOutputSchema`
- Retry loop with correction prompt on parse failure (up to `maxRetries`, default 2)

Streaming/transport:
- `StreamingHandler` supports `sse`, `jsonl`, `ndjson`
- produces UI-friendly events (`status`, `content`, `tool_call`, `progress`, `done`, `error`)

### 6.8 Observability and Cost Ops

Observability:
- `EventBusBridge`
- `AdapterTracer` span model with optional context propagation
- `tracing-middleware` (per-tool span tracking, usage attributes)

Cost ops:
- `CostTrackingMiddleware`
- `CostModelRegistry`
- `CostOptimizationEngine` (adaptive routing based on success-rate/cost scoring)

### 6.9 Integration Surfaces

HTTP exposure via `AdapterHttpHandler` (framework-agnostic):
- `POST /run`
- `POST /supervisor`
- `POST /parallel`
- `POST /bid`
- `POST /approve/:id`
- `GET /health`
- `GET /health/detailed`
- `GET /cost`

Plugin and bridge modules:
- `createAdapterPlugin(...)`, `defineAdapterPlugin(...)`, `AdapterPluginLoader`
- `AgentIntegrationBridge`, `AdapterAsToolWrapper`
- `MCPToolSharingBridge`

Learning/evaluation:
- `AdapterLearningLoop`, `ExecutionAnalyzer`
- `ABTestRunner` + scorers (length, exact match, keyword, custom)

---

## 7. Memory, Context, and Prompt Integration

The adapter layer currently treats each request as stateless from a content perspective — it passes `prompt` and `systemPrompt` through directly, with no enrichment. The broader monorepo contains three packages that could make prompt construction dramatically richer.

### 7.1 Available Packages

#### `@dzupagent/memory`
- `MemoryService` — scoped namespaces with semantic search (vector store backed)
- `SemanticStoreAdapter` — pluggable vector store interface (Qdrant, Pinecone, etc.)
- `DecayConfig` — Ebbinghaus forgetting curve for relevance decay over time
- Key operations: `store()`, `recall(query, topK)`, `consolidate()`, `purge()`

#### `@dzupagent/context`
- `MessageManager` — compression, tool result pruning, orphan message repair
- `AutoCompress` / `ProgressiveCompress` — intelligent summarization under token budgets
- `PhaseAwareWindowManager` — conversation phase detection (discovery → exploration → exploitation)
- `SystemReminderInjector` — periodic context refreshes mid-session
- `ContextTransferService` — intent-aware context handoff between turns/providers
- `PromptCache` — Anthropic prompt caching prefix utilities

#### `@dzupagent/core`
- `CircuitBreaker` (already integrated into registry)
- `DzupEventBus` (already used throughout)
- `ForgeError` (already used in adapters)

### 7.2 Current Gaps in Prompt Construction

The following are not currently wired into the adapter layer:

| Gap | Impact |
|---|---|
| No memory retrieval before execution | Agents have no access to past successful approaches, user preferences, or domain knowledge accumulated over time |
| No conversation history compression | Long multi-turn sessions hit context limits and fail; no automatic summarization |
| No per-provider prompt format normalization | Each provider has different sensitivity to prompt phrasing; no adaptation layer |
| Claude systemPrompt replaces instead of appends | Agentic capabilities (tools, CLAUDE.md, memory) are silently removed when systemPrompt is passed |
| No context injection from retrieved memory | Even if memory exists, nothing pipes it into the prompt |
| No phase-aware prompt variation | Early turns (discovery) and late turns (exploitation) should use different prompt strategies |
| No cross-provider context handoff | When registry falls back to a different provider, the new provider gets only the original prompt with no context from what the failed provider already did |

### 7.3 Recommended Integration Points

#### A. Memory-Enriched Prompt Construction (Pre-Execution Middleware)

Create a `MemoryEnrichmentMiddleware` that runs before execution:

```typescript
// Before calling adapter.execute(input):
const memories = await memoryService.recall(input.prompt, { topK: 5, namespace: 'executions' })
const enrichedInput = {
  ...input,
  systemPrompt: buildSystemPromptWithMemory(input.systemPrompt, memories),
}
```

What to store in memory:
- Successful tool use patterns for this workspace/project
- User preferences (coding style, test framework, architecture decisions)
- Domain glossary (project-specific types, module names, conventions)
- Previous failures and their resolutions (avoid repeating mistakes)

#### B. Claude systemPrompt: Replace → Append

Fix the Claude adapter to use the preset append form by default:

```typescript
// Current (wrong for agentic use):
options['systemPrompt'] = input.systemPrompt

// Correct:
options['systemPrompt'] = {
  type: 'preset',
  preset: 'claude_code',
  append: input.systemPrompt,
}
```

Allow callers to opt into full replacement via `input.options.systemPromptMode = 'replace'`.

#### C. Cross-Provider Context Handoff

When `AdapterRecoveryCopilot` switches providers, it should pass the partial work context:

```typescript
// On fallback to a new provider, inject what the failed provider did:
const handoffContext = contextTransferService.buildHandoff({
  completedSteps: collectedEvents.filter(e => e.type === 'adapter:tool_result'),
  partialResponse: collectedEvents.filter(e => e.type === 'adapter:message'),
})
const enrichedInput = {
  ...input,
  systemPrompt: [input.systemPrompt, handoffContext].filter(Boolean).join('\n\n'),
}
```

#### D. Automatic Conversation Compression

Wire `MessageManager` into `SessionRegistry.getMultiTurnInput()`:

```typescript
// Before building next-turn input:
const compressed = await messageManager.compress(session.history, {
  targetTokens: providerContextWindow * 0.7,
  strategy: 'progressive',
})
```

This prevents long multi-turn sessions from failing at context limits.

#### E. Per-Provider Prompt Normalization

Different providers respond differently to prompt styles. A normalization layer:

```typescript
// In ContextAwareRouter or as middleware:
const normalizedPrompt = promptNormalizer.adapt(input.prompt, {
  targetProvider: selectedProvider,
  // e.g., codex prefers imperative commands, claude prefers natural language
})
```

#### F. Codex `developer_instructions`

The Codex CLI has a `developer_instructions` config key separate from `instructions`. This is for meta-level agent behavior overrides (how the agent reasons about its task), while `instructions` is the user-facing role/context. Expose this via `providerOptions.developerInstructions`:

```typescript
if (providerOpts['developerInstructions']) {
  ctorOpts.config = { ...ctorOpts.config, developer_instructions: providerOpts['developerInstructions'] }
}
```

### 7.4 Suggested New Modules

| Module | Location | Purpose |
|---|---|---|
| `PromptEnrichmentPipeline` | `src/prompts/prompt-enrichment.ts` | Composable enrichment: memory recall → context compress → normalize → inject |
| `MemoryEnrichmentMiddleware` | `src/middleware/memory-enrichment.ts` | Pre-execution middleware that retrieves and injects memory |
| `CrossProviderHandoff` | `src/recovery/cross-provider-handoff.ts` | Packages partial progress for fallback provider |
| `SystemPromptBuilder` | `src/prompts/system-prompt-builder.ts` | Provider-aware builder (replace vs append, prompt caching prefix) |
| `ConversationCompressor` | `src/session/conversation-compressor.ts` | Wraps `@dzupagent/context` MessageManager for session history |

---

## 8. How To Use

### 8.1 Minimal setup (Facade)

```ts
import { createEventBus } from '@dzupagent/core'
import {
  createOrchestrator,
  ClaudeAgentAdapter,
  CodexAdapter,
} from '@dzupagent/agent-adapters'

const orchestrator = createOrchestrator({
  adapters: [
    new ClaudeAgentAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }),
    new CodexAdapter({ apiKey: process.env.OPENAI_API_KEY }),
  ],
  eventBus: createEventBus(),
  enableCostTracking: true,
})

const result = await orchestrator.run('Review this patch for bugs', {
  tags: ['review', 'reasoning'],
})

console.log(result.providerId, result.result)
```

### 8.2 Direct Registry + Custom Router

```ts
import {
  AdapterRegistry,
  CapabilityRouter,
  ClaudeAgentAdapter,
  CodexAdapter,
} from '@dzupagent/agent-adapters'

const registry = new AdapterRegistry()
registry.register(new ClaudeAgentAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }))
registry.register(new CodexAdapter({ apiKey: process.env.OPENAI_API_KEY }))
registry.setRouter(new CapabilityRouter())

const task = {
  prompt: 'Implement failing tests and run fixes',
  tags: ['implement', 'test'],
  requiresExecution: true,
}

const input = { prompt: task.prompt }

for await (const event of registry.executeWithFallback(input, task)) {
  if (event.type === 'adapter:completed') {
    console.log(event.result)
  }
}
```

### 8.3 Workflow DSL

```ts
import {
  AdapterRegistry,
  ClaudeAgentAdapter,
  CodexAdapter,
  defineWorkflow,
} from '@dzupagent/agent-adapters'

const registry = new AdapterRegistry()
registry.register(new ClaudeAgentAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }))
registry.register(new CodexAdapter({ apiKey: process.env.OPENAI_API_KEY }))

const workflow = defineWorkflow({ id: 'pr-review-flow' })
  .step({ id: 'summary', prompt: 'Summarize:\n{{state.diff}}', tags: ['reasoning'] })
  .parallel([
    { id: 'security', prompt: 'Security review:\n{{prev}}', tags: ['security', 'reasoning'] },
    { id: 'perf', prompt: 'Performance review:\n{{prev}}', tags: ['performance'] },
  ])
  .transform('combine', (state) => ({
    ...state,
    combined: `Security:\n${String(state.security)}\n\nPerf:\n${String(state.perf)}`,
  }))
  .step({ id: 'final', prompt: 'Final report:\n{{state.combined}}', preferredProvider: 'claude' })
  .build()

const wfResult = await workflow.run(registry, {
  initialState: { diff: '...' },
  onEvent: (e) => console.log(e.type),
})

console.log(wfResult.success, wfResult.finalState)
```

### 8.4 Middleware Pipeline (Cost + Guardrails + Tracing)

```ts
import {
  MiddlewarePipeline,
  CostTrackingMiddleware,
  AdapterGuardrails,
  AdapterTracer,
  createCostTrackingMiddleware,
  createGuardrailsMiddleware,
  createTracingMiddleware,
} from '@dzupagent/agent-adapters'

const pipeline = new MiddlewarePipeline()
const cost = new CostTrackingMiddleware({ maxBudgetCents: 500 })
const guardrails = new AdapterGuardrails({ maxIterations: 20, maxDurationMs: 120_000 })
const tracer = new AdapterTracer({ serviceName: 'my-service' })

pipeline.use('trace', createTracingMiddleware(tracer))
pipeline.use('cost', createCostTrackingMiddleware(cost))
pipeline.use('guardrails', createGuardrailsMiddleware(guardrails))

// Wrap any adapter stream:
// const wrapped = pipeline.wrap(source, { input, providerId: 'claude' })
```

### 8.5 Approval Gate

```ts
import {
  AdapterApprovalGate,
  type ApprovalContext,
} from '@dzupagent/agent-adapters'

const gate = new AdapterApprovalGate({
  mode: 'conditional',
  timeoutMs: 60_000,
  condition: (ctx) => (ctx.estimatedCostCents ?? 0) > 100,
})

const context: ApprovalContext = {
  runId: 'run-123',
  description: 'Apply production migration',
  providerId: 'claude',
  estimatedCostCents: 180,
}

// for await (const event of gate.guard(context, adapter.execute(input))) { ... }
```

### 8.6 Recovery Copilot

```ts
import { AdapterRecoveryCopilot } from '@dzupagent/agent-adapters'

const recovery = new AdapterRecoveryCopilot(registry, {
  maxAttempts: 4,
  strategyOrder: ['retry-different-provider', 'increase-budget', 'escalate-human', 'abort'],
  backoffMs: 1000,
  backoffMultiplier: 2,
  backoffJitter: true,
})

const result = await recovery.executeWithRecovery(
  { prompt: 'Fix this flaky test suite', maxTurns: 6 },
  { prompt: 'Fix this flaky test suite', tags: ['fix-tests', 'code'], requiresExecution: true },
)

console.log(result)
```

### 8.7 Structured Output

```ts
import {
  StructuredOutputAdapter,
  JsonOutputSchema,
} from '@dzupagent/agent-adapters'

const structured = new StructuredOutputAdapter(registry, { maxRetries: 2 })

const planSchema = new JsonOutputSchema(
  'release-plan',
  (value) => {
    const v = value as { steps?: unknown; risk?: unknown }
    if (!Array.isArray(v.steps)) throw new Error('steps must be array')
    if (!['low', 'medium', 'high'].includes(String(v.risk))) throw new Error('invalid risk')
    return { steps: v.steps.map(String), risk: String(v.risk) as 'low' | 'medium' | 'high' }
  },
  'JSON object with fields: steps (string[]), risk (low|medium|high)',
)

const run = await structured.execute(
  { prompt: 'Return a deployment plan as strict JSON' },
  planSchema,
)

if (run.result.success) {
  console.log(run.result.value)
}
```

### 8.8 HTTP Handler Integration

```ts
import { AdapterHttpHandler, AdapterApprovalGate } from '@dzupagent/agent-adapters'

const gate = new AdapterApprovalGate({ mode: 'required' })

const http = new AdapterHttpHandler({
  orchestrator,
  approvalGate: {
    grant: async (id, approvedBy) => gate.grant(id, approvedBy),
    reject: async (id, reason) => gate.reject(id, reason),
  },
  tokenValidator: async (token) => ({ valid: token === process.env.API_TOKEN }),
  publicEndpoints: ['/health', '/health/detailed'],
  rateLimit: { windowMs: 60_000, maxRequests: 120 },
})

// Map your framework request -> HttpRequest and pass to http.handle(...)
```

### 8.9 Learning and Adaptive Routing

```ts
import {
  AdapterLearningLoop,
  LearningRouter,
  ExecutionAnalyzer,
} from '@dzupagent/agent-adapters'

const learning = new AdapterLearningLoop({ minSampleSize: 10 })
const router = new LearningRouter(learning)
registry.setRouter(router)

learning.record({
  providerId: 'codex',
  taskType: 'fix-tests',
  tags: ['test', 'code'],
  success: true,
  durationMs: 4200,
  inputTokens: 900,
  outputTokens: 700,
  costCents: 12,
  timestamp: Date.now(),
})

const report = new ExecutionAnalyzer(learning).generateReport()
console.log(report.recommendations)
```

---

## 9. HTTP API Contract Summary

Request validation is Zod-backed (`request-schemas.ts`), with framework-neutral transport types.

Primary endpoints:
- `POST /run`
  - body: prompt + optional tags/provider/system/workingDir/maxTurns
  - supports streaming (`stream: true`)
- `POST /supervisor`
- `POST /parallel` (`strategy`: `first-wins` | `all` | `best-of-n`)
- `POST /bid`
- `POST /approve/:requestId`
- `GET /health`
- `GET /health/detailed`
- `GET /cost`

Auth options:
- simple API key validator (`validateApiKey`)
- token validator (`tokenValidator`) with richer identity/scope model

Other transport features:
- correlation ID extraction (`x-correlation-id`, `x-request-id`, `traceparent`)
- optional rate limiting (`SlidingWindowRateLimiter`)

---

## 10. Current Gaps and Known Issues

### 10.1 Claude systemPrompt replaces instead of appends (HIGH)

Passing `input.systemPrompt` to `ClaudeAgentAdapter` sends it as a plain string to the SDK, which **fully replaces** Claude Code's built-in system prompt. This strips Claude of its tool definitions, CLAUDE.md awareness, git context, memory, and permission rules — making it behave as a vanilla LLM rather than a coding agent.

**Fix:** Use the preset append form by default:
```typescript
options['systemPrompt'] = {
  type: 'preset',
  preset: 'claude_code',
  append: input.systemPrompt,
}
```
Expose `input.options.systemPromptMode = 'replace'` for callers who genuinely want full replacement.

### 10.2 Codex web_search has no tool_result (MEDIUM)

`web_search` items only emit `adapter:tool_call`. The SDK's `WebSearchItem` has no results field, so search results are invisible to callers and cannot be used downstream.

**Fix:** Codex web search results likely appear as a subsequent `agent_message`. Wire them together or document the limitation explicitly.

### 10.3 No memory integration (MEDIUM)

No adapter enriches prompts with recalled memory. Each execution is stateless from the memory perspective even when `@dzupagent/memory` is available.

**Fix:** Implement `MemoryEnrichmentMiddleware` as described in Section 7.3.A.

### 10.4 No cross-provider context handoff on fallback (MEDIUM)

When `AdapterRecoveryCopilot` switches to a fallback provider, the new provider receives only the original bare prompt with no knowledge of what the failed provider already accomplished.

**Fix:** Implement `CrossProviderHandoff` as described in Section 7.3.C.

### 10.5 Codex `developer_instructions` not exposed (LOW)

The Codex CLI supports a `developer_instructions` config key (separate from `instructions`) for meta-level agent behavior. Our adapter only exposes `instructions`.

### 10.6 Gemini provider ID conflict (LOW)

Both `GeminiCLIAdapter` and `GeminiSDKAdapter` use provider ID `gemini`. Registering both overwrites the first. The SDK adapter should use `gemini-sdk`.

### 10.7 No session compression for long multi-turn sessions (LOW)

`SessionRegistry.getMultiTurnInput()` returns raw history without compression. Long sessions will eventually exceed provider context windows and fail silently.

**Fix:** Wire `@dzupagent/context` `MessageManager` into `getMultiTurnInput()`.

### 10.8 Recovery `retry-different-provider` may not change provider (LOW)

Mutating `input.options.preferredProvider` may not be respected if the router uses `TaskDescriptor` tags for primary routing logic. The fallback could re-select the same provider.

---

## 11. Recommended Integration Order

For production-grade usage, a practical rollout sequence:

1. Start with `OrchestratorFacade` + 2 providers + `TagBasedRouter`.
2. Enable `CostTrackingMiddleware` and `/health` + `/cost` endpoints.
3. Add `AdapterGuardrails` and `AdapterApprovalGate` for risky operations.
4. Add `AdapterRecoveryCopilot` and tracing (`AdapterTracer`).
5. Introduce workflow DSL for complex, repeatable flows.
6. Add learning/cost optimization routers once you have enough execution history.
7. Integrate `@dzupagent/memory` + `@dzupagent/context` for prompt enrichment (Section 7.3).

---

## 12. Source Map (Primary Files)

Core entrypoints:
- `src/index.ts`
- `src/types.ts` (re-export from `@dzupagent/adapter-types`)

Adapters:
- `src/claude/claude-adapter.ts`
- `src/codex/codex-adapter.ts`
- `src/gemini/gemini-adapter.ts`
- `src/gemini/gemini-sdk-adapter.ts`
- `src/qwen/qwen-adapter.ts`
- `src/crush/crush-adapter.ts`
- `src/goose/goose-adapter.ts`
- `src/openrouter/openrouter-adapter.ts`
- `src/base/base-cli-adapter.ts`

Routing/registry:
- `src/registry/adapter-registry.ts`
- `src/registry/task-router.ts`
- `src/registry/capability-router.ts`
- `src/context/context-aware-router.ts`
- `src/registry/learning-router.ts`

Facade/orchestration:
- `src/facade/orchestrator-facade.ts`
- `src/orchestration/parallel-executor.ts`
- `src/orchestration/supervisor.ts`
- `src/orchestration/map-reduce.ts`
- `src/orchestration/contract-net.ts`

Workflow/state:
- `src/workflow/adapter-workflow.ts`
- `src/session/session-registry.ts`
- `src/session/workflow-checkpointer.ts`
- `src/persistence/persistent-checkpoint-store.ts`
- `src/persistence/run-manager.ts`

Governance/ops:
- `src/middleware/*`
- `src/guardrails/adapter-guardrails.ts`
- `src/approval/adapter-approval.ts`
- `src/recovery/adapter-recovery.ts`
- `src/observability/*`
- `src/streaming/streaming-handler.ts`
- `src/http/adapter-http-handler.ts`

Integration/extension:
- `src/plugin/*`
- `src/integration/agent-bridge.ts`
- `src/mcp/mcp-tool-sharing.ts`
- `src/learning/*`

---

## 13. Test Coverage Map

### 13.1 Adapter contract and provider implementations

- Contract and lifecycle:
  - `adapter-conformance.contract.test.ts`
  - `adapter-event-contracts.test.ts`
  - `adapter-lifecycle.test.ts`
- Provider adapters:
  - `claude-adapter.test.ts`
  - `codex-adapter.test.ts`
  - `gemini-adapter.test.ts`
  - `gemini-sdk-adapter.test.ts`
  - `qwen-adapter.test.ts`
  - `crush-adapter.test.ts`
  - `goose-adapter.test.ts`
  - `openrouter-adapter.test.ts`
- Cross-adapter execution flow:
  - `adapter-execution-flow.test.ts`
- Correlation/warmup and smoke:
  - `correlation-warmup.test.ts`
  - `cli-smoke.test.ts`

### 13.2 Registry, routing, health, and fallback

- Registry and fallback:
  - `adapter-registry.test.ts`
  - `detailed-health.test.ts`
  - `event-bus-bridge.test.ts`
- Routing strategies:
  - `capability-router.test.ts`
  - `context-aware-router.test.ts`
  - `learning-router.test.ts`
  - `cost-optimization.test.ts`

### 13.3 Orchestration patterns

- Facade and lifecycle:
  - `orchestrator-facade.test.ts`
  - `orchestrator-shutdown.test.ts`
- Parallel execution:
  - `parallel-executor.test.ts`
  - `parallel-executor.contract.test.ts`
  - `parallel-executor-unhandled-rejection.test.ts`
  - `parallel-executor.stress.test.ts`
- Supervisor / contract-net / map-reduce:
  - `supervisor.test.ts`
  - `contract-net.test.ts`
  - `map-reduce.test.ts`
- Chaos integration:
  - `adapter-chaos.integration.test.ts`

### 13.4 Workflow DSL, sessions, and persistence

- Workflow builder/runtime and validation:
  - `adapter-workflow.test.ts`
  - `workflow-validator.test.ts`
  - `workflow-loop.test.ts`
  - `workflow-skip.test.ts`
  - `workflow-timeout.test.ts`
  - `workflow-versioning.test.ts`
  - `workflow-typed-state.test.ts`
  - `template-resolver.test.ts`
- Sessions/checkpointing/runs:
  - `session-registry.test.ts`
  - `workflow-checkpointer.test.ts`
  - `persistent-checkpoint-store.test.ts`
  - `run-manager.test.ts`

### 13.5 Safety, governance, and recovery

- Guardrails and approval:
  - `adapter-guardrails.test.ts`
  - `adapter-approval.test.ts`
  - `approval-audit.test.ts`
- Recovery and escalation:
  - `adapter-recovery.test.ts`
  - `recovery-backoff.test.ts`
  - `recovery-events.test.ts`
  - `recovery-cancelled-integration.test.ts`
  - `recovery-policies.test.ts`
  - `escalation-handler.test.ts`

### 13.6 Middleware, output, streaming, and observability

- Middleware/cost/sanitization:
  - `middleware-pipeline.test.ts`
  - `cost-tracking.test.ts`
  - `cost-models.test.ts`
  - `content-sanitizer.test.ts`
- Structured output and streaming:
  - `structured-output.test.ts`
  - `streaming-handler.test.ts`
- Tracing and event utilities:
  - `adapter-tracer.test.ts`
  - `tracing-middleware.test.ts`
  - `trace-eviction.test.ts`
  - `batched-event-emitter.test.ts`

### 13.7 Integration surfaces and plugins

- HTTP/rate-limit/schemas:
  - `adapter-http-handler.test.ts`
  - `request-schemas.test.ts`
  - `rate-limiter.test.ts`
- Plugin/MCP/bridge:
  - `adapter-plugin.test.ts`
  - `adapter-plugin-sdk.test.ts`
  - `mcp-tool-sharing.test.ts`
  - `agent-bridge.test.ts`

### 13.8 Learning and evaluation

- Learning and stores:
  - `adapter-learning-loop.test.ts`
  - `learning-store.test.ts`
- Evaluation:
  - `ab-test-runner.test.ts`

### 13.9 Utility and error handling coverage

- Utility and error behavior:
  - `process-helpers.test.ts`
  - `process-helpers.fuzz.test.ts`
  - `provider-helpers.test.ts`
  - `url-validator.test.ts`
  - `env-filter.test.ts`
  - `error-context.test.ts`
  - `dzip-error.test.ts`
  - `skill-projector.test.ts`

### 13.10 Documentation integrity test

- `architecture-doc.test.ts`
