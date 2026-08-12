# @dzupagent/context

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Experimental | **Coverage:** N/A | **Exports:** 29

| Metric | Value |
|--------|-------|
| Source Files | 11 |
| Lines of Code | 3,602 |
| Test Files | 4 |
| Internal Dependencies | None |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @dzupagent/context
```
<!-- AUTO-GENERATED-END -->

Context window engineering for LLM conversations built on LangChain message types.

## Features

- **Message Manager** -- Multi-phase compression pipeline (tool result pruning, orphaned pair repair, structured summarization)
- **Pre-Summary Handoff** -- Canonical `onBeforeSummarize` hook receives the exact messages being replaced for non-fatal memory-candidate extraction
- **Auto-Compress** -- Single-call pipeline integrating all compression phases
- **Context Eviction** -- Head/tail truncation for large content blocks (20K token threshold)
- **System Reminders** -- Periodic re-injection of key instructions (Claude Code-inspired)
- **Completeness Scorer** -- Heuristic evaluation of input description quality (0-1)
- **Prompt Cache** -- Anthropic cache_control breakpoint optimization (75% cost reduction)
- **Frozen Snapshot** -- Freeze context at session start to maximize cache hits
- **Completed Tool Compaction** -- Opt-in pairing-safe replacement of old completed tool outputs with truthful token-reclamation evidence

## Install

```bash
npm install @dzupagent/context
# peer deps
npm install @langchain/core
```

## Quick Start

```typescript
import {
  autoCompress,
  SystemReminderInjector,
  evictIfNeeded,
  applyCacheBreakpoints,
} from '@dzupagent/context'

// Auto-compress when conversation grows too long
const { messages, summary, compressed } = await autoCompress(
  conversationMessages,
  existingSummary,
  cheapModel,
  { maxMessages: 30, keepRecentMessages: 10 },
)

// Periodic instruction reminders
const injector = new SystemReminderInjector({
  intervalMessages: 15,
  reminders: [
    { id: 'rules', content: 'TypeScript strict, no any, ESM modules' },
  ],
})
const reminder = injector.tick() // returns string | null

// Evict large file contents
const { content, evicted } = evictIfNeeded(largeFileContent, 'schema.prisma')

// Anthropic prompt cache optimization
const cachedMessages = applyCacheBreakpoints(messages)
```

The same hook is available on `MessageManagerConfig`, including through
`DzupAgentConfig.messageConfig`:

```typescript
const messageConfig = {
  onBeforeSummarize: async (oldMessages) => {
    await observationalMemory.observe(oldMessages)
  },
}
```

Treat the model-written rolling summary as short-term context. Promote durable
facts through an explicit memory write or candidate workflow.

For a provider-free pass that reclaims completed tool output before model
summarization, use the narrow subpath:

```typescript
import { compactCompletedToolResults } from '@dzupagent/context/tool-results'

const result = compactCompletedToolResults(messages, {
  schema: 'datazup.context.completed-tool-compaction-profile/v1',
  preserveRecentCompletedPairs: 4,
  minimumResultTokens: 128,
  maxCompactedResults: 16,
  measurement: 'require-tokenizer',
}, { tokenCounter, model: 'gpt-5' })
```

Only contiguous, uniquely paired, fully completed call/result groups are
eligible. Incomplete groups remain intact; orphaned, duplicate, or reordered
results reject the operation without changing the transcript. Replacement
messages preserve tool identity and metadata, remove all output previews, and
report measured before, after, and reclaimed token counts. The default context
root remains unchanged.

The context package also runs the reusable provider-free memory compaction
conformance suite against this concrete implementation. Its adapter and
invented transcripts are test-only: they do not add a context runtime export,
transfer transcript custody to the memory package, or imply live-provider or
production qualification.

For hosts that require the versioned structured-summary contract, enable
fail-closed section validation:

```typescript
const messageConfig = {
  summaryValidation: 'required',
  summaryModelId: 'summary-model-v1',
  eventBus,
}
```

`summarizeAndTrim()` then returns `summaryMetadata` with the prompt version,
model ID, source-message count, and validation result. The validator accepts
normal Markdown heading variation rather than exact JSON or a fixed heading
level. If required sections are missing, the prior summary is preserved and a
non-fatal `context:summary_validation_failed` event is emitted. Validation is
opt-in so existing unstructured-summary consumers keep their current behavior.

## Peer Dependencies

| Package | Version |
|---------|---------|
| `@langchain/core` | >= 1.0.0 |
