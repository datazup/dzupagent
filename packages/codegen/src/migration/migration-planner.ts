/**
 * Cross-framework migration planner.
 *
 * Provides structured migration plans, scope analysis, and LLM prompt
 * generation for transforming codebases between frameworks.
 */

export type MigrationTarget =
  | 'vue3-to-react'
  | 'react-to-vue3'
  | 'express-to-fastify'
  | 'fastify-to-express'
  | 'pinia-to-redux'
  | 'prisma-to-drizzle'

export interface MigrationStep {
  order: number
  name: string
  description: string
  sourcePattern: string
  targetPattern: string
  transformHint: string
}

export interface MigrationPlan {
  target: MigrationTarget
  steps: MigrationStep[]
  estimatedFiles: number
  riskLevel: 'low' | 'medium' | 'high'
  prerequisites: string[]
}

// ---------------------------------------------------------------------------
// Built-in migration plans
// ---------------------------------------------------------------------------

const PLANS: Record<MigrationTarget, Omit<MigrationPlan, 'target'>> = {
  'vue3-to-react': {
    steps: [
      {
        order: 1,
        name: 'SFC to TSX',
        description: 'Convert Vue Single-File Components (.vue) to React TSX components',
        sourcePattern: '**/*.vue',
        targetPattern: '**/*.tsx',
        transformHint:
          'Convert <template> to JSX return, <script setup> to function body, ' +
          '<style scoped> to CSS module import. Replace v-if with conditional rendering, ' +
          'v-for with .map(), @click with onClick, v-model with value+onChange.',
      },
      {
        order: 2,
        name: 'Composition API to Hooks',
        description: 'Convert ref/reactive/computed/watch to useState/useMemo/useEffect',
        sourcePattern: '**/*.{vue,ts}',
        targetPattern: '**/*.{tsx,ts}',
        transformHint:
          'ref() -> useState(), reactive() -> useState() with object, computed() -> useMemo(), ' +
          'watch()/watchEffect() -> useEffect(), onMounted() -> useEffect(..., []).',
      },
      {
        order: 3,
        name: 'Pinia to State Management',
        description: 'Convert Pinia stores to React context/Zustand stores',
        sourcePattern: '**/stores/**/*.ts',
        targetPattern: '**/stores/**/*.ts',
        transformHint:
          'Convert defineStore() to a Zustand create() or React context + useReducer. ' +
          'Map state properties to store state, getters to derived selectors, actions to store actions.',
      },
      {
        order: 4,
        name: 'Vue Router to React Router',
        description: 'Convert Vue Router route definitions to React Router configuration',
        sourcePattern: '**/router/**/*.ts',
        targetPattern: '**/router/**/*.tsx',
        transformHint:
          'Convert createRouter routes array to React Router <Route> elements or createBrowserRouter config. ' +
          'Replace useRouter()/useRoute() with useNavigate()/useParams()/useLocation(). ' +
          'Convert route guards to loader functions or wrapper components.',
      },
    ],
    estimatedFiles: 30,
    riskLevel: 'high',
    prerequisites: ['react', 'react-dom', '@types/react', 'react-router-dom'],
  },

  'react-to-vue3': {
    steps: [
      {
        order: 1,
        name: 'TSX to SFC',
        description: 'Convert React TSX components to Vue 3 Single-File Components',
        sourcePattern: '**/*.tsx',
        targetPattern: '**/*.vue',
        transformHint:
          'Create <script setup lang="ts">, <template>, and <style scoped> sections. ' +
          'Convert JSX to template syntax: conditional rendering to v-if, .map() to v-for, ' +
          'onClick to @click, className to class.',
      },
      {
        order: 2,
        name: 'Hooks to Composition API',
        description: 'Convert useState/useMemo/useEffect to ref/computed/watch',
        sourcePattern: '**/*.{tsx,ts}',
        targetPattern: '**/*.{vue,ts}',
        transformHint:
          'useState() -> ref() or reactive(), useMemo() -> computed(), ' +
          'useEffect() -> watch()/watchEffect()/onMounted(), useCallback() -> plain function.',
      },
      {
        order: 3,
        name: 'State to Pinia',
        description: 'Convert context/Zustand/Redux stores to Pinia',
        sourcePattern: '**/stores/**/*.ts',
        targetPattern: '**/stores/**/*.ts',
        transformHint:
          'Convert store definitions to defineStore() with state, getters, actions. ' +
          'Map selectors to getters, dispatch/actions to Pinia actions.',
      },
      {
        order: 4,
        name: 'React Router to Vue Router',
        description: 'Convert React Router config to Vue Router',
        sourcePattern: '**/router/**/*.{tsx,ts}',
        targetPattern: '**/router/**/*.ts',
        transformHint:
          'Convert Route elements to Vue Router routes array with createRouter(). ' +
          'Replace useNavigate() with useRouter().push(), useParams() with useRoute().params. ' +
          'Convert loader/wrapper patterns to navigation guards.',
      },
    ],
    estimatedFiles: 30,
    riskLevel: 'high',
    prerequisites: ['vue', 'vue-router', 'pinia'],
  },

  'express-to-fastify': {
    steps: [
      {
        order: 1,
        name: 'Route Handlers',
        description: 'Convert Express route handlers to Fastify route definitions',
        sourcePattern: '**/routes/**/*.ts',
        targetPattern: '**/routes/**/*.ts',
        transformHint:
          'Convert app.get/post/put/delete to fastify.route() or shorthand methods. ' +
          'Replace req.params/req.query/req.body with request.params/query/body with JSON Schema validation. ' +
          'Replace res.json()/res.status() with reply.send()/reply.code().',
      },
      {
        order: 2,
        name: 'Middleware to Plugins',
        description: 'Convert Express middleware to Fastify plugins and hooks',
        sourcePattern: '**/middleware/**/*.ts',
        targetPattern: '**/plugins/**/*.ts',
        transformHint:
          'Wrap middleware in fastify-plugin with fp(). Convert next() calls to Fastify lifecycle hooks ' +
          '(onRequest, preHandler, preValidation). Use decorateRequest() for request augmentation.',
      },
      {
        order: 3,
        name: 'Error Handling',
        description: 'Convert Express error middleware to Fastify error handler',
        sourcePattern: '**/middleware/error*.ts',
        targetPattern: '**/plugins/error-handler.ts',
        transformHint:
          'Convert (err, req, res, next) error middleware to fastify.setErrorHandler(). ' +
          'Use Fastify reply.code().send() instead of res.status().json().',
      },
      {
        order: 4,
        name: 'Validation Schemas',
        description: 'Convert Zod/Joi schemas to Fastify JSON Schema or TypeBox',
        sourcePattern: '**/schemas/**/*.ts',
        targetPattern: '**/schemas/**/*.ts',
        transformHint:
          'Convert Zod schemas to JSON Schema or @sinclair/typebox Type definitions. ' +
          'Attach schemas to route definitions using the schema option: { schema: { body, params, querystring } }.',
      },
      {
        order: 5,
        name: 'App Bootstrap',
        description: 'Convert Express app initialization to Fastify server setup',
        sourcePattern: '**/app.ts',
        targetPattern: '**/app.ts',
        transformHint:
          'Replace express() with Fastify({ logger: true }). Register plugins with fastify.register(). ' +
          'Convert app.use() calls to fastify.register() or fastify.addHook().',
      },
    ],
    estimatedFiles: 15,
    riskLevel: 'medium',
    prerequisites: ['fastify', '@fastify/cors', '@fastify/helmet', 'fastify-plugin'],
  },

  'fastify-to-express': {
    steps: [
      {
        order: 1,
        name: 'Route Definitions',
        description: 'Convert Fastify routes to Express route handlers',
        sourcePattern: '**/routes/**/*.ts',
        targetPattern: '**/routes/**/*.ts',
        transformHint:
          'Convert fastify.route()/get/post to router.get/post. ' +
          'Replace request.params/query/body with req.params/query/body. ' +
          'Replace reply.send()/code() with res.json()/status().',
      },
      {
        order: 2,
        name: 'Plugins to Middleware',
        description: 'Convert Fastify plugins to Express middleware',
        sourcePattern: '**/plugins/**/*.ts',
        targetPattern: '**/middleware/**/*.ts',
        transformHint:
          'Unwrap fp() plugin wrappers. Convert lifecycle hooks to (req, res, next) middleware. ' +
          'Replace decorateRequest() with req property augmentation in middleware.',
      },
      {
        order: 3,
        name: 'Error Handler',
        description: 'Convert Fastify error handler to Express error middleware',
        sourcePattern: '**/plugins/error*.ts',
        targetPattern: '**/middleware/error-handler.ts',
        transformHint:
          'Convert setErrorHandler to (err, req, res, next) Express middleware. ' +
          'Register error middleware last with app.use().',
      },
    ],
    estimatedFiles: 12,
    riskLevel: 'medium',
    prerequisites: ['express', '@types/express', 'cors', 'helmet'],
  },

  'pinia-to-redux': {
    steps: [
      {
        order: 1,
        name: 'Store Definitions',
        description: 'Convert Pinia defineStore to Redux Toolkit createSlice',
        sourcePattern: '**/stores/**/*.ts',
        targetPattern: '**/store/slices/**/*.ts',
        transformHint:
          'Convert defineStore({ state, getters, actions }) to createSlice({ initialState, reducers, extraReducers }). ' +
          'Map Pinia state to initialState, getters to selectors (with createSelector), actions to reducers or thunks.',
      },
      {
        order: 2,
        name: 'Store Setup',
        description: 'Create Redux store configuration with combined slices',
        sourcePattern: '**/stores/index.ts',
        targetPattern: '**/store/index.ts',
        transformHint:
          'Create configureStore() with reducer map combining all slices. ' +
          'Export typed RootState, AppDispatch, and typed hooks (useAppSelector, useAppDispatch).',
      },
      {
        order: 3,
        name: 'Store Usage',
        description: 'Convert Pinia useXxxStore() calls to Redux useSelector/useDispatch',
        sourcePattern: '**/*.{vue,tsx,ts}',
        targetPattern: '**/*.{vue,tsx,ts}',
        transformHint:
          'Replace const store = useXxxStore() with useAppSelector for reads and useAppDispatch for actions. ' +
          'Convert store.property to selector(state), store.action() to dispatch(action()).',
      },
    ],
    estimatedFiles: 10,
    riskLevel: 'medium',
    prerequisites: ['@reduxjs/toolkit', 'react-redux'],
  },

  'prisma-to-drizzle': {
    steps: [
      {
        order: 1,
        name: 'Schema Migration',
        description: 'Convert Prisma schema models to Drizzle table definitions',
        sourcePattern: '**/prisma/schema.prisma',
        targetPattern: '**/db/schema/**/*.ts',
        transformHint:
          'Convert each Prisma model to a pgTable()/mysqlTable() call. Map field types: ' +
          'String->text/varchar, Int->integer, Boolean->boolean, DateTime->timestamp, ' +
          'Json->jsonb. Convert @id to primaryKey(), @unique to unique(), @relation to relations().',
      },
      {
        order: 2,
        name: 'Migration Files',
        description: 'Generate Drizzle migration config and initial migration',
        sourcePattern: '**/prisma/migrations/**',
        targetPattern: '**/drizzle/**',
        transformHint:
          'Create drizzle.config.ts with schema path and migration output directory. ' +
          'Run drizzle-kit generate to create SQL migration files from the new schema.',
      },
      {
        order: 3,
        name: 'Query Translation',
        description: 'Convert Prisma Client queries to Drizzle query builder',
        sourcePattern: '**/*.ts',
        targetPattern: '**/*.ts',
        transformHint:
          'Convert prisma.model.findMany() to db.select().from(table), ' +
          'findUnique() to db.select().from(table).where(eq()), ' +
          'create() to db.insert(table).values(), ' +
          'update() to db.update(table).set().where(), ' +
          'delete() to db.delete(table).where(). Use Drizzle relations for includes.',
      },
      {
        order: 4,
        name: 'Type Inference',
        description: 'Replace Prisma generated types with Drizzle inferred types',
        sourcePattern: '**/*.ts',
        targetPattern: '**/*.ts',
        transformHint:
          'Replace Prisma-generated types (e.g., import { User } from "@prisma/client") with ' +
          'Drizzle inferred types: typeof users.$inferSelect for select, typeof users.$inferInsert for insert. ' +
          'Create type aliases for convenience.',
      },
    ],
    estimatedFiles: 20,
    riskLevel: 'high',
    prerequisites: ['drizzle-orm', 'drizzle-kit'],
  },
}

// ---------------------------------------------------------------------------
// Source patterns for scope analysis (used to find affected files)
// ---------------------------------------------------------------------------

const SCOPE_PATTERNS: Record<MigrationTarget, RegExp[]> = {
  'vue3-to-react': [/\.vue$/, /\/stores\/.*\.ts$/, /\/router\/.*\.ts$/, /\/composables\/.*\.ts$/],
  'react-to-vue3': [/\.tsx$/, /\/stores?\/.*\.ts$/, /\/hooks\/.*\.ts$/, /\/router\/.*\.tsx?$/],
  'express-to-fastify': [/\/routes\/.*\.ts$/, /\/middleware\/.*\.ts$/, /\/controllers\/.*\.ts$/, /app\.ts$/],
  'fastify-to-express': [/\/routes\/.*\.ts$/, /\/plugins\/.*\.ts$/, /app\.ts$/],
  'pinia-to-redux': [/\/stores\/.*\.ts$/, /useStore|defineStore/],
  'prisma-to-drizzle': [/schema\.prisma$/, /prisma\.(.*)\.(findMany|findUnique|create|update|delete)/],
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get the migration plan for a given target. */
export function getMigrationPlan(target: MigrationTarget): MigrationPlan {
  const plan = PLANS[target]
  return { target, ...plan }
}

/** Analyze source files and estimate migration scope. */
export function analyzeMigrationScope(
  files: Record<string, string>,
  target: MigrationTarget,
): { affectedFiles: string[]; estimatedEffort: 'small' | 'medium' | 'large'; warnings: string[] } {
  const patterns = SCOPE_PATTERNS[target]
  const affectedFiles: string[] = []
  const warnings: string[] = []

  for (const filePath of Object.keys(files)) {
    const content = files[filePath] ?? ''
    const matched = patterns.some((p) => p.test(filePath) || p.test(content))
    if (matched) {
      affectedFiles.push(filePath)
    }
  }

  // Estimate effort based on file count
  let estimatedEffort: 'small' | 'medium' | 'large'
  if (affectedFiles.length <= 5) {
    estimatedEffort = 'small'
  } else if (affectedFiles.length <= 20) {
    estimatedEffort = 'medium'
  } else {
    estimatedEffort = 'large'
  }

  // Generate warnings for high-risk migrations
  const plan = PLANS[target]
  if (plan.riskLevel === 'high' && affectedFiles.length > 10) {
    warnings.push(
      `High-risk migration affecting ${affectedFiles.length} files. Consider migrating incrementally.`,
    )
  }

  if (target === 'prisma-to-drizzle') {
    const hasRawQueries = Object.values(files).some((c) => /\$queryRaw|\$executeRaw/.test(c))
    if (hasRawQueries) {
      warnings.push('Raw Prisma queries detected. These require manual migration to Drizzle sql`` tagged templates.')
    }
  }

  if (target === 'vue3-to-react' || target === 'react-to-vue3') {
    const hasTests = Object.keys(files).some((f) => /\.spec\.|\.test\./.test(f))
    if (hasTests) {
      warnings.push('Component tests detected. Test files will need separate migration (testing-library API differs).')
    }
  }

  return { affectedFiles, estimatedEffort, warnings }
}

/** Build an LLM prompt for migrating a specific file. */
export function buildMigrationPrompt(
  filePath: string,
  content: string,
  step: MigrationStep,
  target: MigrationTarget,
): string {
  const plan = PLANS[target]
  const prerequisites = plan.prerequisites.join(', ')

  return [
    `## Migration Task: ${step.name}`,
    '',
    `**Migration:** ${target}`,
    `**Step ${step.order}:** ${step.description}`,
    `**Source file:** ${filePath}`,
    `**Target pattern:** ${step.targetPattern}`,
    `**Required packages:** ${prerequisites}`,
    '',
    `### Transformation Rules`,
    '',
    step.transformHint,
    '',
    `### Source Code`,
    '',
    '```',
    content,
    '```',
    '',
    `### Instructions`,
    '',
    `Transform the source code above according to the transformation rules.`,
    `Output ONLY the migrated code. Preserve all business logic and behavior.`,
    `Use TypeScript strict mode. Do not add comments explaining the migration.`,
  ].join('\n')
}
