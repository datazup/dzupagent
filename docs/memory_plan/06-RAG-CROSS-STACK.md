# 06 — RAG & Cross-Stack Retrieval

> **Agent:** langchain-ts-expert
> **Priority:** P1
> **Depends on:** 02-FEATURE-ABSTRACTION, 03-STORE-INTEGRATION
> **Effort:** 6h

---

## 1. Current RAG Architecture

### What Exists

```
rag-retrieval.service.ts
  │
  ├─▶ findSimilarFeatures()
  │     Uses: featureSearchService.search()
  │     Filter: tenantId, framework=[templateSlug, 'any'], category, minQuality
  │     Returns: ReferenceFeature[] with full file contents
  │
  ├─▶ getFeatureCode()
  │     Loads: Feature.overlayFiles from Prisma
  │     Returns: Map<filePath, content>
  │
  ├─▶ buildReferencePrompt()
  │     Finds most relevant file by path/name similarity scoring
  │     Injects as code block with adaptation instructions
  │
  ├─▶ buildReferenceCodeExamples()
  │     Filters files by layer (backend/frontend/db/test)
  │     Truncates to maxCharsPerFile (4000)
  │     Formats as markdown code blocks with match score
  │
  └─▶ getRecommendations()
        Combines: co-occurrence + description-based search
        Deduplicates by featureId, sorts by score
```

### Current Limitations

1. **Framework lock-in**: `framework: [templateSlug, 'any']` means RAG only finds features for the same tech stack
2. **No cross-stack matching**: A Vue3 auth feature can't serve as reference for React auth feature
3. **No semantic search**: `featureSearchService.search()` uses Qdrant but only indexes within a framework
4. **File-level matching only**: `findMostRelevantFile()` scores by path/filename, not by code purpose
5. **No memory of RAG effectiveness**: Which references actually improved generation quality?
6. **Single reference**: Only the top-1 reference is used (stored in `state.referenceFeature`)

## 2. Enhanced RAG Architecture

### 2.1 Two-Layer Retrieval

```
Layer 1: ABSTRACT RETRIEVAL (tech-stack agnostic)
  Search by: FeatureSpec description, category, requirements
  Returns: Matching FeatureSpec IDs regardless of tech stack
  Store: [tenantId, "feature-specs"] with semantic search

Layer 2: IMPLEMENTATION RETRIEVAL (tech-stack aware)
  Input: FeatureSpec IDs from Layer 1
  Search by: Target tech stack compatibility
  Returns: Best implementation files as reference code
  Source: FeatureImplementation table + OverlayFile table
```

### 2.2 Implementation

```typescript
// apps/api/src/services/features/cross-stack-rag.service.ts

import { getMemoryStore } from '../agent/store.js'
import { featureSpecService } from './feature-spec.service.js'
import { ragRetrievalService, type ReferenceFeature } from './rag-retrieval.service.js'

export interface CrossStackReference {
  /** The abstract feature spec that matched */
  spec: {
    id: string
    name: string
    description: string
    category: string
    matchScore: number  // Semantic similarity score
  }
  /** Available implementations, sorted by relevance to target stack */
  implementations: Array<{
    techStackKey: string
    quality: number
    files: Record<string, string>
    stackDistance: number  // 0 = exact match, higher = more different
  }>
  /** The recommended implementation to use as reference */
  recommended: {
    techStackKey: string
    quality: number
    files: Record<string, string>
    reason: string  // Why this one was selected
  } | null
}

export const crossStackRagService = {
  /**
   * Find reference features across all tech stacks.
   *
   * Strategy:
   * 1. Semantic search on FeatureSpec descriptions (stack-agnostic)
   * 2. For each matching spec, find all implementations
   * 3. Score implementations by: quality * stack-proximity
   * 4. Return top N references with recommended implementation
   */
  async findCrossStackReferences(params: {
    description: string
    targetStack: TechStack
    tenantId: string
    category?: string
    limit?: number
    minQuality?: number
  }): Promise<CrossStackReference[]> {
    const { description, targetStack, tenantId, category, limit = 3, minQuality = 60 } = params
    const targetKey = techStackKey(targetStack)

    // Layer 1: Abstract semantic search
    const store = await getMemoryStore()
    const specMatches = await searchFeatureSpecs(store, tenantId, description, limit * 2)

    if (specMatches.length === 0) {
      // Fallback: use existing single-stack RAG
      return this.fallbackToSingleStackRag(params)
    }

    // Layer 2: Find implementations for each matching spec
    const references: CrossStackReference[] = []

    for (const specMatch of specMatches) {
      const impls = await featureSpecService.getImplementations(specMatch.specId)
      const qualityFiltered = impls.filter(i => i.quality >= minQuality)

      if (qualityFiltered.length === 0) continue

      // Score each implementation by quality * stack proximity
      const scored = qualityFiltered.map(impl => {
        const implStack = impl.techStack as TechStack
        const distance = computeStackDistance(implStack, targetStack)
        return {
          impl,
          techStackKey: impl.techStackKey,
          quality: impl.quality,
          stackDistance: distance,
          // Composite score: prefer high quality + close stack
          compositeScore: impl.quality * (1 / (1 + distance)),
        }
      }).sort((a, b) => b.compositeScore - a.compositeScore)

      // Load files for top implementation only (to avoid excessive DB queries)
      const top = scored[0]
      if (!top) continue

      const files = await this.loadImplementationFiles(top.impl.id)

      const recommended = files && Object.keys(files).length > 0
        ? {
            techStackKey: top.techStackKey,
            quality: top.quality,
            files,
            reason: top.stackDistance === 0
              ? 'Exact tech stack match'
              : top.stackDistance <= 2
                ? `Close stack (distance ${top.stackDistance}), quality ${top.quality}/100`
                : `Different stack but high quality (${top.quality}/100)`,
          }
        : null

      references.push({
        spec: {
          id: specMatch.specId,
          name: specMatch.name,
          category: specMatch.category,
          matchScore: specMatch.score,
        },
        implementations: scored.map(s => ({
          techStackKey: s.techStackKey,
          quality: s.quality,
          files: {},  // Don't load all files — too expensive
          stackDistance: s.stackDistance,
        })),
        recommended,
      })
    }

    return references.slice(0, limit)
  },

  /**
   * Build prompt context from cross-stack references.
   * Selects appropriate files from recommended implementation
   * filtered by the current generation layer.
   */
  buildCrossStackPromptContext(params: {
    references: CrossStackReference[]
    layer: 'backend' | 'frontend' | 'database' | 'test' | 'all'
    targetStack: TechStack
    maxFiles: number
    maxCharsPerFile: number
  }): string {
    const { references, layer, targetStack, maxFiles = 3, maxCharsPerFile = 4000 } = params

    const sections: string[] = ['## Cross-Stack Reference Code\n']
    let fileCount = 0

    for (const ref of references) {
      if (!ref.recommended || fileCount >= maxFiles) break

      // Filter files by layer
      const files = Object.entries(ref.recommended.files)
        .filter(([path]) => filterByLayer(path, layer))
        .slice(0, maxFiles - fileCount)

      if (files.length === 0) continue

      sections.push(
        `### From "${ref.spec.name}" (${ref.spec.category}, ${ref.recommended.techStackKey})`,
        `*Match: ${(ref.spec.matchScore * 100).toFixed(0)}% similar, ${ref.recommended.reason}*\n`,
      )

      for (const [filePath, content] of files) {
        const truncated = content.length > maxCharsPerFile
          ? content.substring(0, maxCharsPerFile) + '\n// ... (truncated)'
          : content

        sections.push(`#### ${filePath}\n\`\`\`\n${truncated}\n\`\`\`\n`)
        fileCount++
      }
    }

    if (fileCount === 0) return ''

    sections.push(
      `\n**Adaptation instructions:**`,
      `- These references are from a DIFFERENT tech stack — do NOT copy directly`,
      `- Adapt patterns and logic to ${formatStack(targetStack)} conventions`,
      `- Maintain the same functional behavior but use idiomatic ${targetStack.backend}/${targetStack.frontend} code`,
      `- If the reference uses different libraries, use the ${targetStack.backend}/${targetStack.frontend} equivalents`,
    )

    return sections.join('\n')
  },

  async loadImplementationFiles(implId: string): Promise<Record<string, string>> {
    const files = await prisma.overlayFile.findMany({
      where: { featureImplementationId: implId },
      select: { filePath: true, content: true },
    })
    const result: Record<string, string> = {}
    for (const f of files) {
      result[f.filePath] = f.content
    }
    return result
  },

  async fallbackToSingleStackRag(params: {
    description: string
    tenantId: string
    category?: string
    limit?: number
  }): Promise<CrossStackReference[]> {
    // Use existing RAG as fallback when no FeatureSpecs exist
    const rag = await ragRetrievalService.findSimilarFeatures({
      description: params.description,
      tenantId: params.tenantId,
      templateSlug: '',  // Search all
      category: params.category,
      limit: params.limit,
    })

    return rag.references.map(ref => ({
      spec: {
        id: ref.featureId,
        name: ref.name,
        description: '',
        category: '',
        matchScore: ref.score,
      },
      implementations: [{
        techStackKey: ref.templateSlug,
        quality: 0,
        files: ref.files,
        stackDistance: 0,
      }],
      recommended: {
        techStackKey: ref.templateSlug,
        quality: 0,
        files: ref.files,
        reason: 'Legacy single-stack RAG match',
      },
    }))
  },
}

function filterByLayer(path: string, layer: string): boolean {
  if (layer === 'all') return true
  if (layer === 'backend') return path.includes('/services/') || path.includes('/controllers/') || path.includes('/routes/')
  if (layer === 'frontend') return path.endsWith('.vue') || path.endsWith('.tsx') || path.endsWith('.svelte') || path.includes('/stores/') || path.includes('/composables/') || path.includes('/hooks/')
  if (layer === 'database') return path.endsWith('.prisma') || path.includes('/types/') || path.includes('/schemas/')
  if (layer === 'test') return path.includes('.test.') || path.includes('.spec.')
  return true
}
```

## 3. RAG Effectiveness Tracking

### 3.1 Track Which References Were Used

After publish, record which RAG references contributed to generation:

```typescript
// In publish() node:
if (state.referenceFeature || state.referenceImplementation) {
  await store.put(
    [tenantId, 'rag-effectiveness'],
    `gen-${state.featureDbId}`,
    {
      text: `Generated "${state.intakeData?.name}" using reference from "${state.referenceFeature?.name ?? 'cross-stack'}"`,
      featureId: state.intakeData?.featureId,
      referenceId: state.referenceFeature?.featureId ?? state.referenceImplementation?.techStack,
      referenceStack: state.referenceFeature?.templateSlug ?? 'cross-stack',
      generatedQuality: state.validationResult?.quality ?? 0,
      fixAttemptsNeeded: state.fixAttempts,
      helpful: state.fixAttempts <= 1,  // Less fixes = better reference
      timestamp: new Date().toISOString(),
    },
    { index: ['text'] }
  )
}
```

### 3.2 Use Effectiveness to Rank Future References

```typescript
// When scoring references, factor in past effectiveness
async function adjustScoreByEffectiveness(
  store: BaseStore,
  tenantId: string,
  referenceId: string,
  baseScore: number,
): Promise<number> {
  const records = await store.search(
    [tenantId, 'rag-effectiveness'],
    { query: referenceId, limit: 5 },
  )

  if (records.length === 0) return baseScore

  const avgHelpfulness = records.reduce((sum, r) => {
    const val = r.value as Record<string, unknown>
    return sum + (val['helpful'] ? 1 : 0)
  }, 0) / records.length

  // Boost score if reference has historically been helpful
  return baseScore * (0.7 + 0.3 * avgHelpfulness)
}
```

## 4. Embedding Strategy

### 4.1 What Gets Embedded

| Content | Embedding Field | Purpose |
|---------|----------------|---------|
| Feature spec descriptions | `text` in `[tenantId, "feature-specs"]` | Cross-stack feature matching |
| Generation lessons | `text` in `[tenantId, "lessons"]` | Find relevant past mistakes |
| API conventions | `text` in `[projectId, "conventions"]` | Consistency enforcement |
| Session summaries | `text` in `[projectId, "session-summaries"]` | Cross-intent context |
| RAG effectiveness | `text` in `[tenantId, "rag-effectiveness"]` | Reference quality tracking |

### 4.2 What Does NOT Get Embedded

| Content | Storage | Reason |
|---------|---------|--------|
| User defaults | `[userId, "generation-defaults"]` | Exact key lookup, not search |
| Project tech stack | `[projectId, "tech-stack"]` | Exact key lookup |
| User profile | `[userId, "profile"]` | Exact key lookup |
| Project decisions | `[projectId, "decisions"]` | Listed, not searched |

### 4.3 Embedding Refresh

When a FeatureSpec is updated (e.g., requirements change), re-embed:

```typescript
// After FeatureSpec update:
await store.put(
  [tenantId, 'feature-specs'],
  featureSpecId,
  { text: updatedDescription, ...rest },
  { index: ['text'] }  // Re-embeds automatically on put()
)
```

## 5. Integration with Feature Generator Graph

### 5.1 Plan Node Enhancement

```typescript
// In plan() — replace single-stack RAG with cross-stack:
let referenceFeature = state.referenceFeature
if (!referenceFeature && state.tenantId) {
  try {
    const crossStackRefs = await crossStackRagService.findCrossStackReferences({
      description: state.intakeData?.description ?? '',
      targetStack: state.intakeData!.techStack,
      tenantId: state.tenantId,
      category: state.intakeData?.category,
      limit: 3,
    })

    if (crossStackRefs.length > 0 && crossStackRefs[0]!.recommended) {
      const best = crossStackRefs[0]!
      referenceFeature = {
        featureId: best.spec.id,
        templateSlug: best.recommended!.techStackKey,
        name: best.spec.name,
        score: best.spec.matchScore,
        files: best.recommended!.files,
      }
    }
  } catch { /* non-fatal */ }
}
```

### 5.2 Generation Node Enhancement

```typescript
// In generateBackend(), generateFrontend(), etc.:
// Replace buildReferenceCodeExamples() with cross-stack version
const refContext = crossStackRagService.buildCrossStackPromptContext({
  references: state.crossStackReferences ?? [],
  layer: 'backend',
  targetStack: state.intakeData!.techStack,
  maxFiles: 3,
  maxCharsPerFile: 4000,
})

if (refContext) {
  systemContent += `\n\n${refContext}`
}
```

## 6. Acceptance Criteria

- [ ] Cross-stack retrieval finds features regardless of tech stack
- [ ] FeatureSpec semantic search returns relevant matches
- [ ] Stack distance scoring correctly prioritizes closest implementations
- [ ] Per-layer file filtering works for backend/frontend/db/test
- [ ] RAG effectiveness is tracked after each generation
- [ ] Fallback to single-stack RAG when no FeatureSpecs exist
- [ ] Cross-stack prompt context includes adaptation instructions
- [ ] Performance: cross-stack search < 200ms for typical namespace sizes
