/**
 * Exact-structure primitives for execution-control admission.
 *
 * These validators read only own enumerable data properties through the
 * captured Reflect/Object intrinsics so that admission decisions cannot be
 * influenced by getters, prototypes, or exotic array shapes. Internal to
 * execution-control-admission; not part of any public entrypoint.
 */

const BLOCKER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u
const MAX_BLOCKERS = 16
const arrayIsArray = Array.isArray
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const getPrototypeOf = Object.getPrototypeOf
const ownKeys = Reflect.ownKeys

export type OwnDataProperty =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'missing' }

export function canonicalBlockers(value: unknown): readonly string[] {
  const values = denseOwnDataArray(value, MAX_BLOCKERS)
  const blockers: string[] = []
  for (const entry of values) {
    if (typeof entry !== 'string' || !BLOCKER_PATTERN.test(entry)) {
      throw new TypeError('Execution-control admission blocker is invalid')
    }
    if (!blockers.includes(entry)) blockers.push(entry)
  }
  blockers.sort()
  return Object.freeze(blockers)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || arrayIsArray(value)) return false
  const prototype = getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function exactDataValues(
  value: unknown,
  expected: readonly string[],
): readonly unknown[] | undefined {
  if (!isRecord(value)) return undefined
  const keys = ownKeys(value)
  if (keys.length !== expected.length) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !expected.includes(key)) return undefined
  }
  const values: unknown[] = []
  for (const key of expected) {
    const property = ownEnumerableDataProperty(value, key)
    if (property.kind !== 'data') return undefined
    values.push(property.value)
  }
  return values
}

export function ownEnumerableDataProperty(
  value: object,
  key: PropertyKey,
): OwnDataProperty {
  const descriptor = getOwnPropertyDescriptor(value, key)
  if (!descriptor) return { kind: 'missing' }
  if (!descriptor.enumerable || !('value' in descriptor)) {
    return { kind: 'invalid' }
  }
  return { kind: 'data', value: descriptor.value }
}

export function denseOwnDataArray(
  value: unknown,
  maxLength: number,
): readonly unknown[] {
  if (!arrayIsArray(value)) {
    throw new TypeError('Execution-control admission blockers must be an array')
  }
  const lengthDescriptor = getOwnPropertyDescriptor(value, 'length')
  if (
    !lengthDescriptor
    || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maxLength
  ) {
    throw new TypeError(`Execution-control admission supports at most ${maxLength} blockers`)
  }
  const length = lengthDescriptor.value
  const keys = ownKeys(value)
  if (keys.length !== length + 1) {
    throw new TypeError('Execution-control admission blockers must be dense data')
  }
  const values: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    const descriptor = getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Execution-control admission blockers must be dense data')
    }
    values.push(descriptor.value)
  }
  for (const key of keys) {
    if (key === 'length') continue
    if (typeof key !== 'string') {
      throw new TypeError('Execution-control admission blockers contain an extra property')
    }
    const index = Number(key)
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || index >= length
      || String(index) !== key
    ) {
      throw new TypeError('Execution-control admission blockers contain an extra property')
    }
  }
  return values
}

export function isExactEmptyArray(value: unknown): boolean {
  try {
    return denseOwnDataArray(value, 0).length === 0
  } catch {
    return false
  }
}
