import { describe, it, expect } from 'vitest'
import {
  DefaultRoleDetector,
  DefaultPriorityMatrix,
  summarizeFile,
  extractInterfaceSummary,
  TokenBudgetManager,
} from '../context/token-budget.js'

// ---------------------------------------------------------------------------
// DefaultRoleDetector
// ---------------------------------------------------------------------------

describe('DefaultRoleDetector', () => {
  const detector = new DefaultRoleDetector()

  it('detects .prisma files as model', () => {
    expect(detector.detect('prisma/schema.prisma')).toBe('model')
  })

  it('detects schema paths as model', () => {
    expect(detector.detect('db/schema/user.ts')).toBe('model')
  })

  it('detects .test. files as test', () => {
    expect(detector.detect('src/service.test.ts')).toBe('test')
  })

  it('detects .spec. files as test', () => {
    expect(detector.detect('src/service.spec.tsx')).toBe('test')
  })

  it('detects __tests__ paths as test', () => {
    expect(detector.detect('src/__tests__/helper.ts')).toBe('test')
  })

  it('detects .types. files as type', () => {
    expect(detector.detect('src/user.types.ts')).toBe('type')
  })

  it('detects /types/ directory as type', () => {
    expect(detector.detect('src/types/user.ts')).toBe('type')
  })

  it('detects .dto. files as type', () => {
    expect(detector.detect('src/user.dto.ts')).toBe('type')
  })

  it('detects validator files', () => {
    expect(detector.detect('src/user.validator.ts')).toBe('validator')
    expect(detector.detect('src/validators/auth.ts')).toBe('validator')
  })

  it('detects schema files as validator', () => {
    expect(detector.detect('src/user.schema.ts')).toBe('validator')
    // Note: 'src/schemas/auth.ts' matches /schema/ first => 'model'
    expect(detector.detect('src/schemas/auth.ts')).toBe('model')
  })

  it('detects route files', () => {
    expect(detector.detect('src/user.routes.ts')).toBe('route')
    expect(detector.detect('src/routes/auth.ts')).toBe('route')
  })

  it('detects controller files', () => {
    expect(detector.detect('src/user.controller.ts')).toBe('controller')
    expect(detector.detect('src/controllers/auth.ts')).toBe('controller')
  })

  it('detects service files', () => {
    expect(detector.detect('src/user.service.ts')).toBe('service')
    expect(detector.detect('src/services/auth.ts')).toBe('service')
  })

  it('detects Vue components', () => {
    expect(detector.detect('src/UserList.vue')).toBe('component')
    expect(detector.detect('src/components/Button.ts')).toBe('component')
  })

  it('detects store files', () => {
    expect(detector.detect('src/auth.store.ts')).toBe('store')
    expect(detector.detect('src/stores/auth.ts')).toBe('store')
  })

  it('detects composable files', () => {
    expect(detector.detect('src/composables/auth.ts')).toBe('composable')
    expect(detector.detect('src/useAuth.ts')).toBe('composable')
  })

  it('detects api-client files', () => {
    expect(detector.detect('src/user.api.ts')).toBe('api-client')
    expect(detector.detect('src/api/users.ts')).toBe('api-client')
  })

  it('detects config files', () => {
    expect(detector.detect('src/config.ts')).toBe('config')
    expect(detector.detect('manifest.json')).toBe('config')
  })

  it('returns other for unrecognized paths', () => {
    expect(detector.detect('src/helpers/utils.ts')).toBe('other')
    expect(detector.detect('src/main.ts')).toBe('other')
  })
})

// ---------------------------------------------------------------------------
// DefaultPriorityMatrix
// ---------------------------------------------------------------------------

describe('DefaultPriorityMatrix', () => {
  const matrix = new DefaultPriorityMatrix()

  it('returns full priority for model in generate_db phase', () => {
    expect(matrix.getPriority('generate_db', 'model')).toBe('full')
  })

  it('returns full priority for type in generate_db phase', () => {
    expect(matrix.getPriority('generate_db', 'type')).toBe('full')
  })

  it('returns interface priority for validator in generate_db phase', () => {
    expect(matrix.getPriority('generate_db', 'validator')).toBe('interface')
  })

  it('returns summary for unrecognized role in generate_db phase', () => {
    expect(matrix.getPriority('generate_db', 'component')).toBe('summary')
  })

  it('returns full for all roles in fix phase', () => {
    const roles = ['model', 'type', 'validator', 'route', 'controller', 'service', 'component', 'store', 'composable', 'api-client', 'test', 'config']
    for (const role of roles) {
      expect(matrix.getPriority('fix', role)).toBe('full')
    }
  })

  it('returns full for all roles in generate_tests phase', () => {
    expect(matrix.getPriority('generate_tests', 'model')).toBe('full')
    expect(matrix.getPriority('generate_tests', 'test')).toBe('full')
    expect(matrix.getPriority('generate_tests', 'service')).toBe('full')
  })

  it('returns interface for model in generate_frontend phase', () => {
    expect(matrix.getPriority('generate_frontend', 'model')).toBe('interface')
  })

  it('returns full for component in generate_frontend phase', () => {
    expect(matrix.getPriority('generate_frontend', 'component')).toBe('full')
  })

  it('returns full for unknown phase (default fallback)', () => {
    expect(matrix.getPriority('review', 'model')).toBe('full')
    expect(matrix.getPriority('validate', 'service')).toBe('full')
    expect(matrix.getPriority('unknown_phase', 'other')).toBe('full')
  })
})

// ---------------------------------------------------------------------------
// summarizeFile
// ---------------------------------------------------------------------------

describe('summarizeFile', () => {
  it('returns path, exports, and line count', () => {
    const content = `export const VERSION = "1.0.0"
export function greet() {}
export class Service {}
`
    const summary = summarizeFile('src/service.ts', content)
    expect(summary).toContain('src/service.ts')
    expect(summary).toContain('VERSION')
    expect(summary).toContain('greet')
    expect(summary).toContain('Service')
    expect(summary).toContain('lines')
  })

  it('handles file with no exports', () => {
    const content = `const internal = 42\nfunction helper() {}\n`
    const summary = summarizeFile('src/internal.ts', content)
    expect(summary).toContain('src/internal.ts')
    expect(summary).toContain('3 lines')
    expect(summary).not.toContain('Exports:')
  })

  it('counts lines correctly', () => {
    const content = 'line1\nline2\nline3\nline4\nline5'
    const summary = summarizeFile('test.ts', content)
    expect(summary).toContain('5 lines')
  })
})

// ---------------------------------------------------------------------------
// extractInterfaceSummary
// ---------------------------------------------------------------------------

describe('extractInterfaceSummary', () => {
  it('extracts export interface blocks', () => {
    const content = `import { Foo } from './foo.js'

export interface UserDTO {
  id: string
  name: string
}

const internal = true
`
    const summary = extractInterfaceSummary('src/types.ts', content)
    expect(summary).toContain('interface UserDTO')
    expect(summary).toContain('id: string')
    expect(summary).toContain('name: string')
  })

  it('extracts export type blocks', () => {
    const content = `export type Status = 'active' | 'inactive'
export type Role = {
  name: string
  level: number
}
`
    const summary = extractInterfaceSummary('src/types.ts', content)
    expect(summary).toContain("export type Status = 'active' | 'inactive'")
    expect(summary).toContain('export type Role')
  })

  it('extracts export function signatures without body', () => {
    const content = `export function createUser(name: string, email: string) {
  // lots of implementation
  return { name, email }
}
`
    const summary = extractInterfaceSummary('src/service.ts', content)
    expect(summary).toContain('export function createUser(name: string, email: string)')
    expect(summary).not.toContain('lots of implementation')
  })

  it('extracts export async function signatures', () => {
    const content = `export async function fetchData(url: string) {
  const res = await fetch(url)
  return res.json()
}
`
    const summary = extractInterfaceSummary('src/api.ts', content)
    expect(summary).toContain('export async function fetchData(url: string)')
  })

  it('extracts export const arrow functions', () => {
    const content = `export const handler = (req: Request) => {
  return new Response('ok')
}
`
    const summary = extractInterfaceSummary('src/handler.ts', content)
    expect(summary).toContain('export const handler')
    expect(summary).toContain('=> { ... }')
  })

  it('extracts import statements', () => {
    const content = `import { Foo } from './foo.js'
import type { Bar } from './bar.js'

const x = 42
`
    const summary = extractInterfaceSummary('src/module.ts', content)
    expect(summary).toContain("import { Foo } from './foo.js'")
    expect(summary).toContain("import type { Bar } from './bar.js'")
  })

  it('falls back to summarizeFile when nothing extractable', () => {
    const content = `const x = 1\nconst y = 2\n`
    const summary = extractInterfaceSummary('src/internal.ts', content)
    // Should fall back to the simple summary format
    expect(summary).toContain('src/internal.ts')
    expect(summary).toContain('lines')
  })
})

// ---------------------------------------------------------------------------
// TokenBudgetManager
// ---------------------------------------------------------------------------

describe('TokenBudgetManager', () => {
  describe('constructor', () => {
    it('uses defaults when no options provided', () => {
      const mgr = new TokenBudgetManager()
      expect(mgr).toBeDefined()
    })

    it('accepts custom options', () => {
      const mgr = new TokenBudgetManager({
        budgetTokens: 8000,
        charsPerToken: 3,
      })
      expect(mgr).toBeDefined()
    })
  })

  describe('selectFiles()', () => {
    it('returns empty for empty VFS', () => {
      const mgr = new TokenBudgetManager()
      const result = mgr.selectFiles({}, 'generate_backend')
      expect(result).toEqual([])
    })

    it('includes full content for high-priority files within budget', () => {
      const vfs: Record<string, string> = {
        'src/user.service.ts': 'export class UserService { find() { return [] } }',
        'src/user.types.ts': 'export interface User { id: string; name: string }',
      }

      const mgr = new TokenBudgetManager({ budgetTokens: 10_000 })
      const result = mgr.selectFiles(vfs, 'generate_backend')

      // Both should be full priority in generate_backend
      const serviceFile = result.find((f) => f.path === 'src/user.service.ts')
      expect(serviceFile).toBeDefined()
      expect(serviceFile!.content).toBe('export class UserService { find() { return [] } }')
    })

    it('downgrades to interface summary when over budget', () => {
      // Create a large file that won't fit in a tiny budget
      const largeContent = 'export function process() {\n' + '  // code\n'.repeat(500) + '}\n'
      const vfs: Record<string, string> = {
        'src/big.service.ts': largeContent,
      }

      // Tiny budget
      const mgr = new TokenBudgetManager({ budgetTokens: 50, charsPerToken: 4 })
      const result = mgr.selectFiles(vfs, 'generate_backend')

      expect(result).toHaveLength(1)
      // Should be downgraded (not full content)
      expect(result[0]!.content.length).toBeLessThan(largeContent.length)
    })

    it('applies summary priority for low-priority roles', () => {
      const vfs: Record<string, string> = {
        'src/components/Button.vue': '<template><button>Click</button></template>',
      }

      // component is summary priority in generate_db
      const mgr = new TokenBudgetManager({ budgetTokens: 10_000 })
      const result = mgr.selectFiles(vfs, 'generate_db')

      expect(result).toHaveLength(1)
      // Should be a one-line summary
      expect(result[0]!.content).toContain('lines')
    })

    it('processes full-priority files before summary-priority files', () => {
      const vfs: Record<string, string> = {
        'src/types/user.ts': 'export interface User { id: string }',
        'src/components/List.vue': '<template><div></div></template>',
        'src/user.service.ts': 'export class Service { handle() {} }',
      }

      const mgr = new TokenBudgetManager({ budgetTokens: 10_000 })
      const result = mgr.selectFiles(vfs, 'generate_backend')

      // Full priority files (type, service) should get full content
      const typeFile = result.find((f) => f.path === 'src/types/user.ts')
      expect(typeFile!.content).toBe('export interface User { id: string }')
    })

    it('handles custom role detector and priority matrix', () => {
      const customDetector = {
        detect: (_path: string) => 'critical',
      }
      const customMatrix = {
        getPriority: (_phase: string, _role: string) => 'full' as const,
      }

      const vfs: Record<string, string> = {
        'anything.ts': 'content here',
      }

      const mgr = new TokenBudgetManager({
        budgetTokens: 10_000,
        roleDetector: customDetector,
        priorityMatrix: customMatrix,
      })

      const result = mgr.selectFiles(vfs, 'any_phase')
      expect(result[0]!.content).toBe('content here')
    })
  })

  describe('summarizeFile()', () => {
    it('delegates to the standalone summarizeFile function', () => {
      const mgr = new TokenBudgetManager()
      const result = mgr.summarizeFile('test.ts', 'export const x = 1\n')
      expect(result).toContain('test.ts')
    })
  })

  describe('extractInterfaceSummary()', () => {
    it('delegates to the standalone extractInterfaceSummary function', () => {
      const mgr = new TokenBudgetManager()
      const result = mgr.extractInterfaceSummary(
        'types.ts',
        'export interface Foo { bar: string }\n',
      )
      expect(result).toContain('Foo')
    })
  })
})
