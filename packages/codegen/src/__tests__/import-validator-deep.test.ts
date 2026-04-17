/**
 * Deep-coverage tests for both import validators:
 *   - validation/import-validator.ts — VFS-based resolution
 *   - quality/import-validator.ts   — pure Map-based circular/self-import detection
 *
 * Both share very similar resolution semantics but have different APIs and return
 * shapes, so this suite is split into two top-level blocks.
 */
import { describe, it, expect } from 'vitest'
import { VirtualFS } from '../vfs/virtual-fs.js'
import {
  validateImports as validateImportsVfs,
  type ImportValidationResult as VfsResult,
  type ImportError as VfsError,
} from '../validation/import-validator.js'
import {
  validateImports as validateImportsMap,
  type ImportValidationResult as MapResult,
  type ImportIssue,
} from '../quality/import-validator.js'

// =============================================================================
// validation/import-validator.ts — VFS-based validator
// =============================================================================
describe('validateImports (VFS-based) — deep coverage', () => {
  // ---------------------------------------------------------------------------
  // baseline
  // ---------------------------------------------------------------------------
  describe('baseline', () => {
    it('empty VFS → valid=true, errors=[]', () => {
      const r = validateImportsVfs(new VirtualFS())
      expect(r.valid).toBe(true)
      expect(r.errors).toEqual([])
    })

    it('single file with no imports → valid=true', () => {
      const vfs = new VirtualFS({ 'src/a.ts': 'export const x = 1' })
      const r = validateImportsVfs(vfs)
      expect(r.valid).toBe(true)
      expect(r.errors).toHaveLength(0)
    })

    it('result is a plain object with valid+errors fields', () => {
      const r: VfsResult = validateImportsVfs(new VirtualFS())
      expect(Object.keys(r).sort()).toEqual(['errors', 'valid'])
    })
  })

  // ---------------------------------------------------------------------------
  // extension resolution
  // ---------------------------------------------------------------------------
  describe('extension resolution', () => {
    it('resolves no-extension import to .ts sibling', () => {
      const vfs = new VirtualFS({
        'src/a.ts': 'import { b } from "./b"',
        'src/b.ts': 'export const b = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('resolves no-extension import to .tsx sibling', () => {
      const vfs = new VirtualFS({
        'src/a.tsx': 'import { C } from "./c"',
        'src/c.tsx': 'export const C = () => null',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('resolves no-extension import to .js sibling', () => {
      const vfs = new VirtualFS({
        'src/a.ts': 'import { b } from "./b"',
        'src/b.js': 'export const b = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('resolves no-extension import to .jsx sibling', () => {
      const vfs = new VirtualFS({
        'src/a.jsx': 'import { C } from "./c"',
        'src/c.jsx': 'export const C = () => null',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('resolves no-extension import to .vue sibling', () => {
      const vfs = new VirtualFS({
        'src/a.ts': 'import C from "./C"',
        'src/C.vue': '<template/>',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('maps .js import → .ts source (ESM TS conventions)', () => {
      const vfs = new VirtualFS({
        'src/a.ts': 'import { b } from "./b.js"',
        'src/b.ts': 'export const b = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('maps .js import → .tsx source', () => {
      const vfs = new VirtualFS({
        'src/a.ts': 'import { C } from "./c.js"',
        'src/c.tsx': 'export const C = () => null',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('exact path with extension takes precedence over fallbacks', () => {
      const vfs = new VirtualFS({
        'src/a.ts': 'import { b } from "./b.ts"',
        'src/b.ts': 'export const b = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // directory index resolution
  // ---------------------------------------------------------------------------
  describe('directory index resolution', () => {
    it('resolves ./dir → ./dir/index.ts', () => {
      const vfs = new VirtualFS({
        'src/app.ts': 'import { S } from "./services"',
        'src/services/index.ts': 'export const S = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('resolves ./dir → ./dir/index.tsx', () => {
      const vfs = new VirtualFS({
        'src/app.ts': 'import { C } from "./comp"',
        'src/comp/index.tsx': 'export const C = () => null',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('resolves ./dir → ./dir/index.js', () => {
      const vfs = new VirtualFS({
        'src/app.ts': 'import { S } from "./services"',
        'src/services/index.js': 'export const S = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('resolves ./dir → ./dir/index.jsx', () => {
      const vfs = new VirtualFS({
        'src/app.tsx': 'import { S } from "./services"',
        'src/services/index.jsx': 'export const S = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('missing directory index → unresolved', () => {
      const vfs = new VirtualFS({
        'src/app.ts': 'import { S } from "./services"',
      })
      expect(validateImportsVfs(vfs).valid).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // path traversal
  // ---------------------------------------------------------------------------
  describe('path traversal', () => {
    it('resolves ../ parent directory imports', () => {
      const vfs = new VirtualFS({
        'src/routes/user.ts': 'import { prisma } from "../lib/prisma"',
        'src/lib/prisma.ts': 'export const prisma = {}',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('resolves nested ../../ traversal', () => {
      const vfs = new VirtualFS({
        'src/a/b/c.ts': 'import { x } from "../../shared/x"',
        'src/shared/x.ts': 'export const x = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('handles ./ explicit current dir reference', () => {
      const vfs = new VirtualFS({
        'src/a.ts': 'import { b } from "./b"',
        'src/b.ts': 'export const b = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('resolves deeply nested relative path', () => {
      const vfs = new VirtualFS({
        'src/a.ts': 'import { x } from "./sub/deep/nested/x"',
        'src/sub/deep/nested/x.ts': 'export const x = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('resolves sibling import from root-level file', () => {
      const vfs = new VirtualFS({
        'a.ts': 'import { x } from "./b"',
        'b.ts': 'export const x = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // external imports (pass-through)
  // ---------------------------------------------------------------------------
  describe('external imports', () => {
    it('ignores bare package imports (express, zod, ...)', () => {
      const vfs = new VirtualFS({
        'src/app.ts': [
          'import express from "express"',
          'import { z } from "zod"',
          'import lodash from "lodash"',
        ].join('\n'),
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('ignores @scope/package imports', () => {
      const vfs = new VirtualFS({
        'src/app.ts': 'import { foo } from "@dzupagent/core"',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('ignores subpath imports like lodash/fp', () => {
      const vfs = new VirtualFS({
        'src/app.ts': 'import fp from "lodash/fp"',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('ignores node: protocol imports', () => {
      const vfs = new VirtualFS({
        'src/app.ts': 'import { readFile } from "node:fs/promises"',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // import syntax variants
  // ---------------------------------------------------------------------------
  describe('import syntax variants', () => {
    it('matches `export { x } from "./path"` re-exports', () => {
      const vfs = new VirtualFS({
        'src/index.ts': 'export { Foo } from "./missing"',
      })
      const r = validateImportsVfs(vfs)
      expect(r.valid).toBe(false)
      expect(r.errors[0]!.importPath).toBe('./missing')
    })

    it('matches default imports', () => {
      const vfs = new VirtualFS({
        'src/index.ts': 'import Foo from "./missing"',
      })
      expect(validateImportsVfs(vfs).valid).toBe(false)
    })

    it('matches namespace imports (import * as)', () => {
      const vfs = new VirtualFS({
        'src/index.ts': 'import * as utils from "./missing"',
      })
      expect(validateImportsVfs(vfs).valid).toBe(false)
    })

    it('matches named imports', () => {
      const vfs = new VirtualFS({
        'src/index.ts': 'import { a, b, c } from "./missing"',
      })
      expect(validateImportsVfs(vfs).valid).toBe(false)
    })

    it('matches dynamic imports import("./...")', () => {
      const vfs = new VirtualFS({
        'src/app.ts': 'const m = await import("./ghost")',
      })
      expect(validateImportsVfs(vfs).valid).toBe(false)
    })

    it('resolves multiple imports in a single file', () => {
      const vfs = new VirtualFS({
        'src/app.ts': [
          'import { a } from "./a"',
          'import { b } from "./b"',
          'import { c } from "./c"',
        ].join('\n'),
        'src/a.ts': 'export const a = 1',
        'src/b.ts': 'export const b = 1',
        'src/c.ts': 'export const c = 1',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('reports multiple unresolved imports in a single file', () => {
      const vfs = new VirtualFS({
        'src/broken.ts': 'import { a } from "./m1"\nimport { b } from "./m2"',
      })
      const r = validateImportsVfs(vfs)
      expect(r.errors).toHaveLength(2)
      expect(r.errors.map(e => e.importPath).sort()).toEqual(['./m1', './m2'])
    })
  })

  // ---------------------------------------------------------------------------
  // error shape & propagation
  // ---------------------------------------------------------------------------
  describe('error shape', () => {
    it('each error has file, importPath, resolved, message fields', () => {
      const vfs = new VirtualFS({
        'src/a.ts': 'import { x } from "./missing"',
      })
      const err: VfsError = validateImportsVfs(vfs).errors[0]!
      expect(err.file).toBe('src/a.ts')
      expect(err.importPath).toBe('./missing')
      expect(err.resolved).toBeTruthy()
      expect(err.message).toContain('Unresolved import')
    })

    it('error message includes the originating file', () => {
      const vfs = new VirtualFS({
        'src/feature/x.ts': 'import { x } from "./missing"',
      })
      const r = validateImportsVfs(vfs)
      expect(r.errors[0]!.message).toContain('src/feature/x.ts')
    })

    it('error.resolved is a path string (may or may not include extension)', () => {
      const vfs = new VirtualFS({
        'src/a.ts': 'import { x } from "./missing"',
      })
      const r = validateImportsVfs(vfs)
      expect(typeof r.errors[0]!.resolved).toBe('string')
      expect(r.errors[0]!.resolved.length).toBeGreaterThan(0)
    })

    it('error identifies correct source file across multiple files', () => {
      const vfs = new VirtualFS({
        'src/good.ts': 'import { b } from "./b"',
        'src/b.ts': 'export const b = 1',
        'src/bad.ts': 'import { m } from "./nope"',
      })
      const r = validateImportsVfs(vfs)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]!.file).toBe('src/bad.ts')
    })
  })

  // ---------------------------------------------------------------------------
  // file-type filtering
  // ---------------------------------------------------------------------------
  describe('file-type filtering', () => {
    it('ignores non-JS/TS files (.md)', () => {
      const vfs = new VirtualFS({
        'README.md': 'import { x } from "./nonexistent"',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('ignores .json files', () => {
      const vfs = new VirtualFS({
        'package.json': '{ "name": "x" }',
      })
      expect(validateImportsVfs(vfs).valid).toBe(true)
    })

    it('validates .jsx files', () => {
      const vfs = new VirtualFS({
        'src/a.jsx': 'import { x } from "./missing"',
      })
      expect(validateImportsVfs(vfs).valid).toBe(false)
    })

    it('validates .vue files', () => {
      const vfs = new VirtualFS({
        'src/A.vue': 'import { x } from "./missing"',
      })
      expect(validateImportsVfs(vfs).valid).toBe(false)
    })

    it('handles empty file content gracefully', () => {
      const vfs = new VirtualFS({
        'src/a.ts': '',
      })
      const r = validateImportsVfs(vfs)
      expect(r.valid).toBe(true)
    })
  })
})

// =============================================================================
// quality/import-validator.ts — pure Map-based validator with cycle detection
// =============================================================================
describe('validateImports (quality, Map-based) — deep coverage', () => {
  // ---------------------------------------------------------------------------
  // baseline and API shape
  // ---------------------------------------------------------------------------
  describe('baseline', () => {
    it('empty Map → valid=true, issues=[]', () => {
      const r = validateImportsMap(new Map())
      expect(r.valid).toBe(true)
      expect(r.issues).toEqual([])
    })

    it('empty Record → valid=true', () => {
      const r = validateImportsMap({})
      expect(r.valid).toBe(true)
    })

    it('single file no imports → valid=true', () => {
      const r = validateImportsMap({ 'a.ts': 'export const x = 1' })
      expect(r.valid).toBe(true)
    })

    it('accepts Record<string,string> as input', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"',
        'b.ts': 'export const b = 1',
      })
      expect(r.valid).toBe(true)
    })

    it('accepts Map<string,string> as input', () => {
      const files = new Map([
        ['a.ts', 'import { b } from "./b"'],
        ['b.ts', 'export const b = 1'],
      ])
      const r = validateImportsMap(files)
      expect(r.valid).toBe(true)
    })

    it('result shape: valid + issues keys', () => {
      const r: MapResult = validateImportsMap({})
      expect(Object.keys(r).sort()).toEqual(['issues', 'valid'])
    })
  })

  // ---------------------------------------------------------------------------
  // unresolved imports
  // ---------------------------------------------------------------------------
  describe('unresolved imports', () => {
    it('reports unresolved import with issue="unresolved"', () => {
      const r = validateImportsMap({
        'a.ts': 'import { x } from "./missing"',
      })
      expect(r.valid).toBe(false)
      expect(r.issues[0]!.issue).toBe('unresolved')
    })

    it('error identifies the file and importPath', () => {
      const r = validateImportsMap({
        'src/a.ts': 'import { x } from "./missing"',
      })
      const issue: ImportIssue = r.issues[0]!
      expect(issue.file).toBe('src/a.ts')
      expect(issue.importPath).toBe('./missing')
    })

    it('reports line number for unresolved import', () => {
      const r = validateImportsMap({
        'a.ts': '// header\n// more\nimport { x } from "./missing"',
      })
      expect(r.issues[0]!.line).toBe(3)
    })

    it('reports multiple unresolved imports with correct lines', () => {
      const r = validateImportsMap({
        'a.ts': [
          'import { a } from "./m1"',
          '',
          'import { b } from "./m2"',
        ].join('\n'),
      })
      expect(r.issues).toHaveLength(2)
      expect(r.issues[0]!.line).toBe(1)
      expect(r.issues[1]!.line).toBe(3)
    })

    it('dynamic imports that are unresolved are reported', () => {
      const r = validateImportsMap({
        'a.ts': 'const m = await import("./ghost")',
      })
      expect(r.valid).toBe(false)
      expect(r.issues[0]!.issue).toBe('unresolved')
    })
  })

  // ---------------------------------------------------------------------------
  // external/bare specifiers
  // ---------------------------------------------------------------------------
  describe('external imports', () => {
    it('bare package imports are ignored', () => {
      const r = validateImportsMap({
        'a.ts': 'import express from "express"',
      })
      expect(r.valid).toBe(true)
    })

    it('@scope/package imports are ignored', () => {
      const r = validateImportsMap({
        'a.ts': 'import { x } from "@dzupagent/core"',
      })
      expect(r.valid).toBe(true)
    })

    it('node: imports are ignored', () => {
      const r = validateImportsMap({
        'a.ts': 'import { readFile } from "node:fs"',
      })
      expect(r.valid).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // resolution variants
  // ---------------------------------------------------------------------------
  describe('resolution variants', () => {
    it('resolves no-extension .ts sibling', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"',
        'b.ts': 'export const b = 1',
      })
      expect(r.valid).toBe(true)
    })

    it('resolves .js → .ts ESM mapping', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b.js"',
        'b.ts': 'export const b = 1',
      })
      expect(r.valid).toBe(true)
    })

    it('resolves .js → .tsx mapping', () => {
      const r = validateImportsMap({
        'a.ts': 'import { C } from "./c.js"',
        'c.tsx': 'export const C = () => null',
      })
      expect(r.valid).toBe(true)
    })

    it('resolves directory index (index.ts)', () => {
      const r = validateImportsMap({
        'a.ts': 'import { x } from "./dir"',
        'dir/index.ts': 'export const x = 1',
      })
      expect(r.valid).toBe(true)
    })

    it('resolves directory index (index.tsx)', () => {
      const r = validateImportsMap({
        'a.ts': 'import { x } from "./dir"',
        'dir/index.tsx': 'export const x = 1',
      })
      expect(r.valid).toBe(true)
    })

    it('resolves exact path with extension', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b.ts"',
        'b.ts': 'export const b = 1',
      })
      expect(r.valid).toBe(true)
    })

    it('handles ../ parent traversal', () => {
      const r = validateImportsMap({
        'src/routes/u.ts': 'import { x } from "../lib/x"',
        'src/lib/x.ts': 'export const x = 1',
      })
      expect(r.valid).toBe(true)
    })

    it('unresolved parent traversal is reported', () => {
      const r = validateImportsMap({
        'src/routes/u.ts': 'import { x } from "../missing/x"',
      })
      expect(r.valid).toBe(false)
    })

    it('uses rootDir for imports in top-level files when provided', () => {
      const r = validateImportsMap(
        {
          'a.ts': 'import { b } from "./b"',
          'src/b.ts': 'export const b = 1',
        },
        'src',
      )
      // 'a.ts' has no slash → fromDir becomes rootDir ('src'), so './b' → src/b.ts
      expect(r.valid).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // self-imports
  // ---------------------------------------------------------------------------
  describe('self-import detection', () => {
    it('detects direct self-import with extension', () => {
      const r = validateImportsMap({
        'a.ts': 'import { x } from "./a.ts"',
      })
      expect(r.valid).toBe(false)
      expect(r.issues[0]!.issue).toBe('self-import')
    })

    it('detects self-import via extension resolution', () => {
      const r = validateImportsMap({
        'a.ts': 'import { x } from "./a"',
      })
      expect(r.valid).toBe(false)
      expect(r.issues[0]!.issue).toBe('self-import')
    })

    it('detects self-import via .js → .ts mapping', () => {
      const r = validateImportsMap({
        'a.ts': 'import { x } from "./a.js"',
      })
      expect(r.valid).toBe(false)
      expect(r.issues[0]!.issue).toBe('self-import')
    })

    it('self-import records the correct file and line number', () => {
      const r = validateImportsMap({
        'src/mod.ts': '// hi\nimport { x } from "./mod"',
      })
      expect(r.issues[0]!.file).toBe('src/mod.ts')
      expect(r.issues[0]!.line).toBe(2)
    })
  })

  // ---------------------------------------------------------------------------
  // circular imports
  // ---------------------------------------------------------------------------
  describe('circular import detection', () => {
    it('detects simple A→B→A cycle', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"',
        'b.ts': 'import { a } from "./a"',
      })
      expect(r.valid).toBe(false)
      const cycles = r.issues.filter(i => i.issue === 'circular')
      expect(cycles.length).toBeGreaterThanOrEqual(1)
    })

    it('detects 3-cycle A→B→C→A', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"',
        'b.ts': 'import { c } from "./c"',
        'c.ts': 'import { a } from "./a"',
      })
      const cycles = r.issues.filter(i => i.issue === 'circular')
      expect(cycles.length).toBeGreaterThanOrEqual(1)
    })

    it('detects 4-cycle A→B→C→D→A', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"',
        'b.ts': 'import { c } from "./c"',
        'c.ts': 'import { d } from "./d"',
        'd.ts': 'import { a } from "./a"',
      })
      const cycles = r.issues.filter(i => i.issue === 'circular')
      expect(cycles.length).toBeGreaterThanOrEqual(1)
    })

    it('DAG (no cycle) → no circular issues', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"\nimport { c } from "./c"',
        'b.ts': 'import { c } from "./c"',
        'c.ts': 'export const c = 1',
      })
      const cycles = r.issues.filter(i => i.issue === 'circular')
      expect(cycles).toHaveLength(0)
    })

    it('circular issues include an importPath', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"',
        'b.ts': 'import { a } from "./a"',
      })
      const cycle = r.issues.find(i => i.issue === 'circular')
      expect(cycle).toBeDefined()
      expect(typeof cycle!.importPath).toBe('string')
    })

    it('cycle plus unrelated unresolved: both reported independently', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"',
        'b.ts': 'import { a } from "./a"',
        'c.ts': 'import { gone } from "./gone"',
      })
      const cyc = r.issues.filter(i => i.issue === 'circular')
      const unr = r.issues.filter(i => i.issue === 'unresolved')
      expect(cyc.length).toBeGreaterThan(0)
      expect(unr.length).toBeGreaterThan(0)
    })

    it('two disjoint cycles are both detected', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"',
        'b.ts': 'import { a } from "./a"',
        'c.ts': 'import { d } from "./d"',
        'd.ts': 'import { c } from "./c"',
      })
      const cycles = r.issues.filter(i => i.issue === 'circular')
      expect(cycles.length).toBeGreaterThanOrEqual(2)
    })
  })

  // ---------------------------------------------------------------------------
  // issue shape
  // ---------------------------------------------------------------------------
  describe('issue shape', () => {
    it('ImportIssue has file, line, importPath, issue fields', () => {
      const r = validateImportsMap({
        'a.ts': 'import { x } from "./missing"',
      })
      const issue: ImportIssue = r.issues[0]!
      expect(issue.file).toBe('a.ts')
      expect(issue.line).toBe(1)
      expect(issue.importPath).toBe('./missing')
      expect(issue.issue).toBe('unresolved')
    })

    it('line is 1-based (first line = 1, not 0)', () => {
      const r = validateImportsMap({
        'a.ts': 'import { x } from "./missing"',
      })
      expect(r.issues[0]!.line).toBe(1)
    })

    it('issue.issue is one of the three literal kinds', () => {
      const r = validateImportsMap({
        'a.ts': 'import { x } from "./missing"',
      })
      expect(['unresolved', 'circular', 'self-import']).toContain(r.issues[0]!.issue)
    })

    it('issues array is empty when everything resolves', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"',
        'b.ts': 'export const b = 1',
      })
      expect(r.issues).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // multi-file scenarios
  // ---------------------------------------------------------------------------
  describe('multi-file scenarios', () => {
    it('validates many interrelated files with no issues', () => {
      const r = validateImportsMap({
        'app.ts': 'import { x } from "./x"\nimport { y } from "./y"',
        'x.ts': 'export const x = 1',
        'y.ts': 'import { z } from "./z"\nexport const y = z',
        'z.ts': 'export const z = 1',
      })
      expect(r.valid).toBe(true)
    })

    it('pinpoints which of many files has the unresolved import', () => {
      const r = validateImportsMap({
        'a.ts': 'import { b } from "./b"',
        'b.ts': 'export const b = 1',
        'bad.ts': 'import { nope } from "./nope"',
      })
      expect(r.issues).toHaveLength(1)
      expect(r.issues[0]!.file).toBe('bad.ts')
    })

    it('empty file content contributes no issues', () => {
      const r = validateImportsMap({
        'a.ts': '',
        'b.ts': 'export const b = 1',
      })
      expect(r.valid).toBe(true)
    })

    it('re-exports are validated like imports', () => {
      const r = validateImportsMap({
        'index.ts': 'export { foo } from "./missing"',
      })
      expect(r.valid).toBe(false)
      expect(r.issues[0]!.issue).toBe('unresolved')
    })

    it('handles files at different depths', () => {
      const r = validateImportsMap({
        'top.ts': 'import { x } from "./a/b/c"',
        'a/b/c.ts': 'export const x = 1',
      })
      expect(r.valid).toBe(true)
    })
  })
})
