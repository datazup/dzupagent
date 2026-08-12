import { join, resolve } from 'node:path'
import type {
  CheckpointFailure,
  CheckpointManagerConfig,
  CheckpointSettings,
} from './checkpoint-types.js'

const DEFAULTS = {
  baseDir: join(process.env['HOME'] ?? '/tmp', '.dzupagent', 'checkpoints'),
  maxSnapshots: 50,
  timeoutMs: 30_000,
  maxFiles: 50_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxDepth: 64,
  maxPathBytes: 4_096,
  maxGitOutputBytes: 4 * 1024 * 1024,
}

const MAX_REASON_BYTES = 1_024
const rootOperationTails = new Map<string, Promise<void>>()

export class CheckpointInternalError extends Error {
  constructor(
    readonly code: CheckpointFailure['code'],
    message: string,
  ) {
    super(message)
    this.name = 'CheckpointInternalError'
  }
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

export function createCheckpointSettings(config?: CheckpointManagerConfig): CheckpointSettings {
  return {
    baseDir: resolve(config?.baseDir ?? DEFAULTS.baseDir),
    maxSnapshots: requirePositiveInteger(
      'maxSnapshots',
      config?.maxSnapshots ?? DEFAULTS.maxSnapshots,
    ),
    timeoutMs: requirePositiveInteger('timeoutMs', config?.timeoutMs ?? DEFAULTS.timeoutMs),
    maxFiles: requirePositiveInteger('maxFiles', config?.maxFiles ?? DEFAULTS.maxFiles),
    maxFileBytes: requirePositiveInteger(
      'maxFileBytes',
      config?.maxFileBytes ?? DEFAULTS.maxFileBytes,
    ),
    maxTotalBytes: requirePositiveInteger(
      'maxTotalBytes',
      config?.maxTotalBytes ?? DEFAULTS.maxTotalBytes,
    ),
    maxDepth: requirePositiveInteger('maxDepth', config?.maxDepth ?? DEFAULTS.maxDepth),
    maxPathBytes: requirePositiveInteger(
      'maxPathBytes',
      config?.maxPathBytes ?? DEFAULTS.maxPathBytes,
    ),
    maxGitOutputBytes: requirePositiveInteger(
      'maxGitOutputBytes',
      config?.maxGitOutputBytes ?? DEFAULTS.maxGitOutputBytes,
    ),
  }
}

export function normalizeReason(reason: string): string {
  if (typeof reason !== 'string' || reason.includes('\0')) {
    throw new CheckpointInternalError('unsafe_input', 'checkpoint reason is invalid')
  }
  const normalized = reason.replace(/\s+/g, ' ').trim() || 'checkpoint'
  if (Buffer.byteLength(normalized, 'utf8') > MAX_REASON_BYTES) {
    throw new CheckpointInternalError('resource_limit', 'checkpoint reason exceeds the byte limit')
  }
  return normalized
}

export function isFullObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}

export function safeNodeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : null
}

export function failureFrom(error: unknown): CheckpointFailure {
  if (error instanceof CheckpointInternalError) {
    return { status: 'failed', code: error.code, error: error.message }
  }
  const code = safeNodeErrorCode(error)
  return {
    status: 'failed',
    code: 'io_failure',
    error: code
      ? `checkpoint filesystem operation failed (${code})`
      : 'checkpoint filesystem operation failed',
  }
}

export function skippedOrFailed(
  error: unknown,
): CheckpointFailure | { status: 'skipped'; code: 'unsafe_input' | 'resource_limit'; reason: string } {
  const failure = failureFrom(error)
  if (failure.code === 'unsafe_input' || failure.code === 'resource_limit') {
    return { status: 'skipped', code: failure.code, reason: failure.error }
  }
  return failure
}

export async function serializeRoot<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = rootOperationTails.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent
  })
  const tail = previous.catch(() => undefined).then(() => current)
  rootOperationTails.set(key, tail)

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (rootOperationTails.get(key) === tail) rootOperationTails.delete(key)
  }
}
