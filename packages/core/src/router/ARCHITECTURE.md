# Router Module Architecture (`packages/core/src/router`)

## 1) Purpose and Scope

This module provides a composable routing stack for:

- intent classification (`IntentRouter`)
- deterministic fast matching (`KeywordMatcher`)
- LLM fallback classification (`LLMClassifier`)
- model-tier selection (`CostAwareRouter`)
- post-run quality-based tier escalation (`ModelTierEscalationPolicy`)

In practice, this module is the bridge between user input semantics ("what is this request?") and execution economics ("which model tier should handle it now, and should future runs escalate?").

## 2) Files and Responsibilities

| File | Primary Responsibility | Main Exports |
| --- | --- | --- |
| `intent-router.ts` | Multi-stage intent classification pipeline | `IntentRouter`, `IntentRouterConfig`, `ClassificationResult` |
| `keyword-matcher.ts` | Fast regex-to-intent matching | `KeywordMatcher` |
| `llm-classifier.ts` | LLM-based intent fallback with intent validation | `LLMClassifier` |
| `cost-aware-router.ts` | Intent + complexity-based model-tier routing | `CostAwareRouter`, `isSimpleTurn`, `scoreComplexity` |
| `escalation-policy.ts` | Consecutive-low-score escalation policy | `ModelTierEscalationPolicy` |

## 3) Core Contracts

### `ClassificationResult` (`intent-router.ts`)

```ts
{
  intent: string
  confidence: 'heuristic' | 'keyword' | 'llm' | 'default'
}
```

`confidence` indicates which tier of the intent pipeline produced the decision.

### `CostAwareResult` (`cost-aware-router.ts`)

Extends `ClassificationResult` with:

- `modelTier: ModelTier` (`chat | codegen | reasoning | embedding`)
- `routingReason: 'simple_turn' | 'complex_turn' | 'reasoning_turn' | 'forced'`
- `complexity: 'simple' | 'moderate' | 'complex'`

### `EscalationResult` (`escalation-policy.ts`)

```ts
{
  shouldEscalate: boolean
  fromTier: ModelTier
  toTier: ModelTier
  reason: string
  consecutiveLowScores: number
}
```

## 4) End-to-End Routing Flow

```text
user input
  -> IntentRouter.classify()
       1) heuristic(text, context)?         -> confidence: heuristic
       2) keywordMatcher.match(text)?       -> confidence: keyword
       3) llmClassifier.classify(text)?     -> confidence: llm
       4) defaultIntent                     -> confidence: default
  -> CostAwareRouter.classify()
       a) forceReasoningIntents hit?        -> reasoning tier (forced)
       b) forceExpensiveIntents hit?        -> codegen tier (forced)
       c) scoreComplexity(text):
          simple   -> cheapTier (default chat)
          moderate -> expensiveTier (default codegen)
          complex  -> reasoningTier (default reasoning)
  -> run metadata gets { modelTier, routingReason, complexity }
  -> executor uses metadata.modelTier when present
  -> (optional) reflection score produced after run
  -> ModelTierEscalationPolicy.recordScore(key, score, currentTier)
       if consecutive lows + cooldown passed + tier not max:
         recommend next tier
```

## 5) Feature-by-Feature Breakdown

### 5.1 `KeywordMatcher`

What it does:

- Stores ordered regex patterns.
- Returns first matching intent (`match`) or all matches (`matchAll`).
- Supports fluent pattern registration via `.addPattern(...).addPattern(...)`.

Why it exists:

- Provides deterministic, cheap, low-latency routing before any LLM call.

Behavior notes:

- Order matters for `match`; first match wins.
- `matchAll` preserves registration order.

### 5.2 `IntentRouter`

What it does:

- Orchestrates 4-tier classification:
  - `heuristic` (optional async callback)
  - `keywordMatcher`
  - `llmClassifier` (optional)
  - `defaultIntent`

Why it exists:

- Separates "intent selection strategy" from model-tier economics.
- Allows domain-specific deterministic short-circuiting via heuristic.

Behavior notes:

- `context` is passed only to `heuristic`; keyword/LLM steps only see text.
- Failure at one stage does not throw by default (LLM classifier itself catches internally and returns `null`).

### 5.3 `LLMClassifier`

What it does:

- Formats a prompt using placeholders:
  - `{message}`
  - `{intents}`
- Invokes a `BaseChatModel`.
- Normalizes model output to lowercase and validates it against `validIntents`.
- Falls back to partial includes matching if exact match fails.

Why it exists:

- Handles ambiguous inputs that deterministic routes miss.

Behavior notes:

- Any model error is swallowed and returned as `null` to keep router non-fatal.
- Because response text is lowercased, `validIntents` should be lowercase for best reliability.

### 5.4 `CostAwareRouter`

What it does:

- Wraps `IntentRouter`.
- Applies explicit intent-level overrides (`forceReasoningIntents`, `forceExpensiveIntents`).
- Otherwise scores text complexity and maps to model tier.

Complexity stages:

- `isSimpleTurn` rejects simple classification when text is too long, multiline, contains code fences, URLs, or complexity keywords.
- `scoreComplexity` returns:
  - `simple` when `isSimpleTurn` passes
  - `complex` when reasoning signals are high (keywords + multiline/long)
  - `moderate` otherwise

Defaults:

- `maxSimpleChars = 200`
- `maxSimpleWords = 30`
- `cheapTier = 'chat'`
- `expensiveTier = 'codegen'`
- `reasoningTier = 'reasoning'`

Priority rules:

- `forceReasoningIntents` takes precedence over `forceExpensiveIntents`.

### 5.5 `ModelTierEscalationPolicy`

What it does:

- Tracks score streaks per key (example key: `agentId:intent`).
- Escalates to next tier when:
  - score is below threshold,
  - low-score streak reaches `consecutiveCount`,
  - current tier is not already highest,
  - cooldown period has elapsed.

Defaults:

- `lowScoreThreshold = 0.5`
- `consecutiveCount = 3`
- `cooldownMs = 300_000`
- `tierChain = ['chat', 'codegen', 'reasoning']`

Behavior notes:

- Scores at/above threshold reset streak.
- Streak is reset after escalation.
- Streak is not reset by cooldown-blocked attempts (buffered lows can trigger right after cooldown).

## 6) Runtime Integration Flow (Current Monorepo)

### 6.1 Where routing happens

In `packages/server/src/routes/runs.ts`, during `POST /api/runs`:

- input is normalized to text (`message`/`content`/`prompt`/JSON)
- `config.router.classify(text)` is called when router is configured
- run metadata is enriched with:
  - `modelTier`
  - `routingReason`
  - `complexity`
- metric `forge_routing_total` is incremented with tier/reason/complexity labels

Router failures are intentionally non-fatal; run creation continues without routing metadata.

### 6.2 Where selected tier is consumed

In `packages/server/src/runtime/dzip-agent-run-executor.ts`:

- executor chooses model tier from run metadata first
- fallback is the agent definition's `modelTier`

This makes routing decisions directly influence model selection.

### 6.3 Where escalation is consumed

In `packages/server/src/runtime/run-worker.ts`:

- reflection score is computed (if reflector is configured)
- escalation key uses `agentId:intent`
- `escalationPolicy.recordScore(...)` is called
- if escalation is recommended, worker updates `agent.metadata.modelTier` and emits `registry:agent_updated`

`run-worker` uses structural typing for escalation policy, so `ModelTierEscalationPolicy` from `@dzupagent/core` is wire-compatible but not hard-imported.

## 7) References in Other Packages

Based on repository search outside `packages/core`:

- `packages/server/src/app.ts`
  - imports type `CostAwareRouter`
  - exposes optional `router?: CostAwareRouter` in server config
- `packages/server/src/routes/runs.ts`
  - executes router classification and writes routing metadata
- `packages/server/src/runtime/dzip-agent-run-executor.ts`
  - consumes `metadata.modelTier` to pick effective runtime model
- `packages/server/src/routes/routing-stats.ts`
  - aggregates `modelTier`, `routingReason`, `complexity` for operations visibility
- `packages/server/src/__tests__/e2e-run-pipeline.test.ts`
  - concrete construction of `KeywordMatcher -> IntentRouter -> CostAwareRouter`
  - validates run metadata routing outcomes end to end
- `packages/adapter-types/ARCHITECTURE.md`
  - conceptual mention of cost-aware router pattern (documentation only)

Current state summary:

- cross-package runtime dependency is primarily on `CostAwareRouter` behavior through server run creation
- `IntentRouter`, `KeywordMatcher`, `LLMClassifier`, and `ModelTierEscalationPolicy` are mostly consumed in-core or by tests/docs today

## 8) Usage Examples

### 8.1 Basic deterministic intent routing

```ts
import { IntentRouter, KeywordMatcher } from '@dzupagent/core'

const keywordMatcher = new KeywordMatcher()
  .addPattern(/generate|implement|build/i, 'generate_feature')
  .addPattern(/edit|update|modify/i, 'edit_feature')

const intentRouter = new IntentRouter({
  keywordMatcher,
  defaultIntent: 'chat',
})

const result = await intentRouter.classify('Please implement login with JWT')
// { intent: 'generate_feature', confidence: 'keyword' }
```

### 8.2 Add heuristic and LLM fallback

```ts
import { IntentRouter, KeywordMatcher, LLMClassifier } from '@dzupagent/core'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

const model: BaseChatModel = /* your LangChain chat model */

const llmClassifier = new LLMClassifier(
  model,
  'Classify this message: "{message}". Valid intents: {intents}.',
  ['chat', 'generate_feature', 'edit_feature'],
)

const intentRouter = new IntentRouter({
  keywordMatcher: new KeywordMatcher().addPattern(/help|question/i, 'chat'),
  llmClassifier,
  heuristic: async (text, context) => {
    if (context?.['forceIntent'] && typeof context['forceIntent'] === 'string') {
      return context['forceIntent']
    }
    return null
  },
  defaultIntent: 'chat',
})
```

### 8.3 Cost-aware routing with forced intents

```ts
import { CostAwareRouter } from '@dzupagent/core'

const router = new CostAwareRouter({
  intentRouter,
  forceExpensiveIntents: ['generate_feature'],
  forceReasoningIntents: ['review_architecture'],
  maxSimpleChars: 180,
  maxSimpleWords: 25,
})

const routed = await router.classify('Architect a multi-service scaling strategy')
// {
//   intent: 'review_architecture' | ...,
//   confidence: ...,
//   modelTier: 'reasoning',
//   routingReason: 'forced' | 'reasoning_turn',
//   complexity: 'complex'
// }
```

### 8.4 Server wiring (`@dzupagent/server`)

```ts
import { createForgeApp } from '@dzupagent/server'
import { CostAwareRouter, IntentRouter, KeywordMatcher } from '@dzupagent/core'

const keywordMatcher = new KeywordMatcher().addPattern(/generate|implement/i, 'generate_feature')
const intentRouter = new IntentRouter({ keywordMatcher, defaultIntent: 'chat' })
const router = new CostAwareRouter({ intentRouter, forceExpensiveIntents: ['generate_feature'] })

const app = createForgeApp({
  runStore,
  agentStore,
  eventBus,
  modelRegistry,
  router, // enables metadata.modelTier/routingReason/complexity enrichment
})
```

### 8.5 Escalation policy wiring in worker

```ts
import { ModelTierEscalationPolicy } from '@dzupagent/core'
import { startRunWorker } from '@dzupagent/server'

const escalationPolicy = new ModelTierEscalationPolicy({
  lowScoreThreshold: 0.5,
  consecutiveCount: 3,
  cooldownMs: 5 * 60 * 1000,
})

startRunWorker({
  runQueue,
  runStore,
  agentStore,
  eventBus,
  modelRegistry,
  runExecutor,
  reflector,
  escalationPolicy, // structural compatibility with EscalationPolicyLike
})
```

## 9) Test Coverage and Gaps

Generated on 2026-04-03 from:

- `yarn workspace @dzupagent/core test src/__tests__/cost-aware-router.test.ts src/__tests__/escalation-policy.test.ts`
- `yarn workspace @dzupagent/core test:coverage`

### 9.1 Router-folder coverage (from `packages/core/coverage/coverage-summary.json`)

| File | Lines | Statements | Functions | Branches |
| --- | --- | --- | --- | --- |
| `src/router/cost-aware-router.ts` | 100% | 100% | 100% | 97.5% |
| `src/router/escalation-policy.ts` | 100% | 100% | 100% | 100% |
| `src/router/intent-router.ts` | 59.25% | 59.25% | 0% | 100% |
| `src/router/keyword-matcher.ts` | 28.57% | 28.57% | 0% | 100% |
| `src/router/llm-classifier.ts` | 30% | 30% | 0% | 100% |
| `src/router` aggregate | 83.36% | 83.36% | 66.66% | 98.48% |

### 9.2 Existing tests

- `src/__tests__/cost-aware-router.test.ts` (19 tests)
  - `isSimpleTurn` edge cases
  - `scoreComplexity` tiering behavior
  - forced intent precedence and custom tier mapping
- `src/__tests__/escalation-policy.test.ts` (12 tests)
  - threshold behavior
  - streak reset
  - cooldown handling
  - tier-chain progression
  - key isolation and reset semantics

Also relevant integration coverage:

- `packages/server/src/__tests__/e2e-run-pipeline.test.ts`
  - verifies routing metadata is written and affects run behavior
- `packages/server/src/__tests__/escalation-wiring.test.ts`
  - verifies worker-side escalation wiring (via policy interface)

### 9.3 Coverage gaps (important)

- no direct unit tests for `IntentRouter` pipeline ordering and confidence labels
- no direct unit tests for `KeywordMatcher` `match`/`matchAll` behavior and pattern order semantics
- no direct unit tests for `LLMClassifier` exact/partial-match validation and error handling

Recommended additions:

- add `intent-router.test.ts` covering heuristic/keyword/llm/default precedence
- add `keyword-matcher.test.ts` with ordered overlap and `matchAll` determinism
- add `llm-classifier.test.ts` with mocked `BaseChatModel` for:
  - exact valid intent
  - partial valid intent
  - invalid output
  - thrown model error

## 10) Architecture Risks and Tradeoffs

- deterministic-first strategy reduces cost and latency, but keyword quality directly drives intent quality
- LLM fallback improves recall, but currently has minimal output-shape hardening beyond string checks
- complexity scoring uses static keyword heuristics; tuning is domain-sensitive and may drift with real traffic
- routing failures are intentionally non-fatal, which improves availability but can silently degrade optimization
- escalation writes selected tier into `agent.metadata.modelTier` (worker path), while executor primarily reads run metadata first; teams should define how persistent agent metadata is reconciled with per-run overrides

## 11) Export Surface

Router exports are exposed through:

- root package exports (`packages/core/src/index.ts`)
- orchestration facade (`packages/core/src/facades/orchestration.ts`)

This makes the router stack available to both broad consumers (`@dzupagent/core`) and curated orchestration consumers (`@dzupagent/core/orchestration`).
