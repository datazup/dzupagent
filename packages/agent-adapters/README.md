# @dzipagent/agent-adapters

AI agent CLI/SDK adapters for DzipAgent. This package standardizes provider integrations (Claude, Codex, Gemini, Qwen, Crush), routing, fallback execution, orchestration patterns, structured output, approvals, recovery, and workflow composition.

## Installation

```bash
yarn add @dzipagent/agent-adapters
# or
npm install @dzipagent/agent-adapters
```

## Provider requirements

`@dzipagent/agent-adapters` unifies several provider backends under one interface.

| Provider | Adapter | Runtime dependency |
|---|---|---|
| Claude | `ClaudeAgentAdapter` | `@anthropic-ai/claude-agent-sdk` (optional dependency in package) |
| Codex | `CodexAdapter` | `@openai/codex-sdk` (optional dependency in package) |
| Gemini | `GeminiCLIAdapter` | `gemini` CLI available in `PATH` |
| Qwen | `QwenAdapter` | OpenAI-compatible endpoint and/or `qwen` CLI |
| Crush | `CrushAdapter` | `crush` CLI available in `PATH` |

## Core design

- **Unified adapter contract** via `AgentCLIAdapter` and `AgentEvent` stream (`adapter:started`, `adapter:message`, `adapter:tool_call`, `adapter:tool_result`, `adapter:stream_delta`, `adapter:completed`, `adapter:failed`).
- **Provider routing + fallback** via `AdapterRegistry` and routing strategies (`TagBasedRouter`, `CostOptimizedRouter`, `RoundRobinRouter`, `CompositeRouter`, `CapabilityRouter`, `ContextAwareRouter`).
- **High-level orchestration** through `OrchestratorFacade` / `createOrchestrator` (`run`, `parallel`, `race`, `supervisor`, `mapReduce`, `bid`, `chat`).
- **Operational controls** including cost tracking/optimization, guardrails, approval gates, recovery copilot, checkpoints, and run management.

## Features in detail

### 1) Multi-provider adapter layer

- Built-in adapters: `ClaudeAgentAdapter`, `CodexAdapter`, `GeminiCLIAdapter`, `QwenAdapter`, `CrushAdapter`.
- Session lifecycle support:
  - `execute(input)`
  - `resumeSession(sessionId, input)`
  - `interrupt()`
  - `healthCheck()`
  - `listSessions()` / `forkSession()` (when provider supports it)
- All providers emit the same normalized event model, so orchestration code can stay provider-agnostic.

### 2) Registry, routing, and fallback execution

- `AdapterRegistry` registers adapters and executes with router-selected primary + fallback providers.
- Health-aware selection with circuit breaker integration from `@dzipagent/core`.
- Router options:
  - **Tag based** (`TagBasedRouter`) for heuristics by task tags.
  - **Cost optimized** (`CostOptimizedRouter`) for low-cost routing.
  - **Round robin** (`RoundRobinRouter`) for balanced distribution.
  - **Capability based** (`CapabilityRouter`) for tool/reasoning/latency needs.
  - **Context aware** (`ContextAwareRouter`) for context-window fit.

### 3) Orchestration patterns (single facade)

`OrchestratorFacade` wraps registry + event bridge + cost tracking + session registry.

- `run(prompt, options)` — simplest route-and-execute API.
- `parallel(prompt, options)` — run across multiple providers and merge.
- `race(prompt, providers?)` — first successful provider wins.
- `supervisor(goal, options)` — task decomposition and delegated execution.
- `mapReduce(input, options)` — chunk/map/reduce for large inputs.
- `bid(prompt, options)` — contract-net style provider bidding.
- `chat(prompt, options)` — multi-turn workflow with session continuity.

### 4) Context-aware routing and injection

- `ContextAwareRouter` estimates token usage and routes to providers with sufficient effective context window.
- Built-in context window defaults for all supported providers; configurable safety margin and token estimator.
- `ContextInjectionMiddleware` manages prioritized context chunks, applies token-budget filtering, and injects context into prompt or system prompt.

### 5) Safety and governance features

- `AdapterGuardrails` / `AdapterStuckDetector` — runtime budget and stall detection.
- `AdapterApprovalGate` — human-in-the-loop approval (`auto`, `required`, `conditional`), timeout handling, and webhook/event notifications.
- `AdapterRecoveryCopilot` / `ExecutionTraceCapture` — analyze failures and suggest or apply recovery strategies.

### 6) Structured outputs and protocol adaptation

- `StructuredOutputAdapter` retries and validates model output against schemas.
- Built-in schemas:
  - `JsonOutputSchema<T>`
  - `RegexOutputSchema`
- Optional format-instruction injection and fallback provider rotation on parse failures.

### 7) Stateful and persistent execution

- `SessionRegistry` for workflow-scoped conversation/session tracking.
- `WorkflowCheckpointer`, `InMemoryCheckpointStore`, `FileCheckpointStore` for resumable workflows.
- `RunManager` for run lifecycle tracking, stats, pruning, and event emission.

### 8) Additional platform utilities

- `AdapterTracer` for trace spans/events.
- `StreamingHandler` for stream formatting and progress output.
- `ABTestRunner` + scorers (`LengthScorer`, `ExactMatchScorer`, `ContainsKeywordsScorer`) for provider evaluation.
- `MCPToolSharingBridge` for tool-sharing workflows.
- `AdapterHttpHandler` for exposing adapter orchestration via HTTP endpoints.
- `AdapterLearningLoop` / `ExecutionAnalyzer` for adaptive provider performance feedback.

## Usage examples

### Example 1: Quick start with the orchestrator facade

```ts
import { createEventBus } from '@dzipagent/core'
import {
  createOrchestrator,
  ClaudeAgentAdapter,
  CodexAdapter,
} from '@dzipagent/agent-adapters'

const eventBus = createEventBus()

const orchestrator = createOrchestrator({
  adapters: [
    new ClaudeAgentAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }),
    new CodexAdapter({ apiKey: process.env.OPENAI_API_KEY }),
  ],
  eventBus,
  enableCostTracking: true,
})

const runResult = await orchestrator.run('Fix the flaky test in packages/server', {
  tags: ['code', 'reasoning'],
})

console.log(runResult.providerId, runResult.result)
console.log(orchestrator.getCostReport())

const firstWinner = await orchestrator.race('Summarize this changelog quickly', ['claude', 'codex'])
console.log(firstWinner.providerId, firstWinner.result)
```

### Example 2: Context-aware routing + prioritized context injection

```ts
import {
  ContextAwareRouter,
  ContextInjectionMiddleware,
  type AdapterProviderId,
  type TaskDescriptor,
} from '@dzipagent/agent-adapters'

const router = new ContextAwareRouter({
  safetyMargin: 0.2,
  defaultOutputTokens: 3000,
})

const injections = new ContextInjectionMiddleware({
  position: 'prepend',
  maxContextTokens: 20_000,
})

injections.addInjections([
  { label: 'RepoContext', content: 'Monorepo uses Yarn workspaces and tsup.', priority: 10, required: true },
  { label: 'RecentErrors', content: 'Type errors in package server...', priority: 8 },
])

const input = { prompt: 'Plan a safe refactor of the router module.' }
const task: TaskDescriptor = { prompt: input.prompt, tags: ['reasoning'] }

const decision = router.route(task, ['claude', 'codex', 'gemini'])
const chosenProvider: AdapterProviderId = decision.provider === 'auto' ? 'claude' : decision.provider

const enriched = injections.enrichInput(input, chosenProvider, router)
console.log(chosenProvider, enriched.prompt)
```

### Example 3: Human approval gate before execution

```ts
import { createEventBus } from '@dzipagent/core'
import {
  AdapterApprovalGate,
  ClaudeAgentAdapter,
  type ApprovalContext,
} from '@dzipagent/agent-adapters'

const eventBus = createEventBus()

const gate = new AdapterApprovalGate({
  mode: 'required',
  timeoutMs: 60_000,
  eventBus,
})

const adapter = new ClaudeAgentAdapter({ apiKey: process.env.ANTHROPIC_API_KEY })

const context: ApprovalContext = {
  runId: 'run-42',
  description: 'Apply production DB migration',
  providerId: 'claude',
  estimatedCostCents: 125,
  tags: ['production', 'migration'],
}

// Simulate external approval (e.g., from an HTTP endpoint/webhook handler)
setTimeout(() => {
  const pending = gate.listPending()[0]
  if (pending) gate.grant(pending.requestId, 'release-manager')
}, 1000)

for await (const event of gate.guard(context, adapter.execute({ prompt: 'Execute migration steps safely' }))) {
  console.log(event.type)
}
```

### Example 4: Validate structured JSON output

```ts
import {
  AdapterRegistry,
  ClaudeAgentAdapter,
  StructuredOutputAdapter,
  JsonOutputSchema,
} from '@dzipagent/agent-adapters'

interface ReleasePlan {
  steps: string[]
  risk: 'low' | 'medium' | 'high'
}

const registry = new AdapterRegistry()
registry.register(new ClaudeAgentAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }))

const planSchema = new JsonOutputSchema<ReleasePlan>(
  'release-plan',
  (data) => {
    const candidate = data as Partial<ReleasePlan>
    if (!Array.isArray(candidate.steps)) {
      throw new Error('steps must be an array')
    }
    if (candidate.risk !== 'low' && candidate.risk !== 'medium' && candidate.risk !== 'high') {
      throw new Error('risk must be low|medium|high')
    }
    return { steps: candidate.steps.map(String), risk: candidate.risk }
  },
  'a JSON object: {"steps": string[], "risk": "low"|"medium"|"high"}',
)

const structured = new StructuredOutputAdapter(registry, { maxRetries: 2 })

const result = await structured.execute(
  { prompt: 'Return a deployment release plan as JSON' },
  planSchema,
)

if (result.result.success) {
  console.log(result.result.value.steps)
}
```

### Example 5: Build and run an adapter workflow DSL

```ts
import {
  AdapterRegistry,
  ClaudeAgentAdapter,
  CodexAdapter,
  defineWorkflow,
} from '@dzipagent/agent-adapters'

const registry = new AdapterRegistry()
registry.register(new ClaudeAgentAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }))
registry.register(new CodexAdapter({ apiKey: process.env.OPENAI_API_KEY }))

const workflow = defineWorkflow({ id: 'pr-review' })
  .step({ id: 'summary', prompt: 'Summarize this diff:\n{{state.diff}}', tags: ['reasoning'] })
  .parallel([
    { id: 'security', prompt: 'Security review:\n{{prev}}', tags: ['security'] },
    { id: 'performance', prompt: 'Performance review:\n{{prev}}', tags: ['performance'] },
  ])
  .transform('compose', (state) => ({
    ...state,
    report: `Security:\n${String(state['security'])}\n\nPerformance:\n${String(state['performance'])}`,
  }))
  .step({ id: 'final', prompt: 'Write final review:\n{{state.report}}', preferredProvider: 'claude' })
  .build()

const workflowResult = await workflow.run(registry, {
  initialState: { diff: '...' },
  onEvent: (event) => console.log(event.type),
})

console.log(workflowResult.success, workflowResult.finalState)
```

## Main exports (by area)

- **Adapters:** `ClaudeAgentAdapter`, `CodexAdapter`, `GeminiCLIAdapter`, `QwenAdapter`, `CrushAdapter`
- **Registry/routing:** `AdapterRegistry`, `TagBasedRouter`, `CostOptimizedRouter`, `RoundRobinRouter`, `CompositeRouter`, `CapabilityRouter`, `ContextAwareRouter`
- **Orchestration:** `OrchestratorFacade`, `createOrchestrator`, `SupervisorOrchestrator`, `ParallelExecutor`, `MapReduceOrchestrator`, `ContractNetOrchestrator`
- **Workflow/session/persistence:** `defineWorkflow`, `AdapterWorkflowBuilder`, `SessionRegistry`, `WorkflowCheckpointer`, `RunManager`, `FileCheckpointStore`
- **Controls/safety:** `AdapterGuardrails`, `AdapterApprovalGate`, `AdapterRecoveryCopilot`, `CostTrackingMiddleware`, `CostOptimizationEngine`
- **Output/streaming/observability:** `StructuredOutputAdapter`, `JsonOutputSchema`, `RegexOutputSchema`, `StreamingHandler`, `AdapterTracer`
- **Integration surfaces:** `AdapterHttpHandler`, `createAdapterPlugin`, `AgentIntegrationBridge`, `MCPToolSharingBridge`

## License

MIT