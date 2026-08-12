import {
  boundedText,
  digestValue,
  identifierValue,
  integerValue,
  objectValue,
  required,
  stringValue,
  timestampValue,
  type JsonObject,
} from '../records/decoder-primitives.js'
import type { SafeJson } from '../records/safe-json.js'
import type {
  InternalMemoryWorkerRefV1,
  InternalMemoryWorkerSourceRefV1,
} from './types.js'

export function decodeWorkerRef(
  value: SafeJson,
  path: readonly string[],
): InternalMemoryWorkerRefV1 {
  const root = objectValue(value, path, ['owner', 'id', 'digest'])
  return {
    owner: identifierValue(root, 'owner', path),
    id: identifierValue(root, 'id', path),
    digest: digestValue(root, 'digest', path),
  }
}

export function decodeWorkerSourceRef(
  value: SafeJson,
  path: readonly string[],
): InternalMemoryWorkerSourceRefV1 {
  const root = objectValue(value, path, ['owner', 'id', 'digest', 'versionId'])
  return {
    owner: identifierValue(root, 'owner', path),
    id: identifierValue(root, 'id', path),
    digest: digestValue(root, 'digest', path),
    ...(root['versionId'] === undefined ? {} : {
      versionId: identifierValue(root, 'versionId', path),
    }),
  }
}

export function decodeWorkerRefs(
  value: SafeJson,
  path: readonly string[],
  maximum: number,
): readonly InternalMemoryWorkerRefV1[] {
  if (!Array.isArray(value) || value.length > maximum) {
    workerFail('limit-exceeded', path)
  }
  const output = value.map((entry, index) =>
    decodeWorkerRef(entry, [...path, String(index)]))
  const keys = output.map(ref => `${ref.owner}\0${ref.id}\0${ref.digest}`)
  if (new Set(keys).size !== keys.length || keys.join('\n') !== [...keys].sort().join('\n')) {
    workerFail('invalid-value', path)
  }
  return Object.freeze(output)
}

export function decodeReasonCode(
  root: JsonObject,
  key: string,
  path: readonly string[],
): string {
  const value = boundedText(required(root, key, path), [...path, key], 96)
  if (!/^[a-z][a-z0-9-]{0,95}$/.test(value)) workerFail('invalid-value', [...path, key])
  return value
}

export function boundedInteger(
  root: JsonObject,
  key: string,
  path: readonly string[],
  minimum: number,
  maximum: number,
): number {
  const value = integerValue(root, key, path)
  if (value < minimum || value > maximum) workerFail('invalid-value', [...path, key])
  return value
}

export function requireSchema(
  root: JsonObject,
  expected: string,
  path: readonly string[] = [],
): void {
  if (stringValue(root, 'schema', path) !== expected) {
    workerFail('invalid-schema', [...path, 'schema'])
  }
}

export function requireTimeOrder(
  left: string,
  right: string,
  path: readonly string[],
  allowEqual = false,
): void {
  const leftMs = new Date(left).getTime()
  const rightMs = new Date(right).getTime()
  if (allowEqual ? leftMs > rightMs : leftMs >= rightMs) {
    workerFail('invalid-time-order', path)
  }
}

export function timestampFrom(
  root: JsonObject,
  key: string,
  path: readonly string[],
): string {
  return timestampValue(root, key, path)
}

export function workerFail(
  code: 'invalid-type' | 'unknown-field' | 'invalid-value' | 'invalid-schema'
    | 'invalid-time-order' | 'unsafe-object' | 'limit-exceeded',
  path: readonly string[] = [],
): never {
  const error = new TypeError(`${code} at ${formatPath(path)}`)
  error.name = 'MemoryWorkerValidationError'
  throw error
}

function formatPath(path: readonly string[]): string {
  if (path.length === 0) return '$'
  return `$${path.map(part => /^\d+$/.test(part) ? `[${part}]` : `.${part}`).join('')}`
}

