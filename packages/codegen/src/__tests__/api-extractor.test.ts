import { describe, it, expect } from 'vitest'
import { ApiExtractor } from '../contract/api-extractor.js'

describe('ApiExtractor', () => {
  const extractor = new ApiExtractor()

  it('extracts GET route from routes file', () => {
    const vfs: Record<string, string> = {
      'src/users.routes.ts': `
        // List all users
        router.get('/users', getUsers)
      `,
    }
    const contract = extractor.extract(vfs)
    expect(contract.endpoints).toHaveLength(1)
    expect(contract.endpoints[0]!.method).toBe('get')
    expect(contract.endpoints[0]!.path).toBe('/users')
    expect(contract.endpoints[0]!.description).toContain('List all users')
  })

  it('extracts POST route with auth detection', () => {
    const vfs: Record<string, string> = {
      'src/users.routes.ts': `
        router.post('/users', authenticate, createUser)
      `,
    }
    const contract = extractor.extract(vfs)
    expect(contract.endpoints).toHaveLength(1)
    expect(contract.endpoints[0]!.auth).toBe(true)
  })

  it('extracts multiple HTTP methods', () => {
    const vfs: Record<string, string> = {
      'src/api.routes.ts': `
        router.get('/items', list)
        router.post('/items', create)
        router.put('/items/:id', update)
        router.delete('/items/:id', remove)
        app.patch('/items/:id', patch)
      `,
    }
    const contract = extractor.extract(vfs)
    expect(contract.endpoints).toHaveLength(5)
    const methods = contract.endpoints.map(e => e.method)
    expect(methods).toContain('get')
    expect(methods).toContain('post')
    expect(methods).toContain('put')
    expect(methods).toContain('delete')
    expect(methods).toContain('patch')
  })

  it('collects Zod schemas from validator files', () => {
    const vfs: Record<string, string> = {
      'src/user.validator.ts': 'export const UserSchema = z.object({ name: z.string() })',
    }
    const contract = extractor.extract(vfs)
    expect(contract.zodSchemas).toContain('UserSchema')
  })

  it('collects schemas from /schemas/ directory', () => {
    const vfs: Record<string, string> = {
      'src/schemas/item.ts': 'export const ItemSchema = z.object({})',
    }
    const contract = extractor.extract(vfs)
    expect(contract.zodSchemas).toContain('ItemSchema')
  })

  it('collects shared types from .types. files', () => {
    const vfs: Record<string, string> = {
      'src/user.types.ts': 'export interface User { id: string }',
    }
    const contract = extractor.extract(vfs)
    expect(contract.sharedTypes).toContain('User')
  })

  it('collects types from /types/ directory', () => {
    const vfs: Record<string, string> = {
      'src/types/common.ts': 'export type ID = string',
    }
    const contract = extractor.extract(vfs)
    expect(contract.sharedTypes).toContain('ID')
  })

  it('collects types from .dto. files', () => {
    const vfs: Record<string, string> = {
      'src/user.dto.ts': 'export interface CreateUserDto { name: string }',
    }
    const contract = extractor.extract(vfs)
    expect(contract.sharedTypes).toContain('CreateUserDto')
  })

  it('falls back to extracting types from service files when no type files exist', () => {
    // The fallback extracts type/interface blocks from .service. and .controller. files.
    // It uses brace-matching starting from the export keyword.
    const vfs: Record<string, string> = {
      'src/user.service.ts': [
        'export interface UserData {',
        '  id: string;',
        '  name: string;',
        '}',
      ].join('\n'),
    }
    const contract = extractor.extract(vfs)
    // The sharedTypes should contain the extracted interface block
    expect(contract.sharedTypes.length).toBeGreaterThan(0)
    expect(contract.sharedTypes).toContain('user.service.ts')
  })

  it('truncates excessively long sharedTypes', () => {
    const longContent = 'export interface Foo { x: string }\n'.repeat(1000)
    const vfs: Record<string, string> = {
      'src/types/big.types.ts': longContent,
    }
    const contract = extractor.extract(vfs)
    expect(contract.sharedTypes).toContain('(truncated)')
  })

  it('truncates excessively long zodSchemas', () => {
    const longContent = 'export const Schema = z.object({ x: z.string() })\n'.repeat(1000)
    const vfs: Record<string, string> = {
      'src/validators/big.validator.ts': longContent,
    }
    const contract = extractor.extract(vfs)
    expect(contract.zodSchemas).toContain('(truncated)')
  })

  it('returns empty contract for empty VFS', () => {
    const contract = extractor.extract({})
    expect(contract.endpoints).toHaveLength(0)
    expect(contract.sharedTypes).toBe('')
    expect(contract.zodSchemas).toBe('')
  })

  it('ignores non-route files for endpoint extraction', () => {
    const vfs: Record<string, string> = {
      'src/utils.ts': 'router.get("/should-not-match", handler)',
    }
    const contract = extractor.extract(vfs)
    expect(contract.endpoints).toHaveLength(0)
  })

  it('extracts from /routes/ directory path', () => {
    const vfs: Record<string, string> = {
      'src/routes/auth.ts': 'router.post("/login", login)',
    }
    const contract = extractor.extract(vfs)
    expect(contract.endpoints).toHaveLength(1)
    expect(contract.endpoints[0]!.path).toBe('/login')
  })

  it('detects requireAuth middleware as auth', () => {
    const vfs: Record<string, string> = {
      'src/api.controller.ts': 'router.get("/protected", requireAuth, handler)',
    }
    const contract = extractor.extract(vfs)
    expect(contract.endpoints[0]!.auth).toBe(true)
  })
})
