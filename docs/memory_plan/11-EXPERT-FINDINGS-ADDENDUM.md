# 11 — Expert Review Findings & Addendum

> **Source:** LangGraph/AI Architecture Expert + Prompt System Architect reviews (2026-03-22)
> **Status:** Critical findings that supplement and in some cases override plan documents 01-10

---

## 1. Critical Bugs Found (Fix BEFORE Starting Sprints)

### BUG-01: Store Not Wired to 4/5 Graphs

**Finding (Architecture Expert H1):** Only the Feature Generator graph compiles with `store`. The Feature Builder, Feature Editor, Template Builder, and Configurator graphs all compile WITHOUT the store parameter.

**Impact:** Cross-session memory is completely unavailable in 4 of 5 graphs. The entire memory architecture described in `01-ARCHITECTURE.md` and `09-CROSS-INTENT-CONTEXT.md` cannot work until this is fixed.

**Files affected:**
- `graphs/feature-builder.graph.ts` — missing `store` in `graph.compile()`
- `graphs/feature-editor.graph.ts` — missing `store` in `graph.compile()`
- `graphs/template-builder.graph.ts` — missing `store` in `graph.compile()`
- `agent.service.ts` or `graph.ts` — configurator graph compilation

**Fix (1h):**
```typescript
// In each graph's build function:
const store = await getMemoryStore()
return graph.compile({ checkpointer, store })
```

### BUG-02: No LLM Retry or Fallback

**Finding (Architecture Expert H2):** No `.withRetry()` or `.withFallbacks()` on any LLM calls. A single transient API error kills the entire graph invocation.

**Impact:** Production reliability. A 503 from Anthropic during a 12-node generation kills the entire run.

**Fix (2h):**
```typescript
// In llm.ts — wrap model creation:
export function getCodeGenModel() {
  const model = new ChatAnthropic({ ... })
  return model
    .withRetry({ stopAfterAttempt: 3, retryIf: isTransientError })
    .withFallbacks([getOpenAIFallback()])
}

function isTransientError(error: Error): boolean {
  return error.message.includes('503') ||
         error.message.includes('529') ||
         error.message.includes('rate_limit') ||
         error.message.includes('overloaded')
}
```

### BUG-03: Multiple PrismaClient Instances

**Finding (Architecture Expert H3):** `rag-retrieval.service.ts` (line 4), `feature-search.service.ts`, and potentially other files create `new PrismaClient()` instead of using the shared singleton at `apps/api/src/lib/prisma.js`.

**Impact:** Connection pool exhaustion under load. PostgreSQL has a default limit of 100 connections.

**Fix (30m):** Replace all `new PrismaClient()` with `import { prisma } from '../../lib/prisma.js'`.

### BUG-04: PostgresStore.search() Likely Broken

**Finding (Both experts):** `store.search()` with `query` parameter requires embedding configuration. The store is initialized without embeddings. Additionally, items stored without `{ index: ["text"] }` are invisible to search.

**This is already documented in `03-STORE-INTEGRATION.md` but is elevated to CRITICAL priority.**

### BUG-05: `getStore()` vs `getMemoryStore()` Confusion

**Finding (Architecture Expert H16):** Graph nodes call `getStore()` (the LangGraph runtime store accessor) which returns the store attached during `graph.compile()`. But since 4/5 graphs don't attach a store, `getStore()` returns `undefined` silently. The code handles this gracefully (optional chaining), but it means memory is silently disabled.

**Fix:** After BUG-01 is fixed, all graphs will have a store. Add a startup validation:
```typescript
const store = getStore()
if (!store) {
  logger.error('LangGraph Store not available in graph context — memory disabled')
}
```

---

## 2. Critical Prompt Findings

### PROMPT-01: Templates Hardcoded to Vue3/Express/Prisma

**Finding (Prompt Expert GAP 1):** All 60+ seed templates contain hardcoded Vue 3 SFC examples, `<script setup>` patterns, Pinia stores, Express router patterns, and Prisma schema conventions. A React user receives Vue code examples in prompts.

**Impact:** Multi-tech-stack generation produces incorrect code because the LLM is guided by wrong framework examples.

**Severity:** BLOCKING for multi-stack. Must be fixed in Sprint M2.

**Scale:** ~48 category-specific variants need stack-aware alternatives. Start with the 4 generation node types × 3 stacks = 12 new seed templates minimum.

### PROMPT-02: Undeclared Template Variables

**Finding (Prompt Expert GAP 2):** `buildPromptContext()` produces ~15 variables NOT in `STANDARD_VARIABLES`: `tech_stack_summary`, `scope_summary`, `reference_code_examples`, `api_contract`, `conversation_summary`, `quality_breakdown`, `file_summary`, `file_count`, `assigned_templates`, `fix_attempt`, `passed_count`, `failed_count`, `error_count`.

These work via the `[key: string]: unknown` catchall in `FeatureTemplateContext`, but:
- `validateTemplateContent()` flags them as undeclared
- Template editors have no documentation of available variables
- No compile-time safety

**Fix (1h):** Add these to `STANDARD_VARIABLES` in `template-engine.ts`.

### PROMPT-03: Partial System is Dead Code

**Finding (Prompt Expert GAP 6):** The template engine supports `{{> partial_name}}` syntax, but `resolveNodePrompt()` never passes partials. The `partials` parameter is never populated. This is dead infrastructure.

**Impact:** No reusable prompt components (e.g., `{{> code_standards}}`, `{{> anti_patterns}}`, `{{> stack_conventions}}`). Updating "TypeScript strict mode" rules requires editing 12+ templates.

**Fix:** Part of Sprint M2 — implement partial loading from DB or constants.

### PROMPT-04: Memory Context Only Injected in 2/12 Nodes

**Finding (Prompt Expert GAP 4):** Memory (project decisions, lessons, conventions) is injected only in `plan()` and `clarify()` nodes. The 4 generation nodes (`generate_db`, `generate_backend`, `generate_frontend`, `generate_tests`) do NOT receive memory context.

**Impact:**
- Backend generator doesn't know API conventions from previous features
- Frontend generator doesn't know component naming patterns
- Test generator doesn't know testing patterns established in prior features

**Fix:** Part of Sprint M1 — add `loadApiConventions()` and `loadRelevantLessons()` calls to all generation nodes (or cache in state during plan and pass through).

### PROMPT-05: No Anthropic Prompt Caching

**Finding (Architecture Expert H9):** Anthropic's prompt caching (90% input cost reduction for cached prefixes) is not used. The system prompt is composed as a single monolithic string with no `cache_control` breakpoints.

**Impact:** Cost. A 12-node pipeline makes ~12 LLM calls. Each call sends the full system prompt. Caching the static prefix (role + instructions + code standards) could save 50-70% of input tokens across the pipeline.

**Fix (Sprint M3 — P1):**
```typescript
// Split system prompt into cacheable prefix + dynamic suffix
const messages = [
  new SystemMessage({
    content: [
      { type: 'text', text: staticPromptPrefix, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dynamicContext },
    ]
  }),
  ...state.messages,
]
```

---

## 3. Architecture Findings

### ARCH-01: extractContract() is Express-Only

**Finding (Architecture Expert H6):** `extractContract()` in `feature-generator.graph.ts` (lines 1098-1194) uses Express-specific regex patterns:
```javascript
const routeRegex = /(?:router|app)\.(get|post|put|patch|delete)\(/gi
```

This won't match Fastify route declarations (`fastify.route()`, decorators), NestJS decorators (`@Get()`, `@Post()`), or Hono patterns.

**Fix:** Make `extractContract()` pluggable per backend framework:
```typescript
const ROUTE_EXTRACTORS: Record<string, RegExp> = {
  express: /(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi,
  fastify: /(?:fastify|server)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi,
  nestjs: /@(Get|Post|Put|Patch|Delete)\(\s*['"`]([^'"`]+)['"`]\)/gi,
  hono: /(?:app|router)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi,
}
```

### ARCH-02: Token Budget is Framework-Unaware

**Finding (Architecture Expert H7):** `getFileRole()` in `token-budget.ts` classifies files by path patterns hardcoded to Vue/Express conventions. Files from React (`*.tsx`), Svelte (`*.svelte`), NestJS (`*.module.ts`, `*.guard.ts`) would be misclassified.

**Fix:** Make path classification configurable by tech stack.

### ARCH-03: Cost Tracking Only at Publish

**Finding (Architecture Expert H10):** `costTrackingService.trackUsage()` is only called in the `publish()` node. The 11 other LLM calls (intake, clarify, plan, 4 generators, run_tests, validate, fix, review) are untracked.

**Fix:** Wrap `invokeWithTimeout()` to track usage on every call:
```typescript
async function invokeWithTracking(model, messages, context, state) {
  const response = await invokeWithTimeout(model, messages)
  // Extract usage from response metadata
  void costTrackingService.trackUsage({ ...usage, context }).catch(() => {})
  return response
}
```

### ARCH-04: OpenAI Model Tiers Not Differentiated

**Finding (Architecture Expert H17):** `getModelByConfig()` maps ALL model hints to `gpt-5-mini` when using OpenAI. There's no distinction between haiku-tier (cheap/fast) and opus-tier (expensive/capable) workloads.

**Fix:** Map to appropriate OpenAI models:
```typescript
if (env.OPENAI_API_KEY) {
  if (modelName?.includes('haiku')) return new ChatOpenAI({ model: 'gpt-4o-mini', ... })
  if (modelName?.includes('opus')) return new ChatOpenAI({ model: 'o3', ... })
  return new ChatOpenAI({ model: 'gpt-5-mini', ... })  // Sonnet equivalent
}
```

### ARCH-05: Preferences/Profile Namespaces Never Written

**Finding (Architecture Expert):** The Store namespace registry declares `[userId, "profile"]` for tech stack preferences, but no code ever writes to this namespace. `storeUserDefaults()` only writes clarification answers, not tech stack preferences.

**Fix:** Add `storeUserProfile()` call in `publish()` node:
```typescript
await store.put(
  [state.userId, 'profile'],
  'tech-stack',
  {
    text: `Preferred: ${formatStack(state.intakeData.techStack)}`,
    ...state.intakeData.techStack,
    lastUsed: new Date().toISOString(),
  }
)
```

---

## 4. Updated Sprint M1 (Pre-Sprint Fixes)

Add these tasks BEFORE the current Sprint M1:

| # | Task | Effort | Priority |
|---|------|--------|----------|
| M0-01 | Wire Store to all 5 graphs (BUG-01) | 1h | CRITICAL |
| M0-02 | Add LLM retry + fallback (BUG-02) | 2h | CRITICAL |
| M0-03 | Fix PrismaClient singletons (BUG-03) | 30m | CRITICAL |
| M0-04 | Add undeclared vars to STANDARD_VARIABLES (PROMPT-02) | 1h | HIGH |
| M0-05 | Inject memory context into generation nodes (PROMPT-04) | 2h | HIGH |
| M0-06 | Add per-node cost tracking (ARCH-03) | 1.5h | MEDIUM |
| **Total** | | **8h** | |

This becomes **Sprint M0: Critical Fixes** that must run before any memory plan work.

---

## 5. Updated Dependency Graph

```
Sprint M0 (Critical Fixes) — 8h
  ├── M0-01: Wire Store to all graphs    ← BLOCKS all memory work
  ├── M0-02: LLM retry/fallback          ← BLOCKS production reliability
  ├── M0-03: Fix PrismaClient singletons ← BLOCKS production stability
  ├── M0-04: Fix undeclared variables     ← BLOCKS template validation
  ├── M0-05: Memory in generation nodes   ← BLOCKS convention enforcement
  └── M0-06: Per-node cost tracking       ← Independent, can parallel

Sprint M1 (Foundation) — 16h [unchanged, depends on M0]
  └── Store embeddings, semantic search fixes, conversation management

Sprint M2 (Feature Abstraction) — 16h [updated]
  ├── FeatureSpec model + service
  ├── Tech-stack-aware prompt resolution
  ├── Stack-specific seed templates (12 minimum)
  ├── Pluggable extractContract() (ARCH-01)          ← NEW
  └── Framework-aware token budget (ARCH-02)          ← NEW

Sprint M3 (Cross-Stack RAG) — 14h [updated]
  ├── Cross-stack retrieval service
  ├── Anthropic prompt caching (PROMPT-05)            ← NEW
  ├── RAG effectiveness tracking
  └── OpenAI model tier mapping (ARCH-04)             ← NEW

Sprint M4 (Consolidation + Cross-Intent) — 10h [unchanged]
```

**New total estimated effort: ~64h (was 53h + 8h critical fixes + 3h new items)**

---

## 6. Summary of All Expert Recommendations

| ID | Finding | Severity | Sprint | Document |
|----|---------|----------|--------|----------|
| BUG-01 | Store not wired to 4/5 graphs | CRITICAL | M0 | 11 (this) |
| BUG-02 | No LLM retry/fallback | CRITICAL | M0 | 11 (this) |
| BUG-03 | Multiple PrismaClient instances | CRITICAL | M0 | 11 (this) |
| BUG-04 | Store search broken (no embeddings) | CRITICAL | M1 | 03 |
| BUG-05 | getStore() returns undefined silently | HIGH | M0 | 11 (this) |
| PROMPT-01 | Templates hardcoded to Vue3/Express | BLOCKING | M2 | 07, 11 |
| PROMPT-02 | Undeclared template variables | HIGH | M0 | 11 (this) |
| PROMPT-03 | Partial system is dead code | MEDIUM | M2 | 07 |
| PROMPT-04 | Memory only in 2/12 nodes | HIGH | M0 | 11 (this) |
| PROMPT-05 | No Anthropic prompt caching | MEDIUM | M3 | 11 (this) |
| ARCH-01 | extractContract() Express-only | HIGH | M2 | 11 (this) |
| ARCH-02 | Token budget framework-unaware | MEDIUM | M2 | 11 (this) |
| ARCH-03 | Cost tracking only at publish | MEDIUM | M0 | 11 (this) |
| ARCH-04 | OpenAI tiers not differentiated | LOW | M3 | 11 (this) |
| ARCH-05 | User profile namespace never written | LOW | M1 | 11 (this) |
| H13 | Duplicate utility functions | LOW | M4 | — |
| H14 | Tool result timing issues | LOW | M4 | — |
