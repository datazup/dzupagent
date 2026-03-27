# 04 — Conversation Management

> **Agent:** langchain-ts-expert
> **Priority:** P0
> **Depends on:** 01-ARCHITECTURE
> **Effort:** 4h

---

## 1. Current State Assessment

### What Works

The message manager is now in `@dzipagent/context` (`src/message-manager.ts`) and implements:
- `shouldSummarize()`: Triggers when messages > 30 OR estimated tokens > 12K
- `summarizeAndTrim()`: Multi-phase compression (tool result pruning → orphaned pair repair → boundary alignment → LLM summarization)
- `pruneToolResults()`: Cheap preprocessing pass replacing stale tool outputs with placeholders
- `repairOrphanedToolPairs()`: Fixes unpaired tool_call/tool_result messages
- `formatSummaryContext()`: Formats summary for system prompt injection
- `autoCompress()` (in `auto-compress.ts`): Single-call pipeline integrating all phases

### What's Missing

1. **No per-node message filtering**: Every node receives the FULL message array. The `generate_backend` node sees all intake/clarify messages even though they're irrelevant to code generation
2. **No phase-aware context windowing**: Different phases need different amounts of history
3. **Summary quality is uncontrolled**: The summary prompt is generic — no structure for extracting specific categories of decisions
4. **No token counting integration**: Uses char/4 estimation instead of actual tokenizer
5. **No system message deduplication**: Each node prepends a new SystemMessage but doesn't remove old ones
6. **No RemoveMessage usage**: LangGraph's `RemoveMessage` primitive is not used anywhere

## 2. Enhanced Conversation Management Architecture

### 2.1 Phase-Aware Message Windowing

Different phases need different context:

```
PHASE           | NEEDS HISTORY FROM          | MAX MESSAGES | KEY CONTEXT
────────────────┼─────────────────────────────┼──────────────┼─────────────────────
intake          | User's initial request      | 5            | Description, intent
clarify         | Intake + user description   | 10           | Full Q&A interaction
plan            | Summary + clarify answers   | 15           | All decisions so far
generate_db     | Plan only                   | 5            | Feature plan, tech stack
generate_backend| Plan + DB schema            | 8            | Plan, generated models
generate_frontend| Plan + API contract        | 8            | Plan, API contract, types
generate_tests  | Plan + all generated code   | 8            | Full VFS context
run_tests       | Test results only           | 5            | Test execution output
validate        | Latest test + gen results   | 5            | Quality metrics
fix             | Validation errors + context | 10           | Error details, prior fixes
review          | Summary + quality           | 10           | Full outcome summary
publish         | Approval message            | 3            | Just the approval
```

### 2.2 Implementation: Phase-Aware Trimming

```typescript
// Phase-aware extension (app-level, builds on @dzipagent/context primitives)

/**
 * Phase-specific message window sizes.
 * Each phase keeps only the messages relevant to its task.
 */
const PHASE_WINDOW_SIZES: Record<string, number> = {
  intake: 5,
  clarify: 10,
  plan: 15,
  generate_db: 5,
  generate_backend: 8,
  generate_frontend: 8,
  generate_tests: 8,
  run_tests: 5,
  validate: 5,
  fix: 10,
  review: 10,
  publish: 3,
}

/**
 * Get the appropriate message window for a phase.
 * Returns trimmed messages with summary of earlier context.
 *
 * Unlike shouldSummarize/summarizeAndTrim (which are reactive),
 * this is proactive — called at the START of each node to ensure
 * the LLM only sees relevant context.
 */
export function getPhaseMessages(
  messages: BaseMessage[],
  phase: string,
  conversationSummary: string,
): BaseMessage[] {
  const windowSize = PHASE_WINDOW_SIZES[phase] ?? 10

  if (messages.length <= windowSize) {
    return messages
  }

  // Keep only the last N messages for this phase
  const windowed = messages.slice(-windowSize)

  // If we have a conversation summary, it's already in the system prompt
  // via formatSummaryContext() — no need to inject it into messages
  return windowed
}

/**
 * Structured summary extraction — produces sections that can be
 * selectively included in different phase prompts.
 */
export interface StructuredSummary {
  /** Decisions made during conversation */
  decisions: string
  /** User preferences and choices */
  preferences: string
  /** Technical context (tech stack, architecture) */
  technicalContext: string
  /** Errors encountered and how they were resolved */
  errorHistory: string
  /** Full text summary (for phases that need everything) */
  fullSummary: string
}

/**
 * Enhanced summarization that produces structured sections.
 * Each section can be independently injected into phase-specific prompts.
 */
export async function summarizeStructured(
  messages: BaseMessage[],
  existingSummary: string,
): Promise<StructuredSummary> {
  const model = getChatModel()

  const prompt = `Analyze the conversation and extract information into these exact sections.
${existingSummary ? `\nExisting summary to extend:\n"${existingSummary}"` : ''}

Output ONLY a JSON object with these keys:
{
  "decisions": "Architecture and design decisions made (API patterns, DB schema choices, auth strategy, etc.)",
  "preferences": "User's stated preferences (tech stack, code style, naming conventions)",
  "technicalContext": "Technical details needed for code generation (models, endpoints, types, dependencies)",
  "errorHistory": "Any errors encountered and how they were resolved",
  "fullSummary": "Complete 2-3 sentence summary of the conversation"
}

Be concise — each field should be 1-3 sentences max.`

  try {
    const response = await model.invoke([
      ...messages,
      new HumanMessage(prompt),
    ])

    const content = typeof response.content === 'string' ? response.content : ''
    const parsed = parseJsonBlock<StructuredSummary>(content)

    if (parsed && typeof parsed.fullSummary === 'string') {
      return parsed
    }
  } catch {
    // Fallback to unstructured
  }

  // Fallback: use existing summarization
  const { summary } = await summarizeAndTrim(messages, existingSummary)
  return {
    decisions: '',
    preferences: '',
    technicalContext: '',
    errorHistory: '',
    fullSummary: summary,
  }
}
```

### 2.3 System Message Deduplication

Each node currently prepends a fresh `SystemMessage`. Over multiple tool-call loops, this creates duplicate system messages in the history.

```typescript
/**
 * Build the message array for an LLM call.
 * Ensures only ONE system message (the latest) and phase-appropriate
 * message history.
 */
export function buildNodeMessages(
  systemContent: string,
  messages: BaseMessage[],
  phase: string,
  conversationSummary: string,
): BaseMessage[] {
  // Filter out all existing system messages (they're stale)
  const nonSystem = messages.filter(m => m._getType() !== 'system')

  // Apply phase-specific windowing
  const windowed = getPhaseMessages(nonSystem, phase, conversationSummary)

  // Single fresh system message + windowed history
  return [new SystemMessage(systemContent), ...windowed]
}
```

### 2.4 Integration with Graph Nodes

Each node currently does:
```typescript
const response = await model.invoke([
  new SystemMessage(systemContent),
  ...state.messages,
])
```

Should become:
```typescript
const response = await model.invoke(
  buildNodeMessages(systemContent, state.messages, 'generate_backend', state.conversationSummary)
)
```

## 3. Token Budget Integration

### 3.1 Accurate Token Counting

Replace char/4 estimation with actual tokenizer:

```typescript
import { encodingForModel } from '@langchain/core/utils/tiktoken'

/**
 * Count tokens accurately using the model's tokenizer.
 * Falls back to char/4 if tokenizer unavailable.
 */
export function countMessageTokens(messages: BaseMessage[]): number {
  try {
    const encoding = encodingForModel('claude-sonnet-4-6')
    let total = 0
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      total += encoding.encode(content).length
      total += 4  // Message overhead (role, formatting)
    }
    return total
  } catch {
    // Fallback to estimation
    return messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      return sum + Math.ceil(content.length / 4)
    }, 0)
  }
}
```

### 3.2 Dynamic Budget Allocation

Different models have different context windows. The message budget should adapt:

```typescript
/**
 * Context window budgets per model tier.
 * Reserves space for system prompt (~4K) and generation output (~8K).
 */
const MODEL_MESSAGE_BUDGETS: Record<string, number> = {
  'haiku': 12_000,    // 200K context, but keep messages lean
  'sonnet': 24_000,   // 200K context, more room for context
  'opus': 40_000,     // 200K context, can handle more
  'default': 16_000,
}

export function getMessageBudget(modelTier: string): number {
  return MODEL_MESSAGE_BUDGETS[modelTier] ?? MODEL_MESSAGE_BUDGETS['default']!
}
```

## 4. Summarization Triggers

### 4.1 Current Triggers (Keep)

- Message count > 30
- Estimated tokens > 12K

### 4.2 New Triggers (Add)

```typescript
export function shouldSummarize(
  messages: BaseMessage[],
  phase: string,
): boolean {
  // Original triggers
  if (messages.length > MAX_MESSAGES_BEFORE_SUMMARY) return true

  const tokens = countMessageTokens(messages)
  if (tokens > MAX_MESSAGE_TOKENS) return true

  // NEW: Phase transition trigger
  // Summarize when moving from conversational phase (intake/clarify)
  // to generation phase — the conversation context needs compression
  const isPhaseTransition =
    phase === 'plan' && messages.length > 15

  if (isPhaseTransition) return true

  return false
}
```

### 4.3 Where Summarization Runs

Currently: `plan()` and `review()` nodes.

Add: After `clarify()` completes (before entering plan), this is the natural boundary where conversational context should be compressed.

```typescript
// In clarify node, when advancing to plan:
const nextPhase = hasAnswers || questions.length === 0 ? 'plan' : 'clarify'

if (nextPhase === 'plan' && shouldSummarize(state.messages, 'plan')) {
  const structured = await summarizeStructured(
    state.messages, state.conversationSummary,
  )
  return {
    messages: [response],
    conversationSummary: structured.fullSummary,
    // Store structured summary for phase-specific injection
    structuredSummary: structured,
    phase: nextPhase,
  }
}
```

## 5. Context Compaction Pattern (from Claude Code)

Claude Code implements "context compaction" that auto-triggers at 95% context capacity. Our equivalent:

```typescript
/**
 * Emergency compaction — triggered when total context would exceed model limit.
 * More aggressive than normal summarization: keeps only 5 messages + structured summary.
 */
export async function emergencyCompact(
  messages: BaseMessage[],
  conversationSummary: string,
): Promise<{ summary: string; messages: BaseMessage[] }> {
  // Keep only the last 5 messages
  const kept = messages.slice(-5)

  // Force summarize everything else
  const toSummarize = messages.slice(0, -5)
  if (toSummarize.length === 0) {
    return { summary: conversationSummary, messages: kept }
  }

  const structured = await summarizeStructured(toSummarize, conversationSummary)

  return {
    summary: structured.fullSummary,
    messages: kept,
  }
}
```

## 6. State Changes

### 6.1 New State Field

```typescript
// Add to FeatureGeneratorAnnotation:
structuredSummary: Annotation<StructuredSummary | null>({
  reducer: (_, next) => next,
  default: () => null,
}),
```

### 6.2 Enhanced formatSummaryContext

```typescript
/**
 * Phase-aware summary formatting.
 * Different phases get different sections of the structured summary.
 */
export function formatSummaryForPhase(
  summary: StructuredSummary | null,
  phase: string,
  fallback: string,
): string {
  if (!summary) return fallback ? formatSummaryContext(fallback) : ''

  switch (phase) {
    case 'generate_db':
    case 'generate_backend':
    case 'generate_frontend':
      // Code generation needs technical context + decisions, not full history
      return [
        summary.decisions && `## Architecture Decisions\n${summary.decisions}`,
        summary.technicalContext && `## Technical Context\n${summary.technicalContext}`,
        summary.preferences && `## User Preferences\n${summary.preferences}`,
      ].filter(Boolean).join('\n\n')

    case 'fix':
      // Fix needs error history + technical context
      return [
        summary.errorHistory && `## Previous Error History\n${summary.errorHistory}`,
        summary.technicalContext && `## Technical Context\n${summary.technicalContext}`,
      ].filter(Boolean).join('\n\n')

    case 'review':
    case 'publish':
      // Review needs full summary
      return `## Conversation Summary\n${summary.fullSummary}`

    default:
      return formatSummaryContext(summary.fullSummary)
  }
}
```

## 7. Acceptance Criteria

- [ ] Phase-aware message windowing reduces token usage by 40-60% in generation nodes
- [ ] Structured summarization produces parseable JSON with 5 sections
- [ ] System message deduplication eliminates stale system prompts
- [ ] Token counting uses actual tokenizer (with char/4 fallback)
- [ ] Summarization triggers at phase transitions (clarify → plan)
- [ ] Emergency compaction handles context overflow gracefully
- [ ] All changes are backward-compatible (existing graphs continue working)
- [ ] buildNodeMessages() is used in all 12 nodes
