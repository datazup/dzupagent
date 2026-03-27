# 07 — Prompt Management for Multi-Stack Generation

> **Agent:** system-architect
> **Priority:** P1
> **Depends on:** 01-ARCHITECTURE, 05-MULTI-TECH-STACK
> **Effort:** 4h

---

## 1. Current Prompt Architecture

### Prompt Resolution Chain

```
resolveNodePrompt(nodeType, context, overrides, tenantId, userId, category)
  │
  ├─▶ Check: explicit override (promptOverrides map)
  │
  ├─▶ Check: promptCache (in-memory TTL 5min)
  │     Key: "nodeType|category" or "nodeType|"
  │
  ├─▶ DB query: user + tenant + builtin
  │     Priority: user-specific > tenant-specific > builtin
  │     Category: category-specific > general
  │
  └─▶ Fallback: buildFallbackPrompt() (hardcoded)
```

### Prompt Template Variables

Currently 30+ variables available via `buildPromptContext()`:
- Feature metadata: `feature_name`, `feature_id`, `feature_description`, `feature_category`
- Tech stack: `frontend_framework`, `backend_framework`, `language`, `database_orm`, etc.
- Generation context: `feature_plan`, `existing_files`, `api_contract`, `reference_code_examples`
- Quality: `validation_errors`, `test_results`, `quality_score`, `quality_breakdown`
- Memory: `conversation_summary`

### Template Engine

`resolveTemplateContent()` in `template-engine.ts` supports:
- `{{variable}}` substitution
- `{{#if variable}}...{{/if}}` conditionals
- `{{#each variable}}...{{/each}}` loops
- `{{> partial}}` partial includes

### Current Gap

**Prompts are NOT tech-stack-aware.** The same prompt generates Vue3 code and (theoretically) React code. The only tech-stack context comes from variables like `{{frontend_framework}}` and `{{backend_framework}}`, but the prompt body itself doesn't adapt.

Example: The `feature_generate_frontend` prompt says "Generate Vue components" regardless of whether the tech stack is Vue or React.

## 2. Tech-Stack-Aware Prompt Strategy

### 2.1 Prompt Resolution Enhancement

Add tech stack to the resolution chain:

```
CURRENT:  type + category → template
PROPOSED: type + category + techStackKey → template

Resolution priority:
  1. Explicit override
  2. User + type + category + techStackKey (most specific)
  3. User + type + category
  4. Tenant + type + category + techStackKey
  5. Tenant + type + category
  6. Builtin + type + category + techStackKey
  7. Builtin + type + category
  8. Builtin + type only
  9. Fallback hardcoded
```

### 2.2 PromptTemplate Schema Enhancement

```prisma
model PromptTemplate {
  id          String   @id @default(cuid())
  type        String   // "feature_generate_backend", etc.
  category    String?  // "auth", "payments", etc.
  techStack   String?  // NEW: "vue3:express:prisma" or null for universal
  content     String   @db.Text
  variables   Json     @default("[]")
  config      Json     @default("{}")  // model, temperature, maxTokens
  isActive    Boolean  @default(true)
  isBuiltin   Boolean  @default(false)
  tenantId    String?
  userId      String?
  // ...

  @@unique([type, category, techStack, tenantId, userId])
  @@index([type, isActive])
}
```

### 2.3 Enhanced Resolution

```typescript
async function resolveNodePrompt(
  nodeType: string,
  context: Record<string, string>,
  overrides?: Record<string, string>,
  tenantId?: string,
  userId?: string,
  category?: string,
  promptCache?: PromptCacheMap | null,
  techStackKey?: string,  // NEW parameter
): Promise<ResolvedPrompt> {
  // ... existing override check ...

  // Enhanced cache lookup: try techStack-specific first
  if (!template && promptCache && !overrideId) {
    if (techStackKey && category) {
      const cached = promptCache[`${nodeType}|${category}|${techStackKey}`]
      if (cached) return resolveFromCache(cached, context)
    }
    if (techStackKey) {
      const cached = promptCache[`${nodeType}||${techStackKey}`]
      if (cached) return resolveFromCache(cached, context)
    }
    // ... existing category-only and general lookups ...
  }

  // Enhanced DB query: include techStack in search
  if (!template && techStackKey) {
    template = await prisma.promptTemplate.findFirst({
      where: {
        type: nodeType,
        techStack: techStackKey,
        ...(category ? { category } : {}),
        isActive: true,
        OR: buildPriorityFilter(tenantId, userId),
      },
      orderBy: buildPriorityOrder(),
      select: { content: true, variables: true, config: true },
    })
  }

  // ... existing fallback chain ...
}
```

## 3. Prompt Templates Per Tech Stack

### 3.1 Backend Generation Prompts

**Express (default):**
```markdown
You are generating an Express.js backend service using TypeScript.

## Architecture
- Services: Business logic classes with constructor injection (PrismaClient)
- Controllers: Express request handlers that delegate to services
- Routes: Express.Router() with middleware chain
- Validators: Zod schemas for request/response validation

## Express Conventions
- Use `express.Router()` for route groups
- Middleware chain: `router.use(authenticate, authorize('role'))`
- Error handling: throw AppError, caught by global error handler
- Response format: `res.status(200).json({ data, meta })`
```

**Fastify:**
```markdown
You are generating a Fastify backend service using TypeScript.

## Architecture
- Services: Business logic classes (same as Express)
- Routes: Fastify route handlers with schema validation
- Plugins: Fastify plugins for cross-cutting concerns

## Fastify Conventions
- Use `FastifyPluginAsync` for route registration
- Schema validation: JSON Schema in route opts (NOT Zod at runtime)
- Error handling: `reply.code(400).send({ error: { message, code } })`
- Decorators: `fastify.decorate('prisma', prismaClient)`
```

**NestJS:**
```markdown
You are generating a NestJS backend service using TypeScript.

## Architecture
- Modules: Feature modules with providers, controllers, imports
- Services: Injectable services with @Injectable() decorator
- Controllers: @Controller() with @Get(), @Post(), etc.
- DTOs: class-validator DTOs for validation
- Guards: Authentication and authorization guards

## NestJS Conventions
- Use dependency injection (constructor parameters)
- Validation: class-validator + class-transformer pipes
- Error handling: throw HttpException or custom exception filters
- Response: return from controller (auto-serialized)
```

### 3.2 Frontend Generation Prompts

**Vue 3:**
```markdown
## Vue 3 Conventions
- Composition API with `<script setup lang="ts">`
- State: `ref()`, `reactive()`, `computed()`
- Props: `defineProps<{...}>()` with TypeScript generics
- Events: `defineEmits<{...}>()`
- Stores: Pinia `defineStore()` with setup syntax
- Routing: Vue Router with `<RouterLink>` and `useRouter()`
- Styling: Tailwind CSS 4 utility classes in `<template>`
```

**React:**
```markdown
## React Conventions
- Functional components with TypeScript
- State: `useState()`, `useReducer()`
- Side effects: `useEffect()` with dependency arrays
- Props: TypeScript interface as function parameter
- Stores: Zustand or React Context
- Routing: React Router v7 with `<Link>` and `useNavigate()`
- Styling: Tailwind CSS 4 utility classes in JSX className
```

**Svelte:**
```markdown
## Svelte 5 Conventions
- Runes: `$state`, `$derived`, `$effect`, `$props`
- Components: `.svelte` files with `<script lang="ts">`
- Props: `let { prop } = $props()`
- Events: callback props or CustomEvent dispatch
- Stores: Svelte stores with `$` auto-subscription
- Routing: SvelteKit file-based routing
- Styling: Scoped `<style>` blocks + Tailwind
```

### 3.3 Database Generation Prompts

**Prisma (default):**
```markdown
## Prisma Conventions
- Models in `schema.prisma` with `@id @default(cuid())`
- Relations: `@relation(fields: [...], references: [...])`
- Indexes: `@@index([field])`, `@@unique([field1, field2])`
- Enums: `enum Status { ACTIVE INACTIVE }`
- Soft deletes: `deletedAt DateTime?`
- Tenant isolation: `tenantId String` on all models
```

**TypeORM:**
```markdown
## TypeORM Conventions
- Entity classes with `@Entity()` decorator
- Primary keys: `@PrimaryGeneratedColumn('uuid')`
- Relations: `@ManyToOne()`, `@OneToMany()`, `@JoinColumn()`
- Indexes: `@Index(['field'])`, `@Unique(['field1', 'field2'])`
- Columns: `@Column({ type: 'varchar', length: 255 })`
- Migrations: TypeORM CLI-generated migration files
```

**Drizzle:**
```markdown
## Drizzle Conventions
- Schema in TypeScript files with `pgTable()`, `mysqlTable()`
- Relations: `relations()` helper for type-safe joins
- Indexes: `index('name').on(table.field)`
- Queries: `db.select().from(table).where(eq(table.id, id))`
- Migrations: drizzle-kit push/generate
```

## 4. Prompt Cache Enhancement

### 4.1 Extended Cache Key

```typescript
// Current: "nodeType|category"
// New: "nodeType|category|techStackKey"

const cacheKey = techStackKey
  ? `${t.type}|${t.category ?? ''}|${t.techStack ?? ''}`
  : `${t.type}|${t.category ?? ''}`
```

### 4.2 Prompt Template Seeding

Create a seeding script that generates builtin prompts for each supported tech stack:

```typescript
// apps/api/prisma/seeds/prompt-templates-multistack.ts

const TECH_STACKS = [
  'vue3:express:prisma:tailwind:vitest',
  'react:express:prisma:tailwind:vitest',
  'vue3:fastify:prisma:tailwind:vitest',
  'react:nestjs:typeorm:tailwind:jest',
  'svelte:express:prisma:tailwind:vitest',
]

const NODE_TYPES = [
  'feature_generate_backend',
  'feature_generate_frontend',
  'feature_generate_db',
  'feature_generate_tests',
]

for (const stackKey of TECH_STACKS) {
  for (const nodeType of NODE_TYPES) {
    const content = getStackSpecificPrompt(nodeType, stackKey)
    await prisma.promptTemplate.upsert({
      where: { type_category_techStack_tenantId_userId: {
        type: nodeType,
        category: null,
        techStack: stackKey,
        tenantId: null,
        userId: null,
      }},
      update: { content },
      create: {
        type: nodeType,
        techStack: stackKey,
        content,
        isBuiltin: true,
        isActive: true,
      },
    })
  }
}
```

## 5. Dynamic Context Injection

### 5.1 New Template Variables for Multi-Stack

```typescript
// Add to buildPromptContext():
const ctx = {
  ...existingContext,

  // NEW variables for multi-stack support
  tech_stack_key: techStackKey(state.intakeData?.techStack),
  has_reference_implementation: state.referenceImplementation ? 'true' : 'false',
  reference_tech_stack: state.referenceImplementation
    ? formatStack(state.referenceImplementation.techStack)
    : 'none',
  adaptation_strategy: state.adaptationStrategy ?? 'fresh',
  cross_stack_reference: state.crossStackReferences?.length
    ? crossStackRagService.buildCrossStackPromptContext({
        references: state.crossStackReferences,
        layer: currentLayer,
        targetStack: state.intakeData!.techStack,
        maxFiles: 3,
        maxCharsPerFile: 3000,
      })
    : 'None available',

  // Memory context
  project_conventions: state.memoryCache?.['conventions'] ?? '',
  generation_lessons: state.memoryCache?.['lessons'] ?? '',
  shared_types: state.memoryCache?.['sharedTypes'] ?? '',
}
```

### 5.2 Memory Context in Prompts

```markdown
{{#if project_conventions}}
## Project Conventions (from previous features)
{{project_conventions}}
Follow these established conventions for consistency.
{{/if}}

{{#if generation_lessons}}
## Lessons from Previous Generations
{{generation_lessons}}
{{/if}}

{{#if shared_types}}
## Shared Types (reuse these — do not redefine)
{{shared_types}}
{{/if}}

{{#if cross_stack_reference}}
## Cross-Stack Reference Code
{{cross_stack_reference}}
{{/if}}
```

## 6. Prompt Effectiveness Tracking

### 6.1 Correlate Prompts with Outcomes

After publish, record which prompt version produced what quality:

```typescript
// Store prompt effectiveness data
if (state.promptCache && state.validationResult) {
  const effectiveness = {
    quality: state.validationResult.quality,
    fixAttempts: state.fixAttempts,
    category: state.intakeData?.category,
    techStack: techStackKey(state.intakeData?.techStack),
    timestamp: new Date().toISOString(),
  }

  for (const [key] of Object.entries(state.promptCache)) {
    await store.put(
      [state.tenantId, 'prompt-effectiveness'],
      `${key}:${Date.now()}`,
      {
        text: `Prompt ${key} → quality ${effectiveness.quality}, fixes ${effectiveness.fixAttempts}`,
        promptKey: key,
        ...effectiveness,
      },
      { index: ['text'] }
    )
  }
}
```

## 7. Acceptance Criteria

- [ ] PromptTemplate model supports `techStack` field
- [ ] Resolution chain includes techStack-specific lookup
- [ ] Builtin prompts exist for Vue3, React, Svelte frontends
- [ ] Builtin prompts exist for Express, Fastify, NestJS backends
- [ ] Builtin prompts exist for Prisma, TypeORM, Drizzle ORMs
- [ ] Prompt cache key includes techStack dimension
- [ ] New template variables available: `tech_stack_key`, `cross_stack_reference`, etc.
- [ ] Memory context variables (`project_conventions`, `generation_lessons`) injectable
- [ ] Prompt effectiveness tracked per prompt version + tech stack
