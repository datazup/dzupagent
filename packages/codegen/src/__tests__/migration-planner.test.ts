import { describe, it, expect } from 'vitest'
import {
  getMigrationPlan,
  analyzeMigrationScope,
  buildMigrationPrompt,
  type MigrationTarget,
} from '../migration/migration-planner.js'

// ---------------------------------------------------------------------------
// getMigrationPlan
// ---------------------------------------------------------------------------

describe('getMigrationPlan', () => {
  const ALL_TARGETS: MigrationTarget[] = [
    'vue3-to-react',
    'react-to-vue3',
    'express-to-fastify',
    'fastify-to-express',
    'pinia-to-redux',
    'prisma-to-drizzle',
  ]

  for (const target of ALL_TARGETS) {
    it(`returns a valid plan for ${target}`, () => {
      const plan = getMigrationPlan(target)

      expect(plan.target).toBe(target)
      expect(plan.steps.length).toBeGreaterThan(0)
      expect(plan.estimatedFiles).toBeGreaterThan(0)
      expect(['low', 'medium', 'high']).toContain(plan.riskLevel)
      expect(plan.prerequisites.length).toBeGreaterThan(0)
    })

    it(`${target} steps have sequential order numbers`, () => {
      const plan = getMigrationPlan(target)
      for (let i = 0; i < plan.steps.length; i++) {
        expect(plan.steps[i]!.order).toBe(i + 1)
      }
    })

    it(`${target} steps have all required fields`, () => {
      const plan = getMigrationPlan(target)
      for (const step of plan.steps) {
        expect(step.name).toBeTruthy()
        expect(step.description).toBeTruthy()
        expect(step.sourcePattern).toBeTruthy()
        expect(step.targetPattern).toBeTruthy()
        expect(step.transformHint).toBeTruthy()
      }
    })
  }

  it('vue3-to-react has high risk level', () => {
    const plan = getMigrationPlan('vue3-to-react')
    expect(plan.riskLevel).toBe('high')
  })

  it('express-to-fastify has medium risk level', () => {
    const plan = getMigrationPlan('express-to-fastify')
    expect(plan.riskLevel).toBe('medium')
  })

  it('prisma-to-drizzle requires drizzle-orm', () => {
    const plan = getMigrationPlan('prisma-to-drizzle')
    expect(plan.prerequisites).toContain('drizzle-orm')
  })

  it('react-to-vue3 requires vue', () => {
    const plan = getMigrationPlan('react-to-vue3')
    expect(plan.prerequisites).toContain('vue')
  })
})

// ---------------------------------------------------------------------------
// analyzeMigrationScope
// ---------------------------------------------------------------------------

describe('analyzeMigrationScope', () => {
  describe('vue3-to-react', () => {
    it('detects .vue files', () => {
      const files = {
        'src/App.vue': '<template></template>',
        'src/main.ts': 'import App from "./App.vue"',
      }
      const result = analyzeMigrationScope(files, 'vue3-to-react')

      expect(result.affectedFiles).toContain('src/App.vue')
    })

    it('detects composables', () => {
      const files = {
        'src/composables/useAuth.ts': 'export function useAuth() {}',
      }
      const result = analyzeMigrationScope(files, 'vue3-to-react')

      expect(result.affectedFiles).toContain('src/composables/useAuth.ts')
    })

    it('detects store files', () => {
      const files = {
        'src/stores/auth.ts': 'export const useAuthStore = defineStore("auth", {})',
      }
      const result = analyzeMigrationScope(files, 'vue3-to-react')

      expect(result.affectedFiles).toContain('src/stores/auth.ts')
    })

    it('detects router files', () => {
      const files = {
        'src/router/index.ts': 'export const router = createRouter({})',
      }
      const result = analyzeMigrationScope(files, 'vue3-to-react')

      expect(result.affectedFiles).toContain('src/router/index.ts')
    })

    it('warns about component tests', () => {
      const files = {
        'src/App.vue': '<template></template>',
        'src/App.spec.ts': 'describe("App", () => {})',
      }
      const result = analyzeMigrationScope(files, 'vue3-to-react')

      expect(result.warnings.some((w) => w.includes('test'))).toBe(true)
    })
  })

  describe('react-to-vue3', () => {
    it('detects .tsx files', () => {
      const files = {
        'src/App.tsx': 'export default function App() { return <div /> }',
      }
      const result = analyzeMigrationScope(files, 'react-to-vue3')

      expect(result.affectedFiles).toContain('src/App.tsx')
    })

    it('detects hooks', () => {
      const files = {
        'src/hooks/useAuth.ts': 'export function useAuth() {}',
      }
      const result = analyzeMigrationScope(files, 'react-to-vue3')

      expect(result.affectedFiles).toContain('src/hooks/useAuth.ts')
    })
  })

  describe('express-to-fastify', () => {
    it('detects route files', () => {
      const files = {
        'src/routes/users.ts': 'router.get("/users", handler)',
      }
      const result = analyzeMigrationScope(files, 'express-to-fastify')

      expect(result.affectedFiles).toContain('src/routes/users.ts')
    })

    it('detects middleware files', () => {
      const files = {
        'src/middleware/auth.ts': 'export function authMiddleware() {}',
      }
      const result = analyzeMigrationScope(files, 'express-to-fastify')

      expect(result.affectedFiles).toContain('src/middleware/auth.ts')
    })

    it('detects app.ts', () => {
      const files = {
        'src/app.ts': 'const app = express()',
      }
      const result = analyzeMigrationScope(files, 'express-to-fastify')

      expect(result.affectedFiles).toContain('src/app.ts')
    })
  })

  describe('prisma-to-drizzle', () => {
    it('detects schema.prisma', () => {
      const files = {
        'prisma/schema.prisma': 'model User { id Int @id }',
      }
      const result = analyzeMigrationScope(files, 'prisma-to-drizzle')

      expect(result.affectedFiles).toContain('prisma/schema.prisma')
    })

    it('warns about raw queries', () => {
      const files = {
        'prisma/schema.prisma': 'model User { id Int @id }',
        'src/db.ts': 'const result = await prisma.$queryRaw`SELECT 1`',
      }
      const result = analyzeMigrationScope(files, 'prisma-to-drizzle')

      expect(result.warnings.some((w) => w.includes('Raw Prisma queries'))).toBe(true)
    })
  })

  describe('effort estimation', () => {
    it('returns small for 5 or fewer affected files', () => {
      const files = {
        'src/App.vue': '<template></template>',
        'src/Home.vue': '<template></template>',
      }
      const result = analyzeMigrationScope(files, 'vue3-to-react')

      expect(result.estimatedEffort).toBe('small')
    })

    it('returns medium for 6-20 affected files', () => {
      const files: Record<string, string> = {}
      for (let i = 0; i < 10; i++) {
        files[`src/Component${i}.vue`] = '<template></template>'
      }
      const result = analyzeMigrationScope(files, 'vue3-to-react')

      expect(result.estimatedEffort).toBe('medium')
    })

    it('returns large for more than 20 affected files', () => {
      const files: Record<string, string> = {}
      for (let i = 0; i < 25; i++) {
        files[`src/Component${i}.vue`] = '<template></template>'
      }
      const result = analyzeMigrationScope(files, 'vue3-to-react')

      expect(result.estimatedEffort).toBe('large')
    })

    it('warns on high-risk migration with many files', () => {
      const files: Record<string, string> = {}
      for (let i = 0; i < 15; i++) {
        files[`src/Component${i}.vue`] = '<template></template>'
      }
      const result = analyzeMigrationScope(files, 'vue3-to-react')

      expect(result.warnings.some((w) => w.includes('incrementally'))).toBe(true)
    })
  })

  describe('non-matching files', () => {
    it('returns empty affected files when no files match', () => {
      const files = {
        'src/utils.ts': 'export function helper() {}',
        'README.md': '# Project',
      }
      const result = analyzeMigrationScope(files, 'vue3-to-react')

      expect(result.affectedFiles).toHaveLength(0)
      expect(result.estimatedEffort).toBe('small')
    })
  })
})

// ---------------------------------------------------------------------------
// buildMigrationPrompt
// ---------------------------------------------------------------------------

describe('buildMigrationPrompt', () => {
  it('includes migration metadata', () => {
    const plan = getMigrationPlan('vue3-to-react')
    const step = plan.steps[0]!

    const prompt = buildMigrationPrompt(
      'src/App.vue',
      '<template><div>Hello</div></template>',
      step,
      'vue3-to-react',
    )

    expect(prompt).toContain('vue3-to-react')
    expect(prompt).toContain(step.name)
    expect(prompt).toContain(step.description)
    expect(prompt).toContain('src/App.vue')
  })

  it('includes source code in code block', () => {
    const plan = getMigrationPlan('express-to-fastify')
    const step = plan.steps[0]!
    const sourceCode = 'app.get("/users", (req, res) => res.json([]))'

    const prompt = buildMigrationPrompt('src/routes.ts', sourceCode, step, 'express-to-fastify')

    expect(prompt).toContain('```')
    expect(prompt).toContain(sourceCode)
  })

  it('includes transformation hint', () => {
    const plan = getMigrationPlan('prisma-to-drizzle')
    const step = plan.steps[0]!

    const prompt = buildMigrationPrompt(
      'prisma/schema.prisma',
      'model User { id Int @id }',
      step,
      'prisma-to-drizzle',
    )

    expect(prompt).toContain(step.transformHint)
  })

  it('includes prerequisites', () => {
    const plan = getMigrationPlan('react-to-vue3')
    const step = plan.steps[0]!

    const prompt = buildMigrationPrompt('src/App.tsx', 'export default App', step, 'react-to-vue3')

    expect(prompt).toContain('vue')
    expect(prompt).toContain('vue-router')
    expect(prompt).toContain('pinia')
  })

  it('includes instructions section', () => {
    const plan = getMigrationPlan('pinia-to-redux')
    const step = plan.steps[0]!

    const prompt = buildMigrationPrompt('src/stores/auth.ts', 'defineStore()', step, 'pinia-to-redux')

    expect(prompt).toContain('Instructions')
    expect(prompt).toContain('Transform the source code')
    expect(prompt).toContain('TypeScript strict mode')
  })

  it('includes step order number', () => {
    const plan = getMigrationPlan('vue3-to-react')
    const step = plan.steps[2]! // step 3

    const prompt = buildMigrationPrompt('src/stores/auth.ts', 'content', step, 'vue3-to-react')

    expect(prompt).toContain(`Step ${step.order}`)
  })
})
