# @forgeagent/context

Context window engineering for LLM conversations built on LangChain message types.

## Features

- **Message Manager** -- Multi-phase compression pipeline (tool result pruning, orphaned pair repair, structured summarization)
- **Auto-Compress** -- Single-call pipeline integrating all compression phases
- **Context Eviction** -- Head/tail truncation for large content blocks (20K token threshold)
- **System Reminders** -- Periodic re-injection of key instructions (Claude Code-inspired)
- **Completeness Scorer** -- Heuristic evaluation of input description quality (0-1)
- **Prompt Cache** -- Anthropic cache_control breakpoint optimization (75% cost reduction)
- **Frozen Snapshot** -- Freeze context at session start to maximize cache hits

## Install

```bash
npm install @forgeagent/context
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
} from '@forgeagent/context'

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

## Peer Dependencies

| Package | Version |
|---------|---------|
| `@langchain/core` | >= 1.0.0 |
