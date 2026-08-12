import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import { MemoryRecordDecodeError } from './errors.js'

interface SafeJsonSnapshotLimits {
  readonly maxDepth: number
  readonly maxTotalNodes: number
  readonly maxTotalProperties: number
  readonly maxObjectProperties: number
  readonly maxArrayItems: number
  readonly maxTotalStringBytes: number
}

const DEFAULT_LIMITS: SafeJsonSnapshotLimits = {
  maxDepth: 12,
  maxTotalNodes: 2_048,
  maxTotalProperties: 1_024,
  maxObjectProperties: 128,
  maxArrayItems: 128,
  maxTotalStringBytes: 64 * 1024,
}
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

interface SnapshotBudget {
  nodes: number
  properties: number
  stringBytes: number
  readonly ancestors: WeakSet<object>
  readonly limits: SafeJsonSnapshotLimits
}

export type SafeJson =
  | null
  | boolean
  | number
  | string
  | readonly SafeJson[]
  | { readonly [key: string]: SafeJson }

/** Snapshot JSON without invoking accessor properties. */
export function snapshotSafeJson(
  input: unknown,
  limitOverrides: Partial<SafeJsonSnapshotLimits> = {},
): SafeJson {
  return snapshot(input, [], 0, {
    nodes: 0,
    properties: 0,
    stringBytes: 0,
    ancestors: new WeakSet(),
    limits: { ...DEFAULT_LIMITS, ...limitOverrides },
  })
}

function snapshot(
  input: unknown,
  path: readonly string[],
  depth: number,
  budget: SnapshotBudget,
): SafeJson {
  budget.nodes += 1
  if (depth > budget.limits.maxDepth || budget.nodes > budget.limits.maxTotalNodes) {
    throw new MemoryRecordDecodeError('limit-exceeded', path)
  }

  if (input === null || typeof input === 'boolean' || typeof input === 'string') {
    if (typeof input === 'string') {
      budget.stringBytes += Buffer.byteLength(input, 'utf8')
      if (budget.stringBytes > budget.limits.maxTotalStringBytes) {
        throw new MemoryRecordDecodeError('limit-exceeded', path)
      }
    }
    return input
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw new MemoryRecordDecodeError('unsupported-value', path)
    }
    return input
  }

  if (typeof input !== 'object') {
    throw new MemoryRecordDecodeError('unsupported-value', path)
  }
  if (utilTypes.isProxy(input)) {
    throw new MemoryRecordDecodeError('unsafe-object', path)
  }

  if (budget.ancestors.has(input)) {
    throw new MemoryRecordDecodeError('cyclic-value', path)
  }
  budget.ancestors.add(input)
  try {
    if (Array.isArray(input)) return snapshotArray(input, path, depth, budget)
    return snapshotObject(input, path, depth, budget)
  } finally {
    budget.ancestors.delete(input)
  }
}

function snapshotArray(
  input: readonly unknown[],
  path: readonly string[],
  depth: number,
  budget: SnapshotBudget,
): readonly SafeJson[] {
  if (Object.getPrototypeOf(input) !== Array.prototype) {
    throw new MemoryRecordDecodeError('unsafe-object', path)
  }
  if (input.length > budget.limits.maxArrayItems) {
    throw new MemoryRecordDecodeError('limit-exceeded', path)
  }

  const descriptors = Object.getOwnPropertyDescriptors(input)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some(key => typeof key === 'symbol')) {
    throw new MemoryRecordDecodeError('unsafe-object', path)
  }
  const dataKeys = (keys as string[]).filter(key => key !== 'length')
  if (dataKeys.length !== input.length) {
    throw new MemoryRecordDecodeError('unsafe-object', path)
  }

  budget.properties += dataKeys.length
  if (budget.properties > budget.limits.maxTotalProperties) {
    throw new MemoryRecordDecodeError('limit-exceeded', path)
  }

  const output: SafeJson[] = []
  for (let index = 0; index < input.length; index += 1) {
    const key = String(index)
    const descriptor = descriptors[key]
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new MemoryRecordDecodeError('accessor-property', [...path, key])
    }
    output.push(snapshot(descriptor.value, [...path, key], depth + 1, budget))
  }
  return output
}

function snapshotObject(
  input: object,
  path: readonly string[],
  depth: number,
  budget: SnapshotBudget,
): { readonly [key: string]: SafeJson } {
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MemoryRecordDecodeError('unsafe-object', path)
  }

  const descriptors = Object.getOwnPropertyDescriptors(input)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some(key => typeof key === 'symbol')
    || keys.length > budget.limits.maxObjectProperties) {
    throw new MemoryRecordDecodeError(
      keys.length > budget.limits.maxObjectProperties ? 'limit-exceeded' : 'unsafe-object',
      path,
    )
  }
  budget.properties += keys.length
  if (budget.properties > budget.limits.maxTotalProperties) {
    throw new MemoryRecordDecodeError('limit-exceeded', path)
  }

  const output: Record<string, SafeJson> = Object.create(null) as Record<string, SafeJson>
  for (const key of keys as string[]) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new MemoryRecordDecodeError('unsafe-object', [...path, key])
    }
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new MemoryRecordDecodeError('accessor-property', [...path, key])
    }
    output[key] = snapshot(descriptor.value, [...path, key], depth + 1, budget)
  }
  return output
}

export function canonicalizeSafeJson(value: SafeJson): string {
  return JSON.stringify(sortSafeJson(value))
}

function sortSafeJson(value: SafeJson): SafeJson {
  if (Array.isArray(value)) return value.map(sortSafeJson)
  if (value !== null && typeof value === 'object') {
    const record = value as { readonly [key: string]: SafeJson }
    const sorted: Record<string, SafeJson> = Object.create(null) as Record<string, SafeJson>
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortSafeJson(record[key]!)
    }
    return sorted
  }
  return value
}

export function digestSafeJson(value: SafeJson): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalizeSafeJson(value)).digest('hex')}`
}

export function deepFreezeSafeJson<T extends SafeJson>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeSafeJson(child)
    Object.freeze(value)
  }
  return value
}
