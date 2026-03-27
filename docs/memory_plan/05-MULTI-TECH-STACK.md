# 05 — Multi-Tech-Stack Generation

> **Agent:** system-architect + langchain-ts-expert
> **Priority:** P1
> **Depends on:** 02-FEATURE-ABSTRACTION, 03-STORE-INTEGRATION
> **Effort:** 12h

---

## 1. Problem Statement

StarterForge currently generates features for a single tech stack per feature. The `TechStack` type supports:

```typescript
interface TechStack {
  frontend: 'vue3' | 'react' | 'none'
  backend: 'express' | 'fastify' | 'none'
  language: 'typescript' | 'javascript'
  database: 'prisma' | 'mongoose' | 'none'
  styling: 'tailwind' | 'css-modules' | 'none'
  testing: 'vitest' | 'jest' | 'none'
}
```

The `framework-adaptation.service.ts` provides basic file-by-file adaptation rules (vue3→react, express→fastify, etc.), but:

1. **Adaptation is file-level, not feature-level**: Each file is adapted independently with no cross-file consistency
2. **No structural adaptation**: Express routes map directly to FastAPI routes? No — the entire architecture differs
3. **No shared memory**: Adapting Feature A doesn't help adapt Feature B
4. **Backend adaptation is path-only**: Frontend gets LLM adaptation, but backend files just get path remapping without content changes
5. **No validation after adaptation**: Adapted code isn't validated or tested

### The Vision

```
User creates FeatureSpec: "User Authentication with JWT, refresh tokens, RBAC"
  │
  ├─▶ Generate for Vue3 + Express + Prisma (primary)
  │     → 15 files, quality: 92/100, all tests pass
  │
  ├─▶ Generate for React + FastAPI + SQLAlchemy (from same spec)
  │     → Uses Vue3 implementation as reference
  │     → Adapts architecture to FastAPI patterns
  │     → 14 files, quality: 88/100
  │
  └─▶ Generate for Svelte + NestJS + TypeORM
        → Uses both previous implementations as reference
        → 16 files, quality: 90/100
```

## 2. Extended Tech Stack Support

### 2.1 Expanded TechStack Type

```typescript
export interface TechStack {
  frontend: 'vue3' | 'react' | 'svelte' | 'nextjs' | 'nuxt' | 'none'
  backend: 'express' | 'fastify' | 'nestjs' | 'hono' | 'none'
  language: 'typescript' | 'javascript' | 'python'  // Future: python for FastAPI
  database: 'prisma' | 'typeorm' | 'drizzle' | 'mongoose' | 'none'
  styling: 'tailwind' | 'css-modules' | 'shadcn' | 'none'
  testing: 'vitest' | 'jest' | 'playwright' | 'none'
  // NEW fields:
  runtime?: 'node' | 'deno' | 'bun'
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun'
  deployment?: 'docker' | 'vercel' | 'railway' | 'none'
}
```

### 2.2 Stack Compatibility Matrix

Not all combinations make sense. Define valid combinations:

```typescript
const STACK_COMPATIBILITY: Record<string, string[]> = {
  // Frontend → compatible backends
  'vue3': ['express', 'fastify', 'hono', 'nestjs'],
  'react': ['express', 'fastify', 'nestjs', 'hono'],
  'svelte': ['express', 'fastify', 'hono'],
  'nextjs': ['none'],  // Next.js IS the backend
  'nuxt': ['none'],    // Nuxt IS the backend

  // Database ORM → compatible languages
  'prisma': ['typescript', 'javascript'],
  'typeorm': ['typescript'],
  'drizzle': ['typescript'],
  'mongoose': ['typescript', 'javascript'],
}
```

## 3. Generation Strategies

### 3.1 Strategy Selection

When generating a FeatureSpec for a new tech stack, three strategies are available:

```
Strategy 1: FRESH GENERATION (no prior implementations)
  → Full 12-node pipeline from scratch
  → Tech-stack-specific prompts guide generation
  → RAG retrieval searches for similar features in target stack

Strategy 2: REFERENCE GENERATION (prior implementation exists)
  → Use existing implementation as a reference (not a template)
  → LLM generates new code guided by the reference patterns
  → Structural adaptation (not file-by-file translation)
  → Cross-stack lessons inform the plan

Strategy 3: HYBRID ADAPTATION (prior impl + adaptation rules)
  → For closely related stacks (Vue3→React, Express→Fastify)
  → Structural adaptation rules define the mapping
  → LLM fills gaps where rules don't apply
  → Validate and test the adapted code
```

### 3.2 Strategy Selection Logic

```typescript
export function selectAdaptationStrategy(
  featureSpec: FeatureSpec,
  targetStack: TechStack,
  existingImpls: FeatureImplementation[],
): 'fresh' | 'reference' | 'hybrid' {
  if (existingImpls.length === 0) return 'fresh'

  // Find closest existing implementation
  const closest = findClosestStack(targetStack, existingImpls)
  if (!closest) return 'fresh'

  const distance = computeStackDistance(closest.techStack, targetStack)

  // Distance 1: Only one component differs (e.g., Vue→React, everything else same)
  if (distance <= 1) return 'hybrid'

  // Distance 2-3: Multiple components differ but same language
  if (distance <= 3 && closest.techStack.language === targetStack.language) return 'reference'

  // Distance 4+: Very different stacks
  return 'reference'
}

function computeStackDistance(a: TechStack, b: TechStack): number {
  let distance = 0
  if (a.frontend !== b.frontend) distance++
  if (a.backend !== b.backend) distance++
  if (a.database !== b.database) distance++
  if (a.language !== b.language) distance += 2  // Language change is high impact
  if (a.styling !== b.styling) distance++
  if (a.testing !== b.testing) distance++
  return distance
}
```

## 4. Reference Generation Pipeline

### 4.1 Enhanced Plan Node

When a reference implementation exists, the plan node receives it as context:

```typescript
async function plan(state: FeatureGeneratorState): Promise<Partial<FeatureGeneratorState>> {
  // ... existing code ...

  // NEW: Load reference implementation if generating for different stack
  let referenceImplementation: ReferenceImplementation | null = null
  if (state.featureSpecId) {
    const impls = await featureSpecService.getImplementations(state.featureSpecId)
    const otherStackImpls = impls.filter(
      i => i.techStackKey !== techStackKey(state.intakeData!.techStack)
    )
    if (otherStackImpls.length > 0) {
      // Pick highest quality implementation as reference
      const best = otherStackImpls.sort((a, b) => b.quality - a.quality)[0]!
      referenceImplementation = {
        techStack: best.techStack as TechStack,
        files: await loadImplementationFiles(best.id),
        quality: best.quality,
        apiContract: best.apiContract as ApiContract | null,
      }
    }
  }

  // Inject reference into system prompt
  if (referenceImplementation) {
    systemContent += buildReferenceImplementationContext(
      referenceImplementation,
      state.intakeData!.techStack,
    )
  }

  return {
    ...summaryUpdate,
    messages: [response],
    featurePlan,
    referenceFeature,
    referenceImplementation,  // NEW state field
    phase: nextPhase,
  }
}
```

### 4.2 Reference Context Builder

```typescript
function buildReferenceImplementationContext(
  ref: ReferenceImplementation,
  targetStack: TechStack,
): string {
  const sourceStack = ref.techStack

  const sections: string[] = [
    `\n\n## Cross-Stack Reference Implementation`,
    `\nThis feature has been successfully generated for ${formatStack(sourceStack)} with quality ${ref.quality}/100.`,
    `You are generating it for ${formatStack(targetStack)}.\n`,
  ]

  // Architecture mapping guidance
  const archDiffs = computeArchitectureDifferences(sourceStack, targetStack)
  if (archDiffs.length > 0) {
    sections.push(`### Architecture Differences\n${archDiffs.map(d => `- ${d}`).join('\n')}`)
  }

  // API contract from reference (if available)
  if (ref.apiContract) {
    sections.push(`### Reference API Contract\n` +
      `The reference implementation exposes these endpoints:\n` +
      ref.apiContract.endpoints.map(e =>
        `- ${e.method.toUpperCase()} ${e.path}${e.auth ? ' [AUTH]' : ''}`
      ).join('\n') +
      `\n\nMaintain the same API surface but adapt to ${targetStack.backend} conventions.`
    )
  }

  // File structure overview (not full content — too large)
  const filePaths = Object.keys(ref.files)
  sections.push(`### Reference File Structure (${filePaths.length} files)\n` +
    filePaths.map(p => `- ${p}`).join('\n') +
    `\n\nAdapt this structure to ${targetStack.backend}/${targetStack.frontend} conventions.`
  )

  // Adaptation rules (from framework-adaptation.service.ts)
  const guide = ADAPTATION_GUIDES[`${sourceStack.frontend}->${targetStack.frontend}`]
  if (guide) {
    sections.push(`### Frontend Adaptation Guide\n${guide}`)
  }

  const backendGuide = BACKEND_ADAPTATION_GUIDES[`${sourceStack.backend}->${targetStack.backend}`]
  if (backendGuide) {
    sections.push(`### Backend Adaptation Guide\n${backendGuide}`)
  }

  return sections.join('\n\n')
}
```

### 4.3 Per-Layer Reference Injection

Each generation node receives only the relevant layer from the reference:

```typescript
// In generateBackend():
if (state.referenceImplementation) {
  const backendFiles = Object.entries(state.referenceImplementation.files)
    .filter(([path]) =>
      path.includes('/services/') ||
      path.includes('/controllers/') ||
      path.includes('/routes/') ||
      path.includes('/middleware/')
    )

  if (backendFiles.length > 0) {
    const refContext = backendFiles
      .slice(0, 3)  // Top 3 most relevant
      .map(([path, content]) =>
        `### Reference: ${path}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``
      ).join('\n\n')

    systemContent += `\n\n## Reference Backend (${formatStack(state.referenceImplementation.techStack)})\n\n` +
      `Use as a pattern guide. Generate equivalent functionality for ${state.intakeData!.techStack.backend}.\n\n` +
      refContext
  }
}
```

## 5. Hybrid Adaptation Pipeline

For closely related stacks (distance <= 1), we can be smarter:

### 5.1 Structural Mapping Rules

```typescript
// Enhanced framework-adaptation.service.ts

interface StructuralAdaptation {
  fileMapping: Record<string, string>      // Source path pattern → target path pattern
  contentRules: ContentAdaptationRule[]    // Semantic content transformations
  newFilesNeeded: string[]                 // Files that don't exist in source
  removedFiles: string[]                   // Source files not needed in target
}

const STRUCTURAL_ADAPTATIONS: Record<string, StructuralAdaptation> = {
  'express->fastify': {
    fileMapping: {
      'src/routes/*.routes.ts': 'src/routes/*.routes.ts',
      'src/controllers/*.controller.ts': 'src/routes/*.routes.ts',  // Merged
      'src/middleware/*.ts': 'src/plugins/*.plugin.ts',
    },
    contentRules: [
      { from: 'express.Router()', to: 'FastifyPluginAsync' },
      { from: 'req.body', to: 'request.body' },
      { from: 'res.status(N).json()', to: 'reply.code(N).send()' },
      { from: 'express.json()', to: 'fastify.register(fastifyPlugin)' },
    ],
    newFilesNeeded: ['src/plugins/prisma.plugin.ts'],
    removedFiles: [],
  },

  'vue3->react': {
    fileMapping: {
      'src/components/*.vue': 'src/components/*.tsx',
      'src/stores/*.ts': 'src/stores/*.ts',  // Pinia → Zustand
      'src/composables/*.ts': 'src/hooks/*.ts',
      'src/views/*.vue': 'src/pages/*.tsx',
    },
    contentRules: [
      { from: '<template>...</template><script setup>', to: 'JSX function component' },
      { from: 'defineProps', to: 'function props parameter' },
      { from: 'ref()', to: 'useState()' },
      { from: 'computed()', to: 'useMemo()' },
      { from: 'watch()', to: 'useEffect()' },
      { from: 'defineEmits', to: 'callback props' },
    ],
    newFilesNeeded: [],
    removedFiles: [],
  },
}
```

### 5.2 Hybrid Generation Flow

```
1. Load source implementation files
2. Apply structural mapping (file paths)
3. For each target file:
   a. Find corresponding source file(s)
   b. If contentRules exist → apply rule-based transformation first
   c. Pass partially-transformed code + full context to LLM
   d. LLM completes the adaptation with full understanding
4. Generate newFilesNeeded from scratch with full context
5. Run validation + tests on adapted code
6. Store as new FeatureImplementation
```

## 6. Memory Integration

### 6.1 Adaptation Lessons

When an adaptation requires fix cycles, store the lesson with cross-stack context:

```typescript
await store.put(
  [tenantId, 'lessons'],
  `adaptation-${Date.now()}`,
  {
    text: `Adapting "${featureName}" from ${sourceStackKey} to ${targetStackKey}: ${lesson}`,
    category,
    sourceStack: sourceStackKey,
    targetStack: targetStackKey,
    adaptationType: strategy,  // 'hybrid' | 'reference'
    errorTypes: [...],
    fixStrategy: '...',
    timestamp: new Date().toISOString(),
  },
  { index: ['text'] }
)
```

### 6.2 Cross-Stack Convention Memory

After successful adaptation, store patterns that worked:

```typescript
await store.put(
  [tenantId, 'cross-stack-patterns'],
  `${sourceStackKey}->${targetStackKey}:${category}`,
  {
    text: `Successful ${category} adaptation from ${sourceStackKey} to ${targetStackKey}`,
    patterns: extractedPatterns,  // What structural mappings worked
    quality: validationResult.quality,
    timestamp: new Date().toISOString(),
  },
  { index: ['text'] }
)
```

## 7. State Changes

```typescript
// New state fields for multi-stack support:

referenceImplementation: Annotation<{
  techStack: TechStack
  files: Record<string, string>
  quality: number
  apiContract: ApiContract | null
} | null>({
  reducer: (_, next) => next,
  default: () => null,
}),

featureSpecId: Annotation<string>({
  reducer: (_, next) => next,
  default: () => '',
}),

adaptationStrategy: Annotation<'fresh' | 'reference' | 'hybrid'>({
  reducer: (_, next) => next,
  default: () => 'fresh' as const,
}),
```

## 8. Frontend UX Flow

```
User selects feature → "User Authentication"
  │
  ├─▶ Sees existing implementations:
  │     ✅ Vue3 + Express (quality: 92)
  │     ✅ React + FastAPI (quality: 88)
  │     ❌ Svelte + NestJS (not generated)
  │
  ├─▶ Clicks "Generate for Svelte + NestJS"
  │     → System detects: existing Vue3+Express reference
  │     → Selects "reference" strategy (distance=3)
  │     → Skips clarification (reuses FeatureSpec answers)
  │     → Plan node shows: "Adapting from Vue3+Express reference"
  │
  └─▶ Generation proceeds with reference context
        → Faster (skips clarify), better quality (learns from prior impl)
```

## 9. Acceptance Criteria

- [ ] `FeatureSpec` → `FeatureImplementation` separation implemented
- [ ] Strategy selection (fresh/reference/hybrid) works correctly
- [ ] Reference implementation context injected into plan + generate nodes
- [ ] Per-layer reference filtering (backend files for backend node, etc.)
- [ ] Adaptation lessons stored with cross-stack metadata
- [ ] UI shows available implementations per FeatureSpec
- [ ] "Generate for different stack" workflow skips already-answered clarification
- [ ] Adapted features achieve quality within 10% of fresh generation
- [ ] Structural adaptation rules for Vue3↔React, Express↔Fastify
