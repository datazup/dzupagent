# Router Module Architecture (`packages/core/src/router`)

## Scope
This document covers the routing subsystem implemented under `packages/core/src/router`:
- `intent-router.ts`
- `keyword-matcher.ts`
- `llm-classifier.ts`
- `cost-aware-router.ts`
- `escalation-policy.ts`

It also references in-package integration points in `packages/core/src` (exports, facades, and direct consumers), plus package metadata from `package.json` and `README.md` where relevant.

## Responsibilities
The router module provides two related capabilities:
- Intent classification with a staged fallback pipeline: heuristic, keyword rules, LLM classification, then default intent.
- Model-tier recommendation and quality-driven escalation policy for runtime routing economics.

Concretely, it owns:
- Deterministic regex intent matching (`KeywordMatcher`).
- LLM fallback classification constrained to an allowed intent set (`LLMClassifier`).
- Composition of classifier stages and confidence tagging (`IntentRouter`).
- Complexity scoring + model tier mapping (`CostAwareRouter`, `isSimpleTurn`, `scoreComplexity`).
- Consecutive-low-score tracking and tier upgrade recommendation (`ModelTierEscalationPolicy`).

## Structure
| File | Purpose | Main exports |
| --- | --- | --- |
| `intent-router.ts` | Orchestrates multi-stage classification and confidence origin | `IntentRouter`, `IntentRouterConfig`, `ClassificationResult` |
| `keyword-matcher.ts` | Ordered regex-to-intent matcher | `KeywordMatcher` |
| `llm-classifier.ts` | Prompted LLM classifier with allowlist validation | `LLMClassifier` |
| `cost-aware-router.ts` | Wraps `IntentRouter` with complexity-based `ModelTier` routing and forced-intent overrides | `CostAwareRouter`, `CostAwareResult`, `CostAwareRouterConfig`, `ComplexityLevel`, `isSimpleTurn`, `scoreComplexity` |
| `escalation-policy.ts` | Tracks repeated low scores and suggests next tier with cooldown rules | `ModelTierEscalationPolicy`, `EscalationPolicyConfig`, `EscalationResult` |

## Runtime and Control Flow
1. `IntentRouter.classify(text, context?)` runs pipeline stages in strict order.
2. If `heuristic` returns a non-null intent, it returns immediately with `confidence: 'heuristic'`.
3. Otherwise `keywordMatcher.match(text)` is attempted; first match returns `confidence: 'keyword'`.
4. Otherwise `llmClassifier.classify(text)` is attempted (if configured); non-null returns `confidence: 'llm'`.
5. Otherwise `defaultIntent` is returned with `confidence: 'default'`.

`CostAwareRouter.classify(text, context?)` adds model-tier routing on top of that result:
1. Calls wrapped `intentRouter.classify(...)`.
2. If classified intent is in `forceReasoningIntents`, returns `reasoningTier`, `routingReason: 'forced'`, `complexity: 'complex'`.
3. Else if intent is in `forceExpensiveIntents`, returns `expensiveTier`, `routingReason: 'forced'`, `complexity: 'moderate'`.
4. Else computes `complexity = scoreComplexity(...)` and maps:
- `simple -> cheapTier` with `routingReason: 'simple_turn'`
- `moderate -> expensiveTier` with `routingReason: 'complex_turn'`
- `complex -> reasoningTier` with `routingReason: 'reasoning_turn'`

`scoreComplexity(...)` behavior:
- Returns `simple` when `isSimpleTurn(...)` passes.
- Returns `complex` when reasoning signals are strong (keyword count/long multiline heuristics).
- Returns `moderate` otherwise.

`ModelTierEscalationPolicy.recordScore(key, score, currentTier)` flow:
1. Initializes in-memory key state if missing.
2. If `score >= lowScoreThreshold`, clears streak and does not escalate.
3. Otherwise appends low score and keeps last `consecutiveCount` values.
4. If low-score streak is below threshold count, does not escalate.
5. If current tier is highest in `tierChain`, does not escalate.
6. If cooldown is active (`now - lastEscalatedAt < cooldownMs`), does not escalate.
7. Otherwise recommends next tier and resets streak.

## Key APIs and Types
`ClassificationResult`:
- `intent: string`
- `confidence: 'heuristic' | 'keyword' | 'llm' | 'default'`

`IntentRouterConfig`:
- `keywordMatcher: KeywordMatcher` (required)
- `llmClassifier?: LLMClassifier`
- `heuristic?: (text, context?) => Promise<string | null>`
- `defaultIntent: string` (required)

`CostAwareResult` extends `ClassificationResult` with:
- `modelTier: ModelTier`
- `routingReason: 'simple_turn' | 'complex_turn' | 'reasoning_turn' | 'forced'`
- `complexity: 'simple' | 'moderate' | 'complex'`

`CostAwareRouterConfig` defaults:
- `maxSimpleChars = 200`
- `maxSimpleWords = 30`
- `cheapTier = 'chat'`
- `expensiveTier = 'codegen'`
- `reasoningTier = 'reasoning'`

`EscalationPolicyConfig` defaults:
- `lowScoreThreshold = 0.5`
- `consecutiveCount = 3`
- `cooldownMs = 300_000`
- `tierChain = ['chat', 'codegen', 'reasoning']`

`EscalationResult`:
- `shouldEscalate: boolean`
- `fromTier: ModelTier`
- `toTier: ModelTier`
- `reason: string`
- `consecutiveLowScores: number`

## Dependencies
Internal dependencies used directly by router files:
- `../llm/model-config.js` (`ModelTier` type).
- Intra-router imports (`IntentRouter`, `KeywordMatcher`, `LLMClassifier`).

External dependencies used directly by router files:
- `@langchain/core/messages` (`HumanMessage`, `SystemMessage`) in `llm-classifier.ts`.
- `@langchain/core/language_models/chat_models` (`BaseChatModel`) in `llm-classifier.ts`.

Package-level context from `package.json`:
- `@langchain/core` is a peer dependency (`>=1.0.0`) and a dev dependency for local tests/build.

## Integration Points
Within `packages/core/src`, router components are integrated through:
- Root exports in `src/index.ts` (all router classes/types/functions are part of the main public API).
- Orchestration facade exports in `src/facades/orchestration.ts`.
- Stable facade path via `src/stable.ts` -> `src/facades/index.ts` -> orchestration namespace.
- `src/skills/workflow-command-parser.ts`, which accepts an optional `IntentRouter` and uses it as async fallback in `parseAsync`.

Related documentation state:
- `README.md` and `src/facades/ARCHITECTURE.md` mention router usage and exports, but some examples are stale relative to current constructor signatures (for example, `IntentRouter({ routes: [...] })` does not match current `IntentRouterConfig`).

## Testing and Observability
Direct router tests in `src/__tests__`:
- `cost-aware-router.test.ts` covers `isSimpleTurn`, `scoreComplexity`, forced-intent precedence, and configurable tier mapping.
- `escalation-policy.test.ts` covers threshold behavior, streak reset, cooldown behavior, custom chain config, key isolation, and reset semantics.

Additional in-package coverage touching router interfaces:
- `workflow-command-parser.test.ts` validates fallback behavior when an `IntentRouter` is provided.
- Facade tests (`facade-orchestration.test.ts`, `facades.test.ts`, `w15-b1-facades.test.ts`) verify router export surface wiring.

Current gaps:
- No dedicated unit tests for `IntentRouter` stage precedence and confidence labeling.
- No dedicated unit tests for `KeywordMatcher.match`/`matchAll` ordering behavior.
- No dedicated unit tests for `LLMClassifier` output normalization/partial matching/error swallowing behavior.

Observability in this module:
- Router files do not emit metrics or logs directly.
- Runtime observability is expected to be handled by calling layers (event bus, metrics collector, middleware, server/runtime packages).

## Risks and TODOs
- `KeywordMatcher` uses `RegExp.test` directly; patterns with stateful flags (`g`/`y`) can produce non-deterministic behavior across repeated calls because `lastIndex` is mutable.
- `LLMClassifier` lowercases model output but does not normalize `validIntents`; mixed-case `validIntents` can reduce exact-match reliability.
- `LLMClassifier` only performs lightweight text validation and partial-contains fallback, so prompt/output drift can cause false intent matches.
- `IntentRouter` does not isolate heuristic errors; exceptions from `heuristic` propagate, while `LLMClassifier` errors are swallowed and treated as no-match.
- `ModelTierEscalationPolicy` state is in-memory only; escalation history is lost on process restart.
- `README.md` router examples should be updated to match the current `IntentRouterConfig` and `CostAwareRouterConfig` APIs.
- Add focused unit tests for `intent-router.ts`, `keyword-matcher.ts`, and `llm-classifier.ts`.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js