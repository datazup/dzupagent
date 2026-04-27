# Router Architecture (`packages/core/src/router`)

## Scope
This document covers the routing module in `@dzupagent/core` under `packages/core/src/router`:
- `intent-router.ts`
- `keyword-matcher.ts`
- `llm-classifier.ts`
- `cost-aware-router.ts`
- `escalation-policy.ts`

It also references package-local integration surfaces that expose or consume these router APIs:
- `src/index.ts`
- `src/facades/orchestration.ts`
- `src/skills/workflow-command-parser.ts`
- router-focused tests in `src/__tests__`

## Responsibilities
The router module owns two related concerns:

1. Intent classification orchestration
- `IntentRouter` composes a staged pipeline: heuristic function, regex keyword matching, optional LLM fallback, then configured default intent.
- `KeywordMatcher` provides deterministic first-match and all-match regex intent mapping.
- `LLMClassifier` performs constrained classification against an explicit valid-intent list.

2. Model-tier routing policy
- `CostAwareRouter` wraps `IntentRouter` and maps each message to a `ModelTier` using forced-intent overrides plus complexity scoring.
- `ModelTierEscalationPolicy` tracks repeated low scores per key and recommends tier escalation with cooldown behavior.

## Structure
| File | Purpose | Main exports |
| --- | --- | --- |
| `intent-router.ts` | Multi-stage intent classification pipeline | `IntentRouter`, `IntentRouterConfig`, `ClassificationResult` |
| `keyword-matcher.ts` | Regex pattern registry and matching helpers | `KeywordMatcher` |
| `llm-classifier.ts` | LLM fallback intent classification | `LLMClassifier` |
| `cost-aware-router.ts` | Complexity-to-tier routing on top of intent classification | `CostAwareRouter`, `CostAwareResult`, `CostAwareRouterConfig`, `ComplexityLevel`, `isSimpleTurn`, `scoreComplexity` |
| `escalation-policy.ts` | Consecutive-low-score tracking and tier escalation recommendation | `ModelTierEscalationPolicy`, `EscalationPolicyConfig`, `EscalationResult` |

## Runtime and Control Flow
Intent classification flow (`IntentRouter.classify`):
1. If `heuristic` exists, call it first. Non-null result returns with `confidence: 'heuristic'`.
2. Call `keywordMatcher.match(text)`. First regex hit returns with `confidence: 'keyword'`.
3. If configured, call `llmClassifier.classify(text)`. Non-null result returns with `confidence: 'llm'`.
4. Return `defaultIntent` with `confidence: 'default'`.

LLM fallback flow (`LLMClassifier.classify`):
1. Fill `promptTemplate` placeholders `{message}` and `{intents}`.
2. Invoke chat model with:
- system message: strict classifier instruction
- human message: rendered prompt
3. Normalize model output to lowercase trimmed string when content is string.
4. Return exact valid intent match if present.
5. Otherwise return first intent whose label is contained in the output.
6. On any invoke/parsing error, return `null`.

Cost-aware routing flow (`CostAwareRouter.classify`):
1. Classify intent via wrapped `IntentRouter`.
2. If intent is in `forceReasoningIntents`, return configured reasoning tier (`routingReason: 'forced'`, `complexity: 'complex'`).
3. Else if intent is in `forceExpensiveIntents`, return configured expensive tier (`routingReason: 'forced'`, `complexity: 'moderate'`).
4. Else compute `scoreComplexity(text, ...)`.
5. Map complexity to tier:
- `simple` -> `cheapTier` and `routingReason: 'simple_turn'`
- `moderate` -> `expensiveTier` and `routingReason: 'complex_turn'`
- `complex` -> `reasoningTier` and `routingReason: 'reasoning_turn'`

Complexity scoring (`scoreComplexity`):
1. Return `simple` if `isSimpleTurn` passes (length/word/single-line/no codeblock/no URL/no complexity keyword).
2. Otherwise count reasoning keywords and line/length signals.
3. Return `complex` when reasoning signals cross thresholds.
4. Return `moderate` for remaining non-simple cases.

Escalation flow (`ModelTierEscalationPolicy.recordScore`):
1. Get/create tracked entry by `key`.
2. If score is at/above threshold, clear streak and return no escalation.
3. Else append low score and keep only last `consecutiveCount` entries.
4. If streak length is below configured count, return no escalation.
5. If current tier is final tier in chain, return no escalation.
6. If cooldown since `lastEscalatedAt` is still active, return no escalation.
7. Recommend next tier, reset streak, set `lastEscalatedAt`, and return escalation.

## Key APIs and Types
`ClassificationResult`:
- `intent: string`
- `confidence: 'heuristic' | 'keyword' | 'llm' | 'default'`

`IntentRouterConfig`:
- `keywordMatcher: KeywordMatcher`
- `llmClassifier?: LLMClassifier`
- `heuristic?: (text: string, context?: Record<string, unknown>) => Promise<string | null>`
- `defaultIntent: string`

`CostAwareRouterConfig`:
- required: `intentRouter: IntentRouter`
- optional thresholds: `maxSimpleChars`, `maxSimpleWords`
- optional forced lists: `forceExpensiveIntents`, `forceReasoningIntents`
- optional tier mapping: `cheapTier`, `expensiveTier`, `reasoningTier`

`CostAwareResult` extends `ClassificationResult`:
- `modelTier: ModelTier`
- `routingReason: 'simple_turn' | 'complex_turn' | 'reasoning_turn' | 'forced'`
- `complexity: 'simple' | 'moderate' | 'complex'`

`EscalationPolicyConfig`:
- `lowScoreThreshold` (default `0.5`)
- `consecutiveCount` (default `3`)
- `cooldownMs` (default `300_000`)
- `tierChain` (default `['chat', 'codegen', 'reasoning']`)

`EscalationResult`:
- `shouldEscalate: boolean`
- `fromTier: ModelTier`
- `toTier: ModelTier`
- `reason: string`
- `consecutiveLowScores: number`

Related shared type:
- `ModelTier` (from `src/llm/model-config.ts`): `'chat' | 'reasoning' | 'codegen' | 'embedding'`

## Dependencies
Direct runtime dependencies in this module:
- `@langchain/core/messages` (`HumanMessage`, `SystemMessage`) in `llm-classifier.ts`
- `@langchain/core/language_models/chat_models` (`BaseChatModel`) in `llm-classifier.ts`

Internal package dependencies:
- `../llm/model-config.js` for `ModelTier`
- intra-module imports among router files

Package metadata context (`packages/core/package.json`):
- `@langchain/core` is listed in both peer deps and dev deps
- `@dzupagent/core` exports router APIs via the root entry and `./orchestration` facade path

## Integration Points
Public exports:
- `src/index.ts` re-exports all router classes/types/utilities.
- `src/facades/orchestration.ts` re-exports the same router surface in the orchestration-focused facade.

Consumption inside `packages/core`:
- `src/skills/workflow-command-parser.ts` accepts optional `intentRouter` and uses `intentRouter.classify(...)` as async fallback in `parseAsync`.

Entrypoint surface implications:
- `src/advanced.ts` mirrors `src/index.ts`, so router APIs are also available from `@dzupagent/core/advanced`.
- `src/stable.ts` exports facades, so router APIs are available via `@dzupagent/core/stable` through facade exports.

## Testing and Observability
Router-specific tests:
- `src/__tests__/cost-aware-router.test.ts` covers:
- `isSimpleTurn` thresholds and exclusions
- `scoreComplexity` simple/moderate/complex behavior
- forced intent precedence
- custom tier mapping
- `src/__tests__/escalation-policy.test.ts` covers:
- threshold reset behavior
- consecutive low-score escalation
- cooldown behavior
- custom config and custom chain
- key isolation, reset, and chain progression

Integration-adjacent test:
- `src/__tests__/workflow-command-parser.test.ts` validates `IntentRouter` fallback behavior in parser async mode.

Observability in this module:
- Router files do not emit metrics/events directly.
- Observability is expected from caller layers (for example event bus/metrics/telemetry modules that consume router outcomes).

## Risks and TODOs
- `KeywordMatcher` uses `RegExp.test` directly. If a caller registers stateful regex (`g` or `y`), repeated matches can drift due to `lastIndex` mutation.
- `LLMClassifier` lowercases LLM output but does not normalize `validIntents`; mixed-case configured intent labels can miss exact-match path.
- `LLMClassifier` swallows all model invocation errors and returns `null`, which simplifies control flow but can hide transient classifier failures from higher layers unless callers instrument separately.
- `IntentRouter` does not catch `heuristic` exceptions; heuristic failures currently propagate and abort classification.
- `ModelTierEscalationPolicy` stores history in-memory (`Map`), so streak and cooldown state resets on process restart.
- `README.md` currently includes router examples that do not match current constructor shape (for example, `IntentRouter({ routes: [...] })`); these examples should be aligned to `IntentRouterConfig`.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

