# 09 — Cross-Intent Context Transfer

> **Agent:** langchain-ts-expert
> **Priority:** P2
> **Depends on:** 01-ARCHITECTURE, 03-STORE-INTEGRATION
> **Effort:** 4h

---

## 1. Problem Statement

StarterForge has multiple AI-powered flows (intents), each running as an isolated LangGraph graph:

| Intent | Graph | Thread ID Pattern | Isolation |
|--------|-------|-------------------|-----------|
| `configure` | ConfiguratorGraph | `configure:{sessionId}` | Full |
| `generate_feature` | FeatureGeneratorGraph | `generate_feature:feat-gen-{featureId}` | Full |
| `edit_feature` | FeatureEditorGraph | `edit_feature:feat-edit-{featureId}` | Full |
| `create_feature` | FeatureBuilderGraph | `create_feature:{sessionId}` | Full |
| `create_template` | TemplateBuilderGraph | `create_template:tmpl-{templateId}` | Full |

**The problem:** When a user switches from one intent to another, ALL context is lost. Examples:

1. User configures project (selects template, features) → switches to `generate_feature` → must re-explain what they chose
2. User generates Feature A → generates Feature B → Feature B has no idea Feature A exists
3. User generates a feature → edits it → editor has zero knowledge of generation decisions
4. Template builder creates template → user wants to generate features for it → generator doesn't know template structure

### Why This Matters

Users experience context loss as "the AI forgot everything." Each intent switch feels like starting over. The system has all the information (in the Store), but each graph starts fresh without loading relevant cross-intent context.

## 2. Solution: Store as Shared Memory Bus

The LangGraph Store already connects all graphs (see `01-ARCHITECTURE.md` section 2.3). The solution is to:

1. **Write session summaries** from EVERY graph (not just feature generator)
2. **Load relevant summaries** at the START of every graph invocation
3. **Transfer specific context** (not just summaries) between related intents

### 2.1 Unified Session Summary Format

```typescript
// Shared across all graphs
export interface CrossIntentSummary {
  /** Human-readable summary */
  text: string
  /** Which intent produced this summary */
  intent: string
  /** What was accomplished */
  outcome: string
  /** Key decisions made (extractable context) */
  decisions: Record<string, string>
  /** Relevant IDs for follow-up intents */
  relatedIds: {
    featureId?: string
    featureDbId?: string
    templateSlug?: string
    projectId?: string
    featureSpecId?: string
  }
  /** Tech stack in use */
  techStack?: TechStack
  /** When this happened */
  timestamp: string
}
```

### 2.2 Write from ALL Graphs

**Feature Generator** (already implemented — enhance):
```typescript
// In publish() node:
await store.put(
  [projectId || tenantId, 'session-summaries'],
  threadId,
  {
    text: `Generated "${featureName}" (${category}): ${fileCount} files, quality ${quality}/100`,
    intent: 'generate_feature',
    outcome: 'Feature generated and published',
    decisions: {
      authStrategy: clarificationAnswers['auth-strategy'] ?? '',
      databasePattern: clarificationAnswers['db-pattern'] ?? '',
      apiPattern: apiContract?.endpoints[0]?.path?.split('/').slice(0, 3).join('/') ?? '',
    },
    relatedIds: { featureId, featureDbId, featureSpecId },
    techStack: intakeData?.techStack,
    timestamp: new Date().toISOString(),
  } satisfies CrossIntentSummary,
  { index: ['text'] }
)
```

**Feature Editor** (NEW):
```typescript
// In the editor's completion node:
await store.put(
  [projectId || tenantId, 'session-summaries'],
  threadId,
  {
    text: `Edited "${featureName}": ${editSummary}`,
    intent: 'edit_feature',
    outcome: editOutcome,
    decisions: { editType, filesModified: modifiedFiles.join(', ') },
    relatedIds: { featureId, featureDbId },
    timestamp: new Date().toISOString(),
  } satisfies CrossIntentSummary,
  { index: ['text'] }
)
```

**Template Builder** (NEW):
```typescript
// In template builder's publish node:
await store.put(
  [tenantId, 'session-summaries'],
  threadId,
  {
    text: `Created template "${templateName}": ${featureCount} features, ${description}`,
    intent: 'create_template',
    outcome: 'Template created',
    decisions: { features: selectedFeatures.join(', '), stack: templateStack },
    relatedIds: { templateSlug },
    techStack: templateTechStack,
    timestamp: new Date().toISOString(),
  } satisfies CrossIntentSummary,
  { index: ['text'] }
)
```

**Configurator** (NEW):
```typescript
// When configuration is completed/saved:
await store.put(
  [projectId || tenantId, 'session-summaries'],
  threadId,
  {
    text: `Configured project: template="${templateSlug}", features=[${selectedFeatures.join(', ')}]`,
    intent: 'configure',
    outcome: 'Project configured',
    decisions: { templateSlug, selectedFeatures: selectedFeatures.join(', ') },
    relatedIds: { projectId, templateSlug },
    techStack: projectTechStack,
    timestamp: new Date().toISOString(),
  } satisfies CrossIntentSummary,
  { index: ['text'] }
)
```

### 2.3 Load at Graph Start

Each graph's entry node loads relevant cross-intent context:

```typescript
/**
 * Load cross-intent context at graph start.
 * Finds recent session summaries from OTHER intents that are relevant
 * to the current task.
 */
export async function loadCrossIntentContext(
  store: BaseStore | undefined,
  projectId: string,
  tenantId: string,
  currentIntent: string,
  featureId?: string,
): Promise<string> {
  if (!store) return ''
  const ns = projectId || tenantId

  try {
    const allSummaries = await store.search(
      [ns, 'session-summaries'],
      { limit: 10 },
    )

    // Filter: exclude current intent's summaries, keep relevant ones
    const relevant = allSummaries.filter(item => {
      const summary = item.value as CrossIntentSummary
      if (summary.intent === currentIntent) return false

      // If we have a featureId, prioritize summaries about this feature
      if (featureId) {
        const related = summary.relatedIds
        if (related?.featureId === featureId || related?.featureDbId === featureId) {
          return true
        }
      }

      // Keep recent summaries from other intents
      const age = Date.now() - new Date(summary.timestamp).getTime()
      return age < 7 * 24 * 60 * 60 * 1000  // Last 7 days
    })

    if (relevant.length === 0) return ''

    const lines = relevant
      .sort((a, b) => {
        const aTime = (a.value as CrossIntentSummary).timestamp
        const bTime = (b.value as CrossIntentSummary).timestamp
        return bTime.localeCompare(aTime)
      })
      .slice(0, 5)
      .map(item => {
        const s = item.value as CrossIntentSummary
        return `- [${s.intent}] ${s.text}`
      })

    return `## Related Activity\n\nRecent work on this project:\n${lines.join('\n')}\n\nUse this context to inform your responses.`
  } catch {
    return ''
  }
}
```

## 3. Intent-Specific Context Transfer

### 3.1 Generate → Edit Transfer

When a user edits a feature they previously generated, the editor should know:
- What clarification decisions were made
- What fix cycles were needed (and why)
- What quality score was achieved
- What API contract was established

```typescript
// In feature editor's start node:
if (featureDbId) {
  // Load the generation session summary for this specific feature
  const genSummaries = await store.search(
    [projectId || tenantId, 'session-summaries'],
    { limit: 5 },
  )

  const genSummary = genSummaries.find(item => {
    const s = item.value as CrossIntentSummary
    return s.intent === 'generate_feature' &&
           (s.relatedIds?.featureDbId === featureDbId || s.relatedIds?.featureId === featureId)
  })

  if (genSummary) {
    const s = genSummary.value as CrossIntentSummary
    systemContent += `\n\n## Generation Context\n\nThis feature was generated with the following decisions:\n`
    for (const [key, value] of Object.entries(s.decisions)) {
      systemContent += `- ${key}: ${value}\n`
    }
    systemContent += `\nOutcome: ${s.outcome}`
  }
}
```

### 3.2 Configure → Generate Transfer

When a user configures a project and then generates features:

```typescript
// In feature generator's intake node:
const configSummaries = await store.search(
  [projectId || tenantId, 'session-summaries'],
  { limit: 3 },
)

const configContext = configSummaries
  .filter(item => (item.value as CrossIntentSummary).intent === 'configure')
  .map(item => {
    const s = item.value as CrossIntentSummary
    return s.decisions
  })

if (configContext.length > 0) {
  const latest = configContext[0]!
  systemContent += `\n\n## Project Configuration\n`
  systemContent += `Template: ${latest['templateSlug'] ?? 'unknown'}\n`
  systemContent += `Selected features: ${latest['selectedFeatures'] ?? 'none'}\n`
  systemContent += `\nEnsure the generated feature integrates with the configured project.`
}
```

### 3.3 Template Builder → Generator Transfer

When features are generated for a template:

```typescript
// Feature generator knows about the template's structure
const templateSummaries = await store.search(
  [tenantId, 'session-summaries'],
  { limit: 5 },
)

const templateContext = templateSummaries
  .filter(item => {
    const s = item.value as CrossIntentSummary
    return s.intent === 'create_template' &&
           s.relatedIds?.templateSlug === targetTemplateSlug
  })

if (templateContext.length > 0) {
  const s = templateContext[0]!.value as CrossIntentSummary
  systemContent += `\n\n## Template Context\n`
  systemContent += `This feature is being generated for template "${s.relatedIds?.templateSlug}".\n`
  systemContent += `Template includes: ${s.decisions['features'] ?? 'unknown features'}.\n`
  systemContent += `Ensure compatibility with existing template features.`
}
```

## 4. Graph-Level Integration

### 4.1 Shared Entry Node Pattern

Create a reusable pattern for all graphs:

```typescript
/**
 * Standard entry-point logic for any graph.
 * Loads cross-intent context from Store.
 */
export async function loadGraphEntryContext(params: {
  store: BaseStore | undefined
  projectId: string
  tenantId: string
  intent: string
  featureId?: string
}): Promise<{
  crossIntentContext: string
  projectConventions: string
  relevantLessons: string
}> {
  const [crossIntentContext, projectConventions, relevantLessons] = await Promise.all([
    loadCrossIntentContext(params.store, params.projectId, params.tenantId, params.intent, params.featureId),
    loadApiConventions(params.store, params.projectId, params.tenantId),
    loadRelevantLessons(params.store, params.tenantId, ''),
  ])

  return { crossIntentContext, projectConventions, relevantLessons }
}
```

### 4.2 Apply to Feature Editor Graph

```typescript
// In feature-editor.graph.ts — first node:
async function editorIntake(state: FeatureEditorState): Promise<Partial<FeatureEditorState>> {
  const store = getStore()

  // Load cross-intent context
  const { crossIntentContext, projectConventions } = await loadGraphEntryContext({
    store,
    projectId: state.projectId,
    tenantId: state.tenantId,
    intent: 'edit_feature',
    featureId: state.featureId,
  })

  let systemContent = resolvedPrompt
  if (crossIntentContext) systemContent += `\n\n${crossIntentContext}`
  if (projectConventions) systemContent += `\n\n${projectConventions}`

  // ... rest of editor intake
}
```

### 4.3 Apply to Template Builder Graph

```typescript
// In template-builder.graph.ts — first node:
async function templateIntake(state: TemplateBuilderState): Promise<Partial<TemplateBuilderState>> {
  const store = getStore()

  const { crossIntentContext } = await loadGraphEntryContext({
    store,
    projectId: '',
    tenantId: state.tenantId,
    intent: 'create_template',
  })

  // Template builder benefits from knowing what features have been generated
  const featureIndex = await loadProjectContext(store, '', state.tenantId)

  let systemContent = resolvedPrompt
  if (crossIntentContext) systemContent += `\n\n${crossIntentContext}`
  if (featureIndex) systemContent += `\n\n${featureIndex}`

  // ... rest of template intake
}
```

## 5. Native `interrupt()` for Plan Approval

Currently, plan approval uses a custom `END` + `pause_for_plan_review` pattern. LangGraph's native `interrupt()` API is cleaner:

```typescript
import { interrupt, Command } from '@langchain/langgraph'

// In validate_plan node:
if (!state.planApproved) {
  // This pauses the graph and returns control to the caller
  const approval = interrupt({
    type: 'plan_review',
    plan: state.featurePlan,
    costEstimate: state.costEstimate,
  })

  // Execution resumes here after user sends Command({ resume: { approved: true } })
  return { planApproved: approval.approved }
}
```

**Benefits:**
- Automatic checkpoint at interrupt point
- Clean resume via `Command({ resume: ... })`
- No custom routing for pause states
- State is guaranteed consistent at resume

**Migration:** This is a breaking change to the SSE protocol. The frontend needs to handle `interrupt` events instead of `checkpoint` events. Implement behind a feature flag.

## 6. Acceptance Criteria

- [ ] All 5 graphs write `CrossIntentSummary` to Store on completion
- [ ] `loadCrossIntentContext()` finds relevant summaries from other intents
- [ ] Generate → Edit: editor knows generation decisions
- [ ] Configure → Generate: generator knows project configuration
- [ ] Template → Generate: generator knows template structure
- [ ] `loadGraphEntryContext()` pattern used in all graph entry nodes
- [ ] Cross-intent context adds < 500 tokens to system prompt
- [ ] Context is age-limited (last 7 days) to prevent stale injection
- [ ] `interrupt()` migration planned behind feature flag
