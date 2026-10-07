#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderCapabilityMatrix } from './generate-capability-matrix.mjs'

export function checkCapabilityMatrixFreshness(root) {
  const target = join(root, 'docs/CAPABILITY_MATRIX.md')
  if (!existsSync(target)) return { ok: false, code: 'MATRIX_MISSING' }
  const normalizeDate = text => text.replace(/^Auto-generated on \d{4}-\d{2}-\d{2}\./m, 'Auto-generated on <date>.')
  const ok = normalizeDate(readFileSync(target, 'utf8')) === normalizeDate(renderCapabilityMatrix(root))
  return { ok, code: ok ? 'FRESH' : 'MATRIX_STALE' }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkCapabilityMatrixFreshness(resolve(import.meta.dirname, '..'))
  console.log(result.ok ? 'CAPABILITY_MATRIX.md is up to date.' : result.code + ': regenerate with yarn docs:capability-matrix')
  process.exitCode = result.ok ? 0 : 1
}
