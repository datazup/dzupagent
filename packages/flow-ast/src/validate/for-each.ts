import type { FlowNode } from '../types.js'
import { joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue, ValidateNodeArray } from './shared.js'

export function validateForEach(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
  validateNodeArray: ValidateNodeArray,
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const source = obj['source']
  const as = obj['as']
  let ok = true
  if (typeof source !== 'string' || source.length === 0) {
    issues.push({
      path: joinPath(path, 'source'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.source is required (non-empty string)',
    })
    ok = false
  }
  if (typeof as !== 'string' || as.length === 0) {
    issues.push({
      path: joinPath(path, 'as'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.as is required (non-empty string)',
    })
    ok = false
  }
  const body = validateNodeArray(obj['body'], joinPath(path, 'body'), issues)
  if (body === null) return null
  if (body.length === 0) {
    issues.push({
      path,
      code: 'EMPTY_BODY',
      message: 'for_each.body must contain at least one node',
    })
  }
  const attachAs =
    typeof obj['attachAs'] === 'string' && obj['attachAs'].length > 0
      ? obj['attachAs']
      : undefined
  if (obj['attachAs'] !== undefined && attachAs === undefined) {
    issues.push({
      path: joinPath(path, 'attachAs'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.attachAs must be a non-empty string when present',
    })
  }

  const collect = validateCollect(obj['collect'], joinPath(path, 'collect'), issues)
  const accumulator = validateAccumulator(
    obj['accumulator'],
    joinPath(path, 'accumulator'),
    issues,
  )
  const concurrency = validateConcurrency(
    obj['concurrency'],
    joinPath(path, 'concurrency'),
    issues,
  )
  if (!ok) return null
  return {
    type: 'for_each',
    ...common,
    source: source as string,
    as: as as string,
    body,
    ...(attachAs !== undefined ? { attachAs } : {}),
    ...(collect !== undefined ? { collect } : {}),
    ...(accumulator !== undefined ? { accumulator } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  }
}

function validateCollect(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): { from: string; into: string } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.collect must be an object with from and into',
    })
    return undefined
  }
  const record = value as Record<string, unknown>
  if (typeof record['from'] === 'string' && typeof record['into'] === 'string') {
    return { from: record['from'], into: record['into'] }
  }
  issues.push({
    path,
    code: 'MISSING_REQUIRED_FIELD',
    message: 'for_each.collect.from and for_each.collect.into must be strings',
  })
  return undefined
}

function validateAccumulator(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): { key: string; window?: number; initialValue?: unknown } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.accumulator must be an object with key',
    })
    return undefined
  }
  const record = value as Record<string, unknown>
  if (typeof record['key'] !== 'string' || record['key'].length === 0) {
    issues.push({
      path: joinPath(path, 'key'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.accumulator.key must be a non-empty string',
    })
    return undefined
  }
  if (record['window'] !== undefined && typeof record['window'] !== 'number') {
    issues.push({
      path: joinPath(path, 'window'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.accumulator.window must be a number when present',
    })
  }
  return {
    key: record['key'],
    ...(typeof record['window'] === 'number'
      ? { window: Math.max(1, Math.floor(record['window'])) }
      : {}),
    ...(record['initialValue'] !== undefined
      ? { initialValue: record['initialValue'] }
      : {}),
  }
}

function validateConcurrency(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number') {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: 'for_each.concurrency must be a number when present',
    })
    return undefined
  }
  return Math.min(Math.max(1, Math.floor(value)), 8)
}
