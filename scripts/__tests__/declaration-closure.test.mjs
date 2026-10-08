import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { planDeclarationClosure, prunePrivateDeclarations } from '../prune-private-declarations.mjs'
const ts = createRequire(import.meta.url)('typescript')
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'declaration-closure-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'dist/internal'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', types: './dist/index.d.ts', exports: { '.': { types: './dist/index.d.ts' }, './sub': { types: './dist/sub.d.ts' } } }))
  writeFileSync(path.join(root, 'dist/index.d.ts'), 'export type { Public } from "./internal/public.js";\n')
  writeFileSync(path.join(root, 'dist/sub.d.ts'), 'export type Alias = import("./internal/public.js").Public;\n')
  writeFileSync(path.join(root, 'dist/internal/public.d.ts'), '/// <reference path="./tag.d.ts" />\nexport interface Public { id: string; tag: Tag }\n')
  writeFileSync(path.join(root, 'dist/internal/tag.d.ts'), 'interface Tag { name: string }\n')
  writeFileSync(path.join(root, 'dist/internal/private.d.ts'), 'export const unused: number;\n')
  return root
}
test('retains manifest entries and transitive import-type/path references with consumer typing', t => {
  const root = fixture(t)
  const before = readFileSync(path.join(root, 'dist/internal/public.d.ts'), 'utf8')
  const result = prunePrivateDeclarations(root)
  assert.equal(result.retained.length, 4)
  assert.equal(result.removed.length, 1)
  assert.equal(readFileSync(path.join(root, 'dist/internal/public.d.ts'), 'utf8'), before)
  writeFileSync(path.join(root, 'consumer.ts'), 'import type { Public } from "./dist/index.js"; import type { Alias } from "./dist/sub.js"; const a: Public = { id: "x", tag: { name: "y" } }; const b: Alias = a; export { b };\n')
  const program = ts.createProgram([path.join(root, 'consumer.ts')], { noEmit: true, strict: true, skipLibCheck: false, types: [], module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022 })
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [])
  assert.equal(prunePrivateDeclarations(root).removed.length, 0)
})
test('missing relative declaration refuses before deleting any private file', t => {
  const root = fixture(t)
  writeFileSync(path.join(root, 'dist/index.d.ts'), 'export * from "./missing.js";\n')
  assert.throws(() => prunePrivateDeclarations(root), /Missing relative declaration/)
  assert.equal(existsSync(path.join(root, 'dist/internal/private.d.ts')), true)
})
test('unsupported wildcard export and typesVersions refuse without omissions', t => {
  for (const extra of [{ exports: { './*': { types: './dist/*.d.ts' } } }, { typesVersions: { '*': { '*': ['dist/*'] } } }]) {
    const root = fixture(t)
    const p = path.join(root, 'package.json')
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p)), ...extra }))
    assert.throws(() => planDeclarationClosure(root), /Explicit manifest|typesVersions/)
  }
})
test('symlinks cannot redirect declaration pruning', t => {
  const root = fixture(t)
  symlinkSync(path.join(root, 'dist/internal/private.d.ts'), path.join(root, 'dist/redirect.d.ts'))
  assert.throws(() => prunePrivateDeclarations(root), /symlink/)
})
