import { readdirSync, readFileSync, existsSync, unlinkSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ts = require('typescript')

function declarationFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Declaration directory contains a symlink')
    return entry.isDirectory() ? declarationFiles(file) : /\.d\.(?:ts|mts|cts)$/.test(file) ? [file] : []
  })
}
export function planDeclarationClosure(packageRoot) {
  const root = path.resolve(packageRoot), dist = path.join(root, 'dist')
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json')))
  if (manifest.typesVersions) throw new Error('typesVersions requires an explicit declaration closure policy')
  const roots = []
  const collect = (value, typed = false) => {
    if (typeof value === 'string' && typed) roots.push(value)
    else if (Array.isArray(value)) value.forEach(entry => collect(entry, typed))
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) collect(entry, typed || key === 'types')
  }
  if (manifest.types) roots.push(manifest.types)
  if (manifest.typings) roots.push(manifest.typings)
  collect(manifest.exports)
  if (!roots.length || roots.some(file => file.includes('*'))) throw new Error('Explicit manifest type entrypoints required')
  const all = declarationFiles(dist), files = new Set(all), retained = new Set()
  const pending = roots.map(file => path.resolve(root, file))
  const resolveReference = (file, specifier) => {
    const target = path.resolve(path.dirname(file), specifier)
    const candidates = [target, target.replace(/\.mjs$/, '.d.mts').replace(/\.cjs$/, '.d.cts').replace(/\.js$/, '.d.ts'), target + '.d.ts', path.join(target, 'index.d.ts')]
    const resolved = candidates.find(candidate => files.has(candidate))
    if (!resolved) throw new Error(`Missing relative declaration dependency: ${file} -> ${specifier}`)
    return resolved
  }
  while (pending.length) {
    const file = pending.pop()
    if (retained.has(file)) continue
    if (!files.has(file) || !existsSync(file) || !lstatSync(file).isFile()) throw new Error(`Missing manifest declaration: ${file}`)
    retained.add(file)
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
    for (const reference of [...info.importedFiles, ...info.referencedFiles]) {
      if (reference.fileName.startsWith('.')) pending.push(resolveReference(file, reference.fileName))
      else if (info.referencedFiles.includes(reference)) throw new Error('Non-relative path reference requires explicit policy')
    }
  }
  return { retained: [...retained].sort(), removed: all.filter(file => !retained.has(file)).sort() }
}
export function prunePrivateDeclarations(packageRoot) {
  // Complete and validate closure before deleting anything. Public exports and
  // every relative import they require remain byte-identical.
  const plan = planDeclarationClosure(packageRoot)
  for (const file of plan.removed) unlinkSync(file)
  return plan
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try { const p = prunePrivateDeclarations(process.argv[2] ?? '.'); console.log(`Declaration closure: ${p.retained.length} retained, ${p.removed.length} private files omitted`) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
