import { createHash } from 'node:crypto'

import type { AgentRunJsonValue } from '@dzupagent/agent-types/run'

/**
 * Durable-JSON discipline for runner state: what may be persisted, how it is
 * cloned, and how it is digested. Split out of `runner-values.ts`, which keeps
 * the inline projection/decision surface and the bounded event queue. Nothing
 * here reads runner state, so the two couple only through these calls.
 */

const FORBIDDEN_DURABLE_KEYS = new Set([
  'apikey', 'authorization', 'cookie', 'credential', 'credentials', 'password',
  'privatekey', 'providerclient', 'rawproviderpayload', 'refreshtoken', 'secret',
  'sessioncookie',
])

export type DurableJsonFailureCode =
  | 'cycle'
  | 'forbidden-key'
  | 'host-path'
  | 'non-finite-number'
  | 'non-json-object'
  | 'unsupported-value'

export class AgentRunnerSerializationError extends TypeError {
  readonly code: DurableJsonFailureCode
  readonly location: string

  constructor(code: DurableJsonFailureCode, location: string) {
    super(`Runner durable JSON rejected ${code} at ${location}`)
    this.name = 'AgentRunnerSerializationError'
    this.code = code
    this.location = location
  }
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, '').toLowerCase()
}

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith('/') || /^[a-z]:[\\/]/iu.test(value) || value.startsWith('\\\\')
}

function assertDurableValue(value: unknown, location: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && isAbsoluteHostPath(value)) {
      throw new AgentRunnerSerializationError('host-path', location)
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AgentRunnerSerializationError('non-finite-number', location)
    return
  }
  if (typeof value !== 'object') throw new AgentRunnerSerializationError('unsupported-value', location)
  if (ancestors.has(value)) throw new AgentRunnerSerializationError('cycle', location)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertDurableValue(entry, `${location}[${index}]`, ancestors))
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AgentRunnerSerializationError('non-json-object', location)
    }
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_DURABLE_KEYS.has(normalizedKey(key))) {
        throw new AgentRunnerSerializationError('forbidden-key', `${location}.${key}`)
      }
      assertDurableValue(entry, `${location}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

export function assertDurableJson(value: unknown): void {
  assertDurableValue(value, '$', new Set())
}

export function cloneDurableJson<T>(value: T): T {
  assertDurableJson(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function stableJson(value: AgentRunJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Readonly<Record<string, AgentRunJsonValue>>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key] ?? null)}`).join(',')}}`
}

/** @internal */
export function digestRunnerJson(value: unknown): string {
  assertDurableJson(value)
  return `sha256:${createHash('sha256').update(stableJson(value as AgentRunJsonValue)).digest('hex')}`
}
