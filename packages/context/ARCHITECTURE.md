# @dzupagent/context Architecture

Last updated: 2026-04-03

This document describes the current implementation in `packages/context/src` and how to use it in real agent pipelines.

## 1. Purpose and Scope

`@dzupagent/context` is a context-window engineering package for long-running LLM conversations built on LangChain message types.

It solves five operational problems:

1. Conversation history grows unbounded and eventually exceeds token budgets.
2. Tool-heavy conversations include large outputs that dominate context.
3. Compression can break tool call/result pairing unless message boundaries are handled carefully.
4. Long sessions drift away from constraints unless key instructions are re-injected.
5. Intent/task switches lose important prior decisions unless context is deliberately transferred.

The package exports independent modules so adopters can use a full pipeline (`autoCompress`) or only specific primitives.

## 2. Runtime Model

Core runtime assumptions:

- Message format: `BaseMessage[]` from `@langchain/core/messages`.
- Summarization model: caller-provided `BaseChatModel` (no built-in model dependency).
- Token estimation: heuristic (`charsPerToken`, default 4) across modules.
- Build target: Node.js 20+, ESM, strict TypeScript.

Primary package entrypoint: `src/index.ts` (re-exports all public APIs).

## 3. Module Architecture

### 3.1 High-level module map

- `message-manager.ts`
- Role: foundational compression primitives and structured summarization.
- `auto-compress.ts`
- Role: orchestration entrypoint for summarize-on-threshold behavior.
- `progressive-compress.ts`
- Role: 5-level compression ladder and budget-based level selection.
- `phase-window.ts`
- Role: phase detection and retention scoring for smarter split points.
- `context-transfer.ts`
- Role: transfer context between task intents.
- `context-eviction.ts`
- Role: head/tail truncation for oversized content blobs.
- `system-reminder.ts`
- Role: periodic reminder injection.
- `prompt-cache.ts`
- Role: Anthropic cache breakpoint annotation.
- `extraction-bridge.ts`
- Role: adapter to plug memory extraction into compression hooks.
- `completeness-scorer.ts`
- Role: heuristic prompt/spec completeness scoring.

### 3.2 Layering

- Foundations: `message-manager`, `context-eviction`, `prompt-cache`, `system-reminder`.
- Policy/heuristics: `phase-window`, `completeness-scorer`, `context-transfer`.
- Orchestration: `auto-compress`, `progressive-compress`.
- Adapters: `extraction-bridge`.

Dependency direction stays inward: orchestrators depend on primitives; primitives do not depend on orchestrators.

## 4. Core Data Contracts

### 4.1 Compression-related

- `MessageManagerConfig`
- Key defaults:
- `maxMessages: 30`
- `keepRecentMessages: 10`
- `maxMessageTokens: 12000`
- `charsPerToken: 4`
- `preserveRecentToolResults: 6`
- `prunedToolResultMaxChars: 120`

- `AutoCompressConfig`
- Extends `MessageManagerConfig`.
- Adds `onBeforeSummarize` hook and `frozenSnapshot?: boolean` flag.

- `ProgressiveCompressConfig`
- Controls level-specific knobs (keep counts, AI trim length, hook, estimator).

### 4.2 Transfer-related

- `IntentContext`
- Contains summary, decisions, relevant files, working state, transfer metadata.

- `IntentRelevanceRule`
- Defines source->target intent matching, scope, priority.

### 4.3 Reminder/Eviction

- `SystemReminderConfig`
- Interval and conditional reminder blocks.

- `EvictionConfig`
- Token threshold and head/tail line counts.

## 5. Compression Pipeline (Current Behavior)

### 5.1 Trigger decision

`shouldSummarize(messages, config)` returns true when either:

- `messages.length > maxMessages`, or
- estimated tokens exceed `maxMessageTokens`.

### 5.2 Multi-phase summarize path (`summarizeAndTrim`)

1. Tool result pruning (`pruneToolResults`)
- Keeps only recent tool messages intact.
- Replaces older tool outputs with a short placeholder preview.

2. Boundary alignment
- Chooses split point near `keepRecentMessages`, then adjusts backward to avoid splitting inside tool groups.

3. Orphan repair on retained side (`repairOrphanedToolPairs`)
- Removes tool results with no matching tool call.
- Inserts stub tool results for unanswered tool calls.

4. Structured LLM summarization
- Uses a fixed markdown template with sections:
- Goal, Constraints, Progress (Done/In Progress/Blocked), Key Decisions, Relevant Files, Next Steps.
- If an existing summary exists, prompt requests incremental update.

5. Fallback behavior
- On LLM failure, returns trimmed messages and keeps prior summary (or empty string).

### 5.3 Orchestrated entrypoint (`autoCompress`)

`autoCompress` wraps trigger + summarize path and returns:

- `messages`: possibly reduced list
- `summary`: updated summary
- `compressed`: boolean

Hook behavior:

- `onBeforeSummarize` receives old messages about to be summarized away.
- Hook errors are swallowed to keep compression non-fatal.

## 6. Progressive Compression (Levels 0-4)

`compressToLevel` implements graduated compression:

- Level 0: no changes.
- Level 1: prune old tool outputs + orphan repair.
- Level 2: Level 1 + trim long AI text responses.
- Level 3: Level 2 + structured summarization (`summarizeAndTrim`).
- Level 4: ultra mode (keep only last N messages, truncate long summary).

Helper APIs:

- `selectCompressionLevel(messages, tokenBudget)`
- heuristic mapping from estimated token pressure to level.

- `compressToBudget(...)`
- chooses level using the heuristic and executes `compressToLevel`.

## 7. Phase-aware Retention

`PhaseAwareWindowManager` improves which messages are preserved by detecting conversation phase and scoring each message.

Phases:

- `planning`
- `coding`
- `debugging`
- `reviewing`
- `general` (fallback)

Scoring components:

- base score by type (`system > human > ai > tool` by default)
- recency bonus
- phase priority type bonus
- content heuristics (code blocks, file paths, error indicators, ultra-short penalty)
- phase multiplier

`findRetentionSplit(messages, targetKeep)`:

- walks backward keeping high-value messages,
- stops at low-score boundaries,
- enforces tool-call boundary safety.

Note: this manager is exported as a reusable policy component; compression orchestrators do not automatically call it.

## 8. Context Transfer Across Intents

`ContextTransferService` supports switching tasks without losing critical context.

Pipeline:

1. Extract (`extractContext`)
- Summary from recent conversational messages.
- Decision sentence extraction via regex patterns.
- File path extraction via regex.
- Optional working-state capture.

2. Evaluate relevance (`isRelevant` + `getTransferScope`)
- Uses ordered rules with priority.
- Built-in defaults include pairs like plan->implement, implement->debug, etc.

3. Format and budget (`formatAsMessage`)
- Generates a `SystemMessage` markdown block.
- Applies max transfer token budget via truncation.

4. Inject (`injectContext`)
- Inserts after the first system message, or at index 0 when none exists.

5. One-call pipeline (`transfer`)
- extract + relevance check + injection.

Transfer scopes:

- `all`
- `decisions-only`
- `files-only`
- `summary-only`

## 9. Prompt Cache Utilities (Anthropic)

Two APIs are provided:

- `applyAnthropicCacheControl(system, messages)` for Anthropic-native payloads.
- `applyCacheBreakpoints(messages)` for LangChain `BaseMessage[]`.

Strategy implemented:

- mark system prompt with cache metadata,
- mark last 3 non-system messages.

This is designed for rolling-window cache reuse on multi-turn conversations.

## 10. Other Utilities

### 10.1 Large content eviction

`evictIfNeeded(content, identifier, config)`:

- when content exceeds threshold, returns a structured preview:
- first `headLines`,
- omission marker,
- last `tailLines`,
- hint for targeted `read_file` retrieval.

### 10.2 System reminder injector

`SystemReminderInjector`:

- `tick(state?)` returns reminder text at configured interval,
- supports conditional reminder blocks,
- `forceReminder` for immediate injection,
- `reset` for lifecycle boundaries (for example after compression).

### 10.3 Extraction bridge

`createExtractionHook(extractFn, options)`:

- creates an `onBeforeSummarize` hook,
- filters message types (default human + ai),
- keeps only last N eligible messages (default 20),
- calls external extraction side effect.

### 10.4 Completeness scorer

`scoreCompleteness(input)` returns:

- `score` (0..1),
- `maxQuestions` heuristic for clarification strategy,
- human-readable reasoning list.

## 11. How to Use the Package

### 11.1 Typical agent-loop integration (auto compression)

```ts
import { autoCompress, formatSummaryContext } from '@dzupagent/context'
import { SystemMessage } from '@langchain/core/messages'

const result = await autoCompress(messages, summary, cheapModel, {
  maxMessages: 30,
  keepRecentMessages: 10,
  onBeforeSummarize: async (oldMessages) => {
    // optional extraction before messages are summarized away
    await memoryExtractor(oldMessages)
  },
})

messages = result.messages
summary = result.summary

if (summary) {
  const summaryPrefix = formatSummaryContext(summary)
  messages = [new SystemMessage(summaryPrefix), ...messages]
}
```

### 11.2 Memory extraction bridge

```ts
import { autoCompress, createExtractionHook } from '@dzupagent/context'

const onBeforeSummarize = createExtractionHook(async (msgs) => {
  await memoryService.extractObservations(msgs)
}, {
  maxMessages: 20,
  messageTypes: ['human', 'ai'],
})

await autoCompress(messages, summary, model, { onBeforeSummarize })
```

### 11.3 Budget-oriented compression

```ts
import { compressToBudget } from '@dzupagent/context'

const compressed = await compressToBudget(
  messages,
  6000,            // target token budget
  summary,
  model,
  {
    keepRecentLevel3: 10,
    keepRecentLevel4: 3,
    aiResponseMaxChars: 500,
  },
)

messages = compressed.messages
summary = compressed.summary
```

### 11.4 Phase-aware split policy (manual integration)

```ts
import { PhaseAwareWindowManager, summarizeAndTrim } from '@dzupagent/context'

const manager = new PhaseAwareWindowManager()
const split = manager.findRetentionSplit(messages, 10)

const oldMessages = messages.slice(0, split)
const keepMessages = messages.slice(split)

if (oldMessages.length > 0) {
  const merged = [...oldMessages, ...keepMessages]
  const result = await summarizeAndTrim(merged, summary, model, {
    keepRecentMessages: keepMessages.length,
  })
  messages = result.trimmedMessages
  summary = result.summary
}
```

### 11.5 Intent transfer between sessions/tasks

```ts
import { ContextTransferService } from '@dzupagent/context'

const transfer = new ContextTransferService({
  maxTransferTokens: 2000,
})

const nextMessages = transfer.transfer(
  previousIntentMessages,
  'implement_auth',
  currentMessages,
  'debug_auth',
  { branch: 'feature/auth', step: 'repro' },
)

messages = nextMessages ?? currentMessages
```

### 11.6 Anthropic prompt cache annotations

```ts
import { applyCacheBreakpoints } from '@dzupagent/context'

const cacheReady = applyCacheBreakpoints(messages)
// send cacheReady to ChatAnthropic
```

### 11.7 Oversized file/content eviction

```ts
import { evictIfNeeded } from '@dzupagent/context'

const { content, evicted } = evictIfNeeded(fileContent, 'src/big-file.ts', {
  tokenThreshold: 20000,
  headLines: 50,
  tailLines: 20,
})

const safeContent = content
```

### 11.8 Reminder injection in long sessions

```ts
import { SystemReminderInjector } from '@dzupagent/context'

const reminders = new SystemReminderInjector({
  intervalMessages: 15,
  reminders: [
    { id: 'rules', content: 'TypeScript strict, no any, ESM modules.' },
    {
      id: 'task',
      content: 'Stay focused on parser refactor and compatibility.',
      condition: (state) => state.phase === 'coding',
    },
  ],
})

const reminder = reminders.tick({ phase: 'coding' })
if (reminder) {
  // append as a high-priority instruction message
}
```

## 12. Behavior Guarantees and Edge Cases

Verified by tests under `src/__tests__`:

- Compression and transfer paths are extensively covered.
- Tool call/result integrity is actively repaired.
- LLM and hook failures are non-fatal in compression flows.
- Context transfer supports both regex and exact-match relevance rules.
- Prompt cache helpers avoid mutating original messages.
- Frozen snapshot class lifecycle (`freeze/get/isActive/thaw`) is covered.

Operational caveats to account for in callers:

- Token estimates are heuristic, not tokenizer-exact.
- `compressToBudget` chooses a heuristic level; callers needing strict fit should post-check token usage.
- `AutoCompressConfig.frozenSnapshot` is part of config surface, while actual snapshot behavior is provided via `FrozenSnapshot` class usage by caller code.

## 13. Feature-to-Test Coverage Map

This section maps each implemented feature to the tests that currently validate it.

### 13.1 Coverage matrix

| Feature / API | Primary Tests | What Is Verified |
|---|---|---|
| Summarization trigger logic (`shouldSummarize`) | `src/__tests__/message-manager.test.ts` (`describe('shouldSummarize')`) | message-count and token-threshold triggering, custom config overrides, empty/non-string content handling |
| Tool result pruning (`pruneToolResults`) | `src/__tests__/message-manager.test.ts` (`describe('pruneToolResults')`) | pruning window behavior, placeholder shape, truncation behavior, tool metadata preservation |
| Tool pair integrity repair (`repairOrphanedToolPairs`) | `src/__tests__/message-manager.test.ts` (`describe('repairOrphanedToolPairs')`) | orphan removal, stub insertion for unanswered calls, multi-call handling, duplicate-stub prevention |
| Structured compression (`summarizeAndTrim`, `formatSummaryContext`) | `src/__tests__/message-manager.test.ts` (`describe('summarizeAndTrim')`, `describe('formatSummaryContext')`) | split/trim behavior, update-vs-fresh prompts, LLM failure fallback, summary context formatting |
| Orchestrated auto compression (`autoCompress`) | `src/__tests__/auto-compress-extended.test.ts` (`describe('autoCompress')`) | threshold-triggered compression, hook invocation semantics, fallback behavior on hook/model failure, custom keep/threshold config |
| Frozen context snapshot (`FrozenSnapshot`) | `src/__tests__/auto-compress-extended.test.ts` (`describe('FrozenSnapshot')`), `src/__tests__/context.integration.test.ts` | freeze/thaw lifecycle and state transitions |
| Progressive level compression (`compressToLevel`) | `src/__tests__/progressive-compress.test.ts` (`describe('compressToLevel')`) | level 0-4 behavior, LLM fallback, AI trimming behavior, hook paths, summary truncation at level 4 |
| Budget-based level selection (`selectCompressionLevel`, `compressToBudget`) | `src/__tests__/progressive-compress.test.ts` (`describe('selectCompressionLevel')`, `describe('compressToBudget')`) | heuristic level selection and config pass-through |
| Phase-aware retention (`PhaseAwareWindowManager`) | `src/__tests__/phase-window.test.ts` | phase detection, message scoring, boundary-safe retention split, custom phase config overrides |
| Intent transfer (`ContextTransferService`) | `src/__tests__/context-transfer.test.ts`, `src/__tests__/context-transfer-extended.test.ts` | extraction of summary/decisions/files, rule matching/priority, scope filtering, token-budget truncation, injection ordering, transfer pipeline |
| Anthropic cache annotations (`applyAnthropicCacheControl`, `applyCacheBreakpoints`) | `src/__tests__/prompt-cache-extended.test.ts` | system + rolling message marking, non-mutation, breakpoints behavior on different message shapes |
| Reminder injection (`SystemReminderInjector`) | `src/__tests__/system-reminder.test.ts` | interval behavior, conditional reminders, reset/force behavior, custom tag support |
| Cross-module integration path | `src/__tests__/context.integration.test.ts` | coordination of phase detection, pruning, compression, and snapshot flow |

### 13.2 Current low-coverage utilities

The following exported utilities currently have little or no direct dedicated test coverage:

- `src/context-eviction.ts` (`evictIfNeeded`)
- `src/extraction-bridge.ts` (`createExtractionHook`)
- `src/completeness-scorer.ts` (`scoreCompleteness`)

For feature updates touching these modules, add or extend tests in `src/__tests__` before merging.

### 13.3 Feature update test checklist

When updating a feature, run these focused tests first:

1. Message manager/compression core changes:
- `yarn workspace @dzupagent/context test src/__tests__/message-manager.test.ts`

2. Auto compression changes:
- `yarn workspace @dzupagent/context test src/__tests__/auto-compress-extended.test.ts`

3. Progressive compression or budget policy changes:
- `yarn workspace @dzupagent/context test src/__tests__/progressive-compress.test.ts`

4. Phase retention policy changes:
- `yarn workspace @dzupagent/context test src/__tests__/phase-window.test.ts`

5. Context transfer changes:
- `yarn workspace @dzupagent/context test src/__tests__/context-transfer.test.ts src/__tests__/context-transfer-extended.test.ts`

6. Prompt cache behavior changes:
- `yarn workspace @dzupagent/context test src/__tests__/prompt-cache-extended.test.ts`

7. Reminder behavior changes:
- `yarn workspace @dzupagent/context test src/__tests__/system-reminder.test.ts`

8. Cross-module behavior changes:
- `yarn workspace @dzupagent/context test src/__tests__/context.integration.test.ts`

For release-level confidence after any multi-module change:

- `yarn workspace @dzupagent/context test`
- `yarn workspace @dzupagent/context typecheck`
- `yarn workspace @dzupagent/context lint`

## 14. Testing and Quality Signals

Vitest configuration in `packages/context/vitest.config.ts`:

- Node test environment
- V8 coverage provider
- include: `src/**/*.test.ts`, `src/**/*.spec.ts`
- coverage thresholds: statements 60, lines 60, branches 50, functions 50

## 15. Recommended Integration Order

For new adopters, implement in this order:

1. Start with `autoCompress` + `formatSummaryContext`.
2. Add `createExtractionHook` if you persist memories.
3. Add `applyCacheBreakpoints` for Anthropic deployments.
4. Add `ContextTransferService` if your app has explicit intent/task transitions.
5. Add `PhaseAwareWindowManager` and progressive compression only if you need finer retention policy control.
