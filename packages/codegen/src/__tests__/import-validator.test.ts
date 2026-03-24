import { describe, it, expect } from 'vitest'
import { VirtualFS } from '../vfs/virtual-fs.js'
import { validateImports } from '../validation/import-validator.js'

describe('validateImports', () => {
  it('returns valid for resolved imports', () => {
    const vfs = new VirtualFS({
      'src/index.ts': 'import { add } from "./utils.js"\nconsole.log(add(1, 2))',
      'src/utils.ts': 'export function add(a: number, b: number) { return a + b }',
    })
    const result = validateImports(vfs)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('detects unresolved imports', () => {
    const vfs = new VirtualFS({
      'src/index.ts': 'import { foo } from "./missing"\nconsole.log(foo())',
    })
    const result = validateImports(vfs)
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.importPath).toBe('./missing')
  })

  it('resolves imports with .ts extension', () => {
    const vfs = new VirtualFS({
      'src/app.ts': 'import { Router } from "./router"',
      'src/router.ts': 'export class Router {}',
    })
    const result = validateImports(vfs)
    expect(result.valid).toBe(true)
  })

  it('resolves index imports', () => {
    const vfs = new VirtualFS({
      'src/app.ts': 'import { Service } from "./services"',
      'src/services/index.ts': 'export class Service {}',
    })
    const result = validateImports(vfs)
    expect(result.valid).toBe(true)
  })

  it('resolves parent directory imports', () => {
    const vfs = new VirtualFS({
      'src/routes/user.ts': 'import { prisma } from "../lib/prisma"',
      'src/lib/prisma.ts': 'export const prisma = {}',
    })
    const result = validateImports(vfs)
    expect(result.valid).toBe(true)
  })

  it('ignores non-relative imports (node_modules)', () => {
    const vfs = new VirtualFS({
      'src/app.ts': 'import express from "express"\nimport { z } from "zod"',
    })
    const result = validateImports(vfs)
    expect(result.valid).toBe(true)
  })

  it('ignores non-JS/TS files', () => {
    const vfs = new VirtualFS({
      'README.md': 'import { broken } from "./nonexistent"',
    })
    const result = validateImports(vfs)
    expect(result.valid).toBe(true)
  })

  it('handles dynamic imports', () => {
    const vfs = new VirtualFS({
      'src/app.ts': 'const mod = await import("./dynamic")',
      'src/dynamic.ts': 'export const x = 1',
    })
    const result = validateImports(vfs)
    expect(result.valid).toBe(true)
  })

  it('reports multiple errors in one file', () => {
    const vfs = new VirtualFS({
      'src/broken.ts': 'import { a } from "./missing1"\nimport { b } from "./missing2"',
    })
    const result = validateImports(vfs)
    expect(result.errors).toHaveLength(2)
  })
})
