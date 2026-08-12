import {
  deepFreezeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
  type SafeJson,
} from '../records/safe-json.js'
import type { MemoryScopeV1 } from '../records/types.js'

const WORKER_LIMITS = {
  maxDepth: 24,
  maxTotalNodes: 65_536,
  maxTotalProperties: 32_768,
  maxObjectProperties: 128,
  maxArrayItems: 256,
  maxTotalStringBytes: 2 * 1024 * 1024,
} as const

export function snapshotWorkerJson(input: unknown): SafeJson {
  return snapshotSafeJson(input, WORKER_LIMITS)
}

export function digestWorkerValue(input: unknown): `sha256:${string}` {
  return digestSafeJson(snapshotWorkerJson(input))
}

export function freezeWorkerValue<T>(input: T): T {
  return deepFreezeSafeJson(snapshotWorkerJson(input)) as unknown as T
}

export function memoryWorkerScopeDigest(scope: MemoryScopeV1): `sha256:${string}` {
  return digestWorkerValue({ schema: 'datazup.memory.worker-scope/v1', scope })
}

export function timestampMs(value: string): number {
  return new Date(value).getTime()
}

export function derivedIdentifier(prefix: string, digest: `sha256:${string}`): string {
  return `${prefix}-${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`
}

