# `@dzupagent/core` Facades Architecture

Last updated: 2026-04-03
Scope: `packages/core/src/facades/*`

## 1. Purpose and Design Intent

The facades layer is the curated API boundary for `@dzupagent/core`. It exists to give consumers stable, domain-oriented import paths instead of relying on the broad root export surface.

Primary goals:
1. Keep consumer imports intentional and domain-specific.
2. Improve discoverability through focused subpaths.
3. Preserve flexibility with tiered entrypoints:
   - `@dzupagent/core/stable` (facade-first)
   - `@dzupagent/core/advanced` (full root mirror)

Facade subpaths:
1. `@dzupagent/core/quick-start`
2. `@dzupagent/core/memory`
3. `@dzupagent/core/orchestration`
4. `@dzupagent/core/security`
5. `@dzupagent/core/facades` (namespaced bundle)

## 2. Module Topology and Export Wiring

Source files:
1. `packages/core/src/facades/quick-start.ts`
2. `packages/core/src/facades/memory.ts`
3. `packages/core/src/facades/orchestration.ts`
4. `packages/core/src/facades/security.ts`
5. `packages/core/src/facades/index.ts`

Entrypoint wiring:
1. `packages/core/package.json` maps subpath exports to `dist/facades/*.js`.
2. `packages/core/src/stable.ts` re-exports `./facades/index.js`.
3. `packages/core/src/advanced.ts` re-exports `./index.js`.

Import boundary flow:

```text
consumer package
  -> @dzupagent/core/<facade-subpath>
     -> packages/core/src/facades/<domain>.ts
        -> selected core modules and/or external workspace packages
```

## 3. Facade Features, Responsibilities, and Flows

## 3.1 `quick-start` facade

Path: `packages/core/src/facades/quick-start.ts`

### Key features
1. Runtime bootstrap primitives:
   - `ForgeContainer`, `createContainer`
   - `createEventBus`
   - `ModelRegistry`
2. LLM invocation and config helpers:
   - `invokeWithTimeout`
   - `DEFAULT_CONFIG`, `resolveConfig`, `mergeConfigs`
3. Curated essentials from memory/context:
   - `MemoryService`, `createStore` from `@dzupagent/memory`
   - summarization/eviction helpers from `@dzupagent/context`
4. Convenience runtime factory:
   - `createQuickAgent(options)`

### `createQuickAgent` flow

```text
input QuickAgentOptions
  -> resolve provider defaults (chat/codegen model names)
  -> create container + event bus + model registry
  -> registry.addProvider(...) with credentials/models/token limits
  -> register eventBus and registry in container
  -> return { container, eventBus, registry }
```

### Usage example

```ts
import { createQuickAgent, invokeWithTimeout } from '@dzupagent/core/quick-start'

const { registry, container } = createQuickAgent({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  chatModel: 'gpt-4o-mini',
  codegenModel: 'gpt-4o',
  chatMaxTokens: 4096,
  codegenMaxTokens: 8192,
})

const chatModel = registry.getModel('chat')
const response = await invokeWithTimeout(chatModel, 'Summarize this patch', { timeoutMs: 12_000 })

const sameRegistry = container.get('registry')
```

## 3.2 `memory` facade

Path: `packages/core/src/facades/memory.ts`

### Key features
`memory.ts` is a large domain barrel over `@dzupagent/memory`, grouped into practical capability clusters:
1. Core store/service lifecycle.
2. Decay and reinforcement scoring.
3. Sanitization and safety cleanup.
4. Consolidation and memory healing.
5. Retrieval families:
   - base (`fusionSearch`, vector/fts/graph)
   - adaptive (`AdaptiveRetriever`, `classifyIntent`)
   - ranking/graph enhancements (`computePPR`, `rerank`, `voidFilter`, hub dampening)
6. Temporal and scoped multi-agent memory.
7. Dual-stream, sleep consolidation, observational memory, provenance.
8. Encryption, conventions, causal graph, shared spaces, CRDT support.
9. Multi-modal and multi-network memory.
10. Agent-file import/export and MCP memory tool bridge.

### Flow pattern
This facade is intentionally compositional, not behavioral:

```text
memory consumer
  -> import focused memory capability from @dzupagent/core/memory
     -> implementation resolves in @dzupagent/memory
        -> caller composes service/retriever/policies per use case
```

### Usage example

```ts
import {
  createStore,
  MemoryService,
  AdaptiveRetriever,
  classifyIntent,
} from '@dzupagent/core/memory'

const store = createStore({ backend: 'memory' })
const memory = new MemoryService({
  store,
  namespace: { tenant: 'acme', project: 'assistant' },
})

const intent = classifyIntent('what prior decisions did we make about retries?')
const retriever = new AdaptiveRetriever({
  providers: {
    vector: async () => [],
    fts: async () => [],
    graph: async () => [],
  },
})

const hits = await retriever.search('retry policy', intent)
```

## 3.3 `orchestration` facade

Path: `packages/core/src/facades/orchestration.ts`

### Key features
1. Events and hooks (`createEventBus`, `AgentBus`, hook runner helpers).
2. Plugin lifecycle (`PluginRegistry`, discovery/order helpers).
3. Routing and escalation (`IntentRouter`, `LLMClassifier`, `CostAwareRouter`, `ModelTierEscalationPolicy`).
4. Sub-agent orchestration and file merge utilities.
5. Skills loading/injection/management/learning, chain validation, AGENTS.md parsing.
6. Pipeline schema, validation, serialization, and auto-layout.
7. Persistence for runs/agents/event logs.
8. Protocol messaging and bridge tooling.
9. Cost middleware and attribution.
10. Concurrency (`Semaphore`, `ConcurrencyPool`).
11. Observability and trace propagation.

### Typical orchestration flow

```text
classify intent and complexity
  -> apply plugins/hooks/skills
  -> execute via pipeline/protocol/subagent path
  -> emit events + persist run state
  -> collect metrics and trace context
```

### Usage example

```ts
import {
  createEventBus,
  IntentRouter,
  PipelineDefinitionSchema,
  Semaphore,
} from '@dzupagent/core/orchestration'

const bus = createEventBus()
const router = new IntentRouter({ routes: [{ intent: 'code', agent: 'coder' }] })
const classification = router.classify('refactor service retries')

PipelineDefinitionSchema.parse({ version: '1.0', nodes: [], edges: [] })

const sem = new Semaphore(2)
await sem.acquire()
try {
  bus.emit({ type: 'task:started' } as never)
} finally {
  sem.release()
}
```

## 3.4 `security` facade

Path: `packages/core/src/facades/security.ts`

### Key features
1. Risk classification.
2. Tool permission tiers.
3. Secrets scanning and redaction.
4. PII detection and redaction.
5. Output sanitization pipeline.
6. Compliance audit logging and in-memory store.
7. Policy engine and translator.
8. Safety monitor rules.
9. Memory poisoning defense.
10. Enhanced harmful-content filters.
11. Data classification patterns and tags.

### Typical security flow

```text
input or action
  -> classify risk and detect secrets/PII
  -> evaluate policy decision
  -> sanitize/redact output
  -> write compliance audit events
  -> optionally enforce safety and memory-defense checks
```

### Usage example

```ts
import {
  createRiskClassifier,
  scanForSecrets,
  InMemoryPolicyStore,
  PolicyEvaluator,
  OutputPipeline,
} from '@dzupagent/core/security'

const riskClassifier = createRiskClassifier()
const risk = riskClassifier.classify('export customer credentials')

const secretScan = scanForSecrets('token=ghp_1234...')

const policyStore = new InMemoryPolicyStore()
const evaluator = new PolicyEvaluator(policyStore)
const decision = await evaluator.evaluate({ principal: { type: 'agent', id: 'worker-1' } } as never)

const pipeline = new OutputPipeline()
const sanitized = await pipeline.run('My API key is sk-...')
```

## 3.5 `facades` namespace bundle

Path: `packages/core/src/facades/index.ts`

Exposes four namespaces:
1. `quickStart`
2. `memory`
3. `orchestration`
4. `security`

Usage example:

```ts
import { quickStart, orchestration } from '@dzupagent/core/facades'

const { registry } = quickStart.createQuickAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

const sem = new orchestration.Semaphore(3)
```

## 4. Cross-Package References and Real Usage

Repository scan result (non-core packages) shows current code imports from facades are concentrated in `@dzupagent/core/orchestration`:

1. `packages/agent/src/orchestration/map-reduce.ts`
   - imports `Semaphore` to bound chunk processing in `mapReduce` and `mapReduceMulti`.
2. `packages/agent-adapters/src/orchestration/map-reduce.ts`
   - imports `Semaphore` for map phase throttling and abort-aware permit acquisition.
3. `packages/agent-adapters/src/orchestration/supervisor.ts`
   - imports `Semaphore` for bounded subtask delegation with dependency-aware scheduling.
4. `packages/agent-adapters/src/testing/ab-test-runner.ts`
   - imports `Semaphore` to throttle variant x testcase x repetition execution.
5. `packages/evals/src/runner/enhanced-runner.ts`
   - imports `Semaphore` for bounded dataset evaluation concurrency.
6. `packages/evals/src/prompt-experiment/prompt-experiment.ts`
   - imports `Semaphore` for bounded prompt-variant experiment execution.

Adoption status summary:
1. `orchestration` facade has strong internal runtime adoption.
2. `quick-start`, `memory`, `security`, and `facades` namespace are currently primary public/documented surfaces, with limited direct usage by other workspace packages at source-import level.

## 5. Test Coverage and Validation

## 5.1 Direct facade contract tests (core)

Primary suite: `packages/core/src/__tests__/facades.test.ts`

Validated behaviors:
1. Each facade module resolves and exports expected representative symbols.
2. `createQuickAgent` wiring is correct (container registrations and identity checks).
3. Namespace facade exposes all four domains.
4. `stable` entrypoint remains facade-only.
5. `advanced` entrypoint remains root-compatible.

Executed command and result:
1. `yarn workspace @dzupagent/core test src/__tests__/facades.test.ts`
2. Result: 31/31 tests passed.

## 5.2 Focused coverage run (facade suite)

Executed command:
1. `yarn workspace @dzupagent/core test:coverage src/__tests__/facades.test.ts`

Facade file coverage from the generated report:
1. `src/facades/memory.ts`: 100% statements, 100% branches, 100% functions, 100% lines.
2. `src/facades/orchestration.ts`: 100% statements, 100% branches, 100% functions, 100% lines.
3. `src/facades/security.ts`: 100% statements, 100% branches, 100% functions, 100% lines.
4. `src/facades/quick-start.ts`: 100% statements, 77.77% branches, 100% functions, 100% lines.
   - uncovered branch lines: 121-130 (provider default fallback branch).

Coverage run caveat:
1. Command exits non-zero due package-global thresholds when running only one test file.
2. Facade-level metrics above are still valid for the targeted suite.

## 5.3 Indirect downstream validation of facade-consumed primitives

These suites validate behavior in modules that import facade exports (`Semaphore` via `@dzupagent/core/orchestration`):

1. `yarn workspace @dzupagent/agent test src/__tests__/map-reduce.test.ts`
   - Result: 37/37 tests passed.
2. `yarn workspace @dzupagent/agent-adapters test src/__tests__/map-reduce.test.ts src/__tests__/supervisor.test.ts`
   - Result: 51/51 tests passed.
3. `yarn workspace @dzupagent/evals test src/__tests__/enhanced-runner-coverage.test.ts src/__tests__/eval-runner-enhanced.test.ts src/__tests__/prompt-experiment.test.ts`
   - Result: 63/63 tests passed.

Indirect coverage highlights:
1. Concurrency bound enforcement and invalid concurrency rejection.
2. Abort/cancellation behavior while waiting on or holding permits.
3. Deterministic task/result ordering under bounded parallel execution.

## 6. Risks, Constraints, and Improvement Opportunities

Current observations:
1. Facade tests are mostly contract/smoke tests; they verify export presence and selected wiring, not deep semantics of every re-exported symbol.
2. `memory` facade is intentionally broad; it improves import discoverability but remains a very large surface area.
3. Cross-package code usage is currently concentrated on `orchestration/Semaphore`, so production feedback for other facade subpaths is comparatively limited.

Recommended improvements:
1. Add at least one behavior test per facade domain that exercises a small end-to-end workflow (not only symbol existence).
2. Add a targeted test for the `quick-start` fallback provider branch (lines 121-130).
3. Consider splitting `memory` into optional sub-facades if consumer personas continue diverging (for example retrieval-focused vs governance-focused imports).

## 7. Practical Import Guidance

1. Prefer `@dzupagent/core/stable` for long-lived integrations that should stay on curated surfaces.
2. Prefer explicit subpaths (`/quick-start`, `/memory`, `/orchestration`, `/security`) when domain boundaries matter.
3. Use `@dzupagent/core/advanced` or root `@dzupagent/core` only when broad access is required and tighter boundaries are not a priority.
