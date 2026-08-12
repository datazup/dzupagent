import { MemoryRecordDecodeError } from './errors.js'
import type { SafeJson } from './safe-json.js'
import type { MemorySensitivityClassV1 } from './types.js'

export type JsonObject = { readonly [key: string]: SafeJson }

export function objectValue(
  value: SafeJson,
  path: readonly string[],
  allowedFields?: readonly string[],
): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-type', path)
  }
  if (allowedFields) {
    const allowed = new Set(allowedFields)
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) fail('unknown-field', [...path, key])
    }
  }
  return value as JsonObject
}

export function required(record: JsonObject, key: string, path: readonly string[]): SafeJson {
  const value = record[key]
  if (value === undefined) fail('invalid-value', [...path, key])
  return value
}

export function optional(record: JsonObject, key: string): SafeJson | undefined {
  return record[key]
}

export function stringValue(record: JsonObject, key: string, path: readonly string[]): string {
  return boundedText(required(record, key, path), [...path, key], 256)
}

export function boundedText(value: SafeJson, path: readonly string[], maxBytes: number): string {
  if (typeof value !== 'string') fail('invalid-type', path)
  if (value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail('invalid-value', path)
  }
  return value
}

export function identifierValue(record: JsonObject, key: string, path: readonly string[]): string {
  const value = boundedText(required(record, key, path), [...path, key], 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value)) {
    fail('invalid-value', [...path, key])
  }
  return value
}

export function actorRefValue(record: JsonObject, key: string, path: readonly string[]): string {
  const value = boundedText(required(record, key, path), [...path, key], 256)
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
  const forge = /^forge:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
  const urn = /^urn:[A-Za-z0-9][A-Za-z0-9._:-]{1,250}$/
  if (!identifier.test(value) && !forge.test(value) && !urn.test(value)) {
    fail('invalid-value', [...path, key])
  }
  return value
}

export function optionalIdentifierFields<T extends string>(
  record: JsonObject,
  path: readonly string[],
  keys: readonly T[],
): Partial<Record<T, string>> {
  const output: Partial<Record<T, string>> = {}
  for (const key of keys) {
    if (record[key] !== undefined) output[key] = identifierValue(record, key, path)
  }
  return output
}

export function optionalTimestampFields<T extends string>(
  record: JsonObject,
  path: readonly string[],
  keys: readonly T[],
): Partial<Record<T, string>> {
  const output: Partial<Record<T, string>> = {}
  for (const key of keys) {
    if (record[key] !== undefined) output[key] = timestampValue(record, key, path)
  }
  return output
}

export function optionalActorRef(
  record: JsonObject,
  key: string,
  path: readonly string[],
): { readonly reviewedByRef?: string } {
  return record[key] === undefined ? {} : { reviewedByRef: actorRefValue(record, key, path) }
}

export function enumValue<const T extends string>(
  record: JsonObject,
  key: string,
  path: readonly string[],
  allowed: readonly T[],
): T {
  const value = stringValue(record, key, path)
  if (!(allowed as readonly string[]).includes(value)) fail('invalid-value', [...path, key])
  return value as T
}

export function sensitivityValue(
  record: JsonObject,
  key: string,
  path: readonly string[],
): MemorySensitivityClassV1 {
  return enumValue(record, key, path, [
    'public', 'internal', 'confidential', 'restricted',
  ] as const)
}

export function digestValue(
  record: JsonObject,
  key: string,
  path: readonly string[],
): `sha256:${string}` {
  const value = stringValue(record, key, path)
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) fail('invalid-value', [...path, key])
  return value as `sha256:${string}`
}

export function timestampValue(record: JsonObject, key: string, path: readonly string[]): string {
  const value = stringValue(record, key, path)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('invalid-value', [...path, key])
  }
  return value
}

export function booleanValue(record: JsonObject, key: string, path: readonly string[]): boolean {
  const value = required(record, key, path)
  if (typeof value !== 'boolean') fail('invalid-type', [...path, key])
  return value
}

export function integerValue(record: JsonObject, key: string, path: readonly string[]): number {
  const value = required(record, key, path)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('invalid-value', [...path, key])
  }
  return value
}

export function scoreValue(record: JsonObject, key: string, path: readonly string[]): number {
  return score(required(record, key, path), [...path, key])
}

export function score(value: SafeJson, path: readonly string[]): number {
  if (typeof value !== 'number' || value < 0 || value > 1) fail('invalid-value', path)
  return value
}

export function fail(
  code: ConstructorParameters<typeof MemoryRecordDecodeError>[0],
  path: readonly string[],
): never {
  throw new MemoryRecordDecodeError(code, path)
}
