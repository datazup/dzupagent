# Router Architecture (`packages/core/src/router`)

## Scope
This document describes the router-related code under `packages/core/src/router`:

- `intent-router.ts`
- `keyword-matcher.ts`
- `llm-classifier.ts`
- `cost-aware-router.ts`
- `escalation-policy.ts`

It also covers where this surface is exposed and consumed inside `@dzupagent/core`:

- public exports in `src/index.ts`, `src/llm.ts`, and `src/facades/orchestration.ts`
- tiered entrypoints `src/stable.ts` and `src/advanced.ts`
- internal consumer `src/skills/workflow-command-parser.ts`
- related tests under `src/__tests__`

## Responsibilities
The router layer has two responsibilities:

1. Intent classification pipeline:
- `IntentRouter` runs staged classification in priority order: heuristic, keyword, LLM, default.
- `KeywordMatcher` provides regex-based intent lookup.
- `LLMClassifier` performs model-backed fallback intent classification.

2. Model-tier routing and quality escalation:
- `CostAwareRouter` wraps intent routing and maps input complexity to a `ModelTier`.
- `ModelTierEscalationPolicy` tracks repeated low scores and recommends escalation through a configured tier chain.

## Structure
| File | Purpose | Main exports |
| --- | --- | --- |
| `intent-router.ts` | Staged async intent classification coordinator | `IntentRouter`, `IntentRouterConfig`, `ClassificationResult` |
| `keyword-matcher.ts` | Regex pattern registry and matching utility | `KeywordMatcher` |
| `llm-classifier.ts` | LangChain-chat-model fallback classifier | `LLMClassifier` |
| `cost-aware-router.ts` | Complexity scoring and tier recommendation wrapper around `IntentRouter` | `CostAwareRouter`, `CostAwareRouterConfig`, `CostAwareResult`, `ComplexityLevel`, `isSimpleTurn`, `scoreComplexity` |
| `escalation-policy.ts` | In-memory consecutive-low-score escalation state machine | `ModelTierEscalationPolicy`, `EscalationPolicyConfig`, `EscalationResult` |

## Runtime and Control Flow
`IntentRouter.classify(text, context?)`:

1. If configured, await `heuristic(text, context)`.
2. If heuristic returns an intent string, return with `confidence: 'heuristic'`.
3. Else call `keywordMatcher.match(text)`.
4. If keyword match exists, return with `confidence: 'keyword'`.
5. Else, if configured, await `llmClassifier.classify(text)`.
6. If LLM result exists, return with `confidence: 'llm'`.
7. Else return `defaultIntent` with `confidence: 'default'`.

`LLMClassifier.classify(text)`:

1. Replace `{message}` and `{intents}` placeholders in `promptTemplate`.
2. Invoke the model with:
- a fixed system instruction requiring an intent-only output
- a human message containing the rendered prompt
3. Normalize string content with `trim().toLowerCase()`.
4. Return exact match if present in `validIntents`.
5. Otherwise return the first `validIntent` contained in the response text.
6. Return `null` when no valid match is found or model invocation throws.

`CostAwareRouter.classify(text, context?)`:

1. Call wrapped `intentRouter.classify`.
2. If classified intent is in `forceReasoningIntents`, return `reasoningTier`, `routingReason: 'forced'`, and `complexity: 'complex'`.
3. Else if intent is in `forceExpensiveIntents`, return `expensiveTier`, `routingReason: 'forced'`, and `complexity: 'moderate'`.
4. Else compute complexity via `scoreComplexity`.
5. Map complexity to tier and reason:
- `simple` -> `cheapTier` and `simple_turn`
- `moderate` -> `expensiveTier` and `complex_turn`
- `complex` -> `reasoningTier` and `reasoning_turn`

`scoreComplexity(text, maxSimpleChars, maxSimpleWords)`:

1. Returns `simple` if `isSimpleTurn(...)` passes.
2. Otherwise counts reasoning keywords and inspects message shape.
3. Returns `complex` for strong reasoning signals (`>=2` reasoning keywords, or `>=1` with multiline depth, or very long multiline text).
4. Returns `moderate` for remaining non-simple input.

`ModelTierEscalationPolicy.recordScore(key, score, currentTier)`:

1. Load or initialize tracked state for `key`.
2. If `score >= lowScoreThreshold`, clear low-score streak and return no escalation.
3. Else append score and keep only last `consecutiveCount` entries.
4. If streak length is below `consecutiveCount`, return no escalation.
5. If `currentTier` is missing in chain or already highest, return no escalation.
6. If cooldown is active (`Date.now() - lastEscalatedAt < cooldownMs`), return no escalation.
7. Else escalate to next tier, clear streak, set `lastEscalatedAt`, and return escalation result.

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

- `intentRouter: IntentRouter`
- optional overrides for `maxSimpleChars`, `maxSimpleWords`, `cheapTier`, `expensiveTier`, `reasoningTier`
- optional `forceExpensiveIntents` and `forceReasoningIntents`

Cost-aware defaults in code:

- `maxSimpleChars: 200`
- `maxSimpleWords: 30`
- `cheapTier: 'chat'`
- `expensiveTier: 'codegen'`
- `reasoningTier: 'reasoning'`

`CostAwareResult` extends `ClassificationResult`:

- `modelTier: ModelTier`
- `routingReason: 'simple_turn' | 'complex_turn' | 'reasoning_turn' | 'forced'`
- `complexity: 'simple' | 'moderate' | 'complex'`

`EscalationPolicyConfig` defaults:

- `lowScoreThreshold: 0.5`
- `consecutiveCount: 3`
- `cooldownMs: 300_000`
- `tierChain: ['chat', 'codegen', 'reasoning']`

`EscalationResult`:

- `shouldEscalate: boolean`
- `fromTier: ModelTier`
- `toTier: ModelTier`
- `reason: string`
- `consecutiveLowScores: number`

Shared upstream type:

- `ModelTier` from `src/llm/model-config.ts` is `'chat' | 'reasoning' | 'codegen' | 'embedding'`.

## Dependencies
External packages used directly in this folder:

- `@langchain/core/messages` for `SystemMessage` and `HumanMessage` in `llm-classifier.ts`
- `@langchain/core/language_models/chat_models` for `BaseChatModel` in `llm-classifier.ts`

Internal dependencies:

- `../llm/model-config.js` (`ModelTier`) for cost-aware routing and escalation policy
- composition between local files (`CostAwareRouter` depends on `IntentRouter`; `IntentRouter` depends on `KeywordMatcher` and optional `LLMClassifier`)

Package metadata alignment:

- `packages/core/package.json` declares `@langchain/core` as a peer dependency and dev dependency.
- Router modules do not import `@dzupagent/context` or `@dzupagent/memory` directly.

## Integration Points
Public API surfaces:

- `src/index.ts` exports all router classes, helpers, and related types.
- `src/llm.ts` exports the same router surface within the LLM-focused entrypoint.
- `src/facades/orchestration.ts` re-exports router APIs in the orchestration facade.

Entrypoint propagation:

- `src/advanced.ts` re-exports `src/index.ts`, so router APIs are reachable via `@dzupagent/core/advanced`.
- `src/stable.ts` re-exports `src/facades/index.ts`; router APIs are reachable via `@dzupagent/core/stable` through `orchestration.*`.

Internal runtime consumer:

- `src/skills/workflow-command-parser.ts` optionally accepts `intentRouter` and calls `intentRouter.classify(...)` in `parseAsync` when synchronous parse fails.
- If classification confidence is not `default`, parser converts classified intent into one-step parse success with `confidence: 'llm'`.

## Testing and Observability
Direct router-focused tests:

- `src/__tests__/cost-aware-router.test.ts`
- `src/__tests__/escalation-policy.test.ts`

These currently verify:

- simple/moderate/complex scoring behavior (`isSimpleTurn`, `scoreComplexity`)
- forced intent overrides and precedence (`forceReasoningIntents` over `forceExpensiveIntents`)
- custom model-tier mapping
- escalation threshold logic, cooldown, reset behavior, chain progression, and key isolation

Integration/export coverage involving router APIs:

- `src/__tests__/workflow-command-parser.test.ts` covers async fallback behavior when an `IntentRouter` is injected.
- `src/__tests__/facades.test.ts`, `src/__tests__/facade-orchestration.test.ts`, and `src/__tests__/w15-b1-facades.test.ts` verify facade/entrypoint availability of router APIs.

Current test gap:

- no dedicated unit tests for `keyword-matcher.ts`, `intent-router.ts`, or `llm-classifier.ts` in isolation.

Observability status:

- router classes do not emit metrics/events/logs directly.
- callers must add telemetry around classification results, routing reasons, and escalation outcomes.

## Risks and TODOs
- `KeywordMatcher` uses `RegExp.test`; stateful regex flags (`g`, `y`) can create `lastIndex`-dependent behavior across calls.
- `IntentRouter` does not catch heuristic exceptions; a thrown heuristic aborts classification instead of falling through to keyword/LLM/default.
- `LLMClassifier` lowercases model output but does not normalize `validIntents`; mixed-case intent configuration can prevent exact matches.
- `LLMClassifier` catches all model errors and returns `null`, which avoids hard failures but suppresses error details unless the caller instruments around it.
- `ModelTierEscalationPolicy` stores streak state in an in-memory `Map`; restarts reset history and cooldown state.
- `packages/core/README.md` still contains a stale orchestration example using `new IntentRouter({ routes: [...] })`, which does not match the current `IntentRouterConfig` shape.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: rewritten against current `packages/core/src/router` implementation, package exports, and active tests.