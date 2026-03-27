# 08 — Memory Consolidation & Quality Management

> **Agent:** system-architect
> **Priority:** P2
> **Depends on:** 01-ARCHITECTURE, 03-STORE-INTEGRATION
> **Effort:** 6h

---

## 1. Problem Statement

Memory accumulates indefinitely. After 100 feature generations, a tenant might have:
- 50+ generation lessons (many duplicates or contradictory)
- 100+ project decisions (some from abandoned features)
- 30+ API conventions (inconsistent patterns from different time periods)
- Hundreds of session summaries (mostly noise)

Without consolidation:
- Semantic search returns stale/irrelevant results
- Token budget is wasted on redundant memory context
- Contradictory lessons confuse the LLM ("Use bcrypt" vs "Use Argon2id")
- Memory grows unbounded, degrading search performance

### Inspiration: Claude Code's Dream Consolidation

Claude Code uses a 4-phase consolidation process:
1. **Orient** — Understand current memory state
2. **Gather** — Collect all memories for analysis
3. **Consolidate** — Merge duplicates, resolve conflicts, extract wisdom
4. **Prune** — Remove stale, redundant, or low-quality entries

## 2. Consolidation Architecture

### 2.1 Consolidation Pipeline

```
┌──────────────────────────────────────────────────────┐
│  CONSOLIDATION PIPELINE (runs periodically)           │
│                                                       │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐         │
│  │  Gather   │──▶│ Analyze  │──▶│ Merge    │         │
│  │          │   │          │   │          │         │
│  │ Load all │   │ Group by │   │ Deduplicate│        │
│  │ lessons  │   │ category │   │ Resolve  │         │
│  │ for ns   │   │ + topic  │   │ conflicts│         │
│  └──────────┘   └──────────┘   └──────────┘         │
│                                       │               │
│                                       ▼               │
│                                ┌──────────┐          │
│                                │  Score   │          │
│                                │         │          │
│                                │ Quality │          │
│                                │ relevance│         │
│                                │ recency  │         │
│                                └──────────┘          │
│                                       │               │
│                                       ▼               │
│                                ┌──────────┐          │
│                                │  Write   │          │
│                                │         │          │
│                                │ Pruned  │          │
│                                │ merged  │          │
│                                │ entries │          │
│                                └──────────┘          │
└──────────────────────────────────────────────────────┘
```

### 2.2 Consolidation Service

```typescript
// apps/api/src/services/agent/utils/memory-consolidation.service.ts

import type { BaseStore, Item } from '@langchain/langgraph'
import { getChatModel } from '../llm.js'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import { logger } from '../../../utils/logger.js'

interface ConsolidationResult {
  namespace: string
  before: number
  after: number
  merged: number
  pruned: number
  conflicts: string[]
}

export const memoryConsolidationService = {
  /**
   * Consolidate lessons for a tenant.
   * Groups by category, deduplicates similar lessons, resolves conflicts,
   * and produces a curated set of "wisdom" entries.
   */
  async consolidateLessons(
    store: BaseStore,
    tenantId: string,
  ): Promise<ConsolidationResult> {
    // 1. GATHER — Load all lessons
    const allLessons = await store.search(
      [tenantId, 'lessons'],
      { limit: 200 },
    )

    if (allLessons.length < 10) {
      // Not enough lessons to justify consolidation
      return { namespace: 'lessons', before: allLessons.length, after: allLessons.length, merged: 0, pruned: 0, conflicts: [] }
    }

    // 2. ANALYZE — Group by category
    const grouped = new Map<string, Item[]>()
    for (const item of allLessons) {
      const category = (item.value as Record<string, unknown>)['category'] as string ?? 'general'
      const existing = grouped.get(category) ?? []
      existing.push(item)
      grouped.set(category, existing)
    }

    // 3. CONSOLIDATE — Use LLM to merge each category
    const model = getChatModel()
    const consolidated: Array<{ key: string; value: Record<string, unknown> }> = []
    const conflicts: string[] = []

    for (const [category, items] of grouped) {
      if (items.length < 3) {
        // Keep as-is if few items
        for (const item of items) {
          consolidated.push({ key: item.key, value: item.value as Record<string, unknown> })
        }
        continue
      }

      // Ask LLM to merge and deduplicate
      const lessonsText = items.map((item, i) => {
        const v = item.value as Record<string, unknown>
        return `${i + 1}. ${v['text'] as string}`
      }).join('\n')

      const response = await model.invoke([
        new SystemMessage(
          `You are a software engineering knowledge curator. Analyze the following generation lessons for the "${category}" category and produce a consolidated set.

Rules:
1. MERGE duplicates into single, more informative entries
2. RESOLVE contradictions by keeping the most recent or most specific advice
3. REMOVE lessons that are too vague to be actionable
4. KEEP lessons that describe specific error patterns and their solutions
5. Add a "confidence" field: "high" (confirmed multiple times), "medium" (seen once with clear fix), "low" (speculative)

Output a JSON array of consolidated lessons:
[
  {
    "text": "Consolidated lesson text",
    "category": "${category}",
    "errorTypes": ["specific error patterns"],
    "fixStrategy": "what to do",
    "confidence": "high|medium|low",
    "sourceCount": 3
  }
]`
        ),
        new HumanMessage(`Lessons to consolidate:\n\n${lessonsText}`),
      ])

      try {
        const content = typeof response.content === 'string' ? response.content : ''
        const parsed = JSON.parse(content.replace(/```json?\n?/g, '').replace(/```/g, '')) as Array<Record<string, unknown>>

        for (const lesson of parsed) {
          consolidated.push({
            key: `consolidated-${category}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            value: {
              ...lesson,
              timestamp: new Date().toISOString(),
              consolidated: true,
            },
          })
        }
      } catch {
        // If parsing fails, keep original items
        for (const item of items) {
          consolidated.push({ key: item.key, value: item.value as Record<string, unknown> })
        }
        conflicts.push(`Failed to consolidate ${category} lessons`)
      }
    }

    // 4. WRITE — Replace old lessons with consolidated ones
    // First, delete all existing lessons
    for (const item of allLessons) {
      await store.delete([tenantId, 'lessons'], item.key)
    }

    // Then write consolidated lessons
    for (const entry of consolidated) {
      await store.put(
        [tenantId, 'lessons'],
        entry.key,
        entry.value,
        { index: ['text'] },
      )
    }

    logger.info('Lesson consolidation complete', {
      tenantId,
      before: allLessons.length,
      after: consolidated.length,
    })

    return {
      namespace: 'lessons',
      before: allLessons.length,
      after: consolidated.length,
      merged: allLessons.length - consolidated.length,
      pruned: 0,
      conflicts,
    }
  },

  /**
   * Consolidate project conventions.
   * Extracts the dominant pattern from multiple convention entries.
   */
  async consolidateConventions(
    store: BaseStore,
    projectId: string,
    tenantId: string,
  ): Promise<ConsolidationResult> {
    const ns = projectId || tenantId
    const allConventions = await store.search([ns, 'conventions'], { limit: 100 })

    if (allConventions.length < 5) {
      return { namespace: 'conventions', before: allConventions.length, after: allConventions.length, merged: 0, pruned: 0, conflicts: [] }
    }

    // Find dominant patterns
    const patterns = {
      endpointPatterns: new Map<string, number>(),
      authPatterns: new Map<string, number>(),
    }

    for (const item of allConventions) {
      const v = item.value as Record<string, unknown>
      const ep = v['endpointPattern'] as string
      const ap = v['authPattern'] as string
      if (ep) patterns.endpointPatterns.set(ep, (patterns.endpointPatterns.get(ep) ?? 0) + 1)
      if (ap) patterns.authPatterns.set(ap, (patterns.authPatterns.get(ap) ?? 0) + 1)
    }

    // Find dominant pattern (most frequently used)
    const dominantEndpoint = [...patterns.endpointPatterns.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? '/api'
    const dominantAuth = [...patterns.authPatterns.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'authenticated'

    // Write consolidated convention
    await store.put(
      [ns, 'conventions'],
      'consolidated',
      {
        text: `Project conventions: API base path "${dominantEndpoint}", auth pattern "${dominantAuth}"`,
        endpointPattern: dominantEndpoint,
        authPattern: dominantAuth,
        conventionCount: allConventions.length,
        consolidated: true,
        timestamp: new Date().toISOString(),
      },
      { index: ['text'] },
    )

    return {
      namespace: 'conventions',
      before: allConventions.length,
      after: 1,
      merged: allConventions.length - 1,
      pruned: 0,
      conflicts: [],
    }
  },

  /**
   * Prune stale session summaries.
   * Keep last N summaries per project, delete older ones.
   */
  async pruneSessions(
    store: BaseStore,
    projectId: string,
    tenantId: string,
    keepCount: number = 20,
  ): Promise<ConsolidationResult> {
    const ns = projectId || tenantId
    const allSessions = await store.search([ns, 'session-summaries'], { limit: 200 })

    if (allSessions.length <= keepCount) {
      return { namespace: 'session-summaries', before: allSessions.length, after: allSessions.length, merged: 0, pruned: 0, conflicts: [] }
    }

    // Sort by timestamp, keep newest
    const sorted = allSessions.sort((a, b) => {
      const aTime = (a.value as Record<string, unknown>)['timestamp'] as string ?? ''
      const bTime = (b.value as Record<string, unknown>)['timestamp'] as string ?? ''
      return bTime.localeCompare(aTime)
    })

    const toDelete = sorted.slice(keepCount)
    for (const item of toDelete) {
      await store.delete([ns, 'session-summaries'], item.key)
    }

    return {
      namespace: 'session-summaries',
      before: allSessions.length,
      after: keepCount,
      merged: 0,
      pruned: toDelete.length,
      conflicts: [],
    }
  },
}
```

## 3. Memory Quality Scoring

### 3.1 Scoring Criteria

Each memory item gets a quality score based on:

```typescript
interface MemoryQualityScore {
  recency: number       // 0-1: How recently created/updated
  specificity: number   // 0-1: How specific (vs generic) the content is
  validation: number    // 0-1: Was it confirmed by successful generation?
  usage: number         // 0-1: How often has it been retrieved and used?
  compositeScore: number // Weighted average
}

function scoreMemoryItem(item: Item, namespace: string): MemoryQualityScore {
  const value = item.value as Record<string, unknown>
  const timestamp = value['timestamp'] as string ?? ''
  const age = Date.now() - new Date(timestamp).getTime()

  const recency = Math.max(0, 1 - age / (90 * 24 * 60 * 60 * 1000))  // Decays over 90 days

  const text = value['text'] as string ?? ''
  const specificity = Math.min(1, text.length / 200)  // Longer = more specific (up to 200 chars)

  const confidence = value['confidence'] as string ?? 'medium'
  const validation = confidence === 'high' ? 1 : confidence === 'medium' ? 0.6 : 0.3

  const usage = 0.5  // Default; enhanced with usage tracking later

  const compositeScore = recency * 0.3 + specificity * 0.2 + validation * 0.3 + usage * 0.2

  return { recency, specificity, validation, usage, compositeScore }
}
```

### 3.2 Quality-Based Retrieval

When loading memory for prompt injection, prefer high-quality items:

```typescript
export async function loadHighQualityLessons(
  store: BaseStore,
  tenantId: string,
  query: string,
  limit: number = 3,
): Promise<string> {
  // Fetch more than needed, then filter by quality
  const items = await store.search(
    [tenantId, 'lessons'],
    { query, limit: limit * 3 },
  )

  const scored = items.map(item => ({
    item,
    quality: scoreMemoryItem(item, 'lessons'),
  }))

  // Sort by composite score, take top N
  const best = scored
    .sort((a, b) => b.quality.compositeScore - a.quality.compositeScore)
    .slice(0, limit)

  if (best.length === 0) return ''

  return `## Lessons from Previous Generations\n\n${best.map(b => {
    const v = b.item.value as Record<string, unknown>
    const confidence = v['confidence'] as string ?? 'medium'
    return `- [${confidence}] ${v['text'] as string}`
  }).join('\n')}\n\nAvoid these issues.`
}
```

## 4. Automated Consolidation Triggers

### 4.1 After N Generations

```typescript
// In publish() node:
const sessionCount = await store.search(
  [projectId || tenantId, 'session-summaries'],
  { limit: 1 },  // Just check count
)

// Trigger consolidation every 25 generations
if (sessionCount.length > 0) {
  const totalSessions = await countNamespaceItems(store, projectId || tenantId, 'session-summaries')
  if (totalSessions % 25 === 0) {
    // Run consolidation in background (fire-and-forget)
    void memoryConsolidationService.consolidateLessons(store, tenantId)
    void memoryConsolidationService.consolidateConventions(store, projectId, tenantId)
    void memoryConsolidationService.pruneSessions(store, projectId, tenantId)
  }
}
```

### 4.2 BullMQ Scheduled Job

```typescript
// Add to queue worker configuration:
const consolidationQueue = new Queue('memory-consolidation', { connection: redis })

// Schedule: run daily for active tenants
consolidationQueue.add('daily-consolidation', {}, {
  repeat: { pattern: '0 3 * * *' },  // 3 AM daily
})

// Worker:
const consolidationWorker = new Worker('memory-consolidation', async (job) => {
  const activeTenants = await getActiveTenants()
  for (const tenant of activeTenants) {
    const store = await getMemoryStore()
    await memoryConsolidationService.consolidateLessons(store, tenant.id)
    // ... other consolidation tasks
  }
}, { connection: redis })
```

## 5. Acceptance Criteria

- [ ] Lesson consolidation groups by category and deduplicates
- [ ] Convention consolidation extracts dominant patterns
- [ ] Session pruning keeps last N entries per project
- [ ] Memory quality scoring uses recency + specificity + validation
- [ ] High-quality retrieval prefers validated, recent, specific items
- [ ] Auto-trigger consolidation every 25 generations
- [ ] BullMQ scheduled job for daily consolidation
- [ ] Consolidation is non-blocking (fire-and-forget with logging)
- [ ] Consolidation produces audit log (before/after counts)
