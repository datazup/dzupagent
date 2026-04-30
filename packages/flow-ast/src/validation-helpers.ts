import type { FlowValue } from './types.js'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function isFlowValue(value: unknown): value is FlowValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isFlowValue(entry))
  }

  if (isPlainObject(value)) {
    return Object.values(value).every((entry) => isFlowValue(entry))
  }

  return false
}

export function describeJsType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

export function joinPath(base: string, segment: string): string {
  return `${base}.${segment}`
}
