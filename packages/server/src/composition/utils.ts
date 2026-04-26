/**
 * Internal composition helpers shared across the `createForgeApp` refactor.
 *
 * These helpers exist purely so that `app.ts` can stay short. They MUST NOT
 * be exported from the package's public surface (`src/index.ts`).
 */
import type { GracefulShutdown } from '../lifecycle/graceful-shutdown.js'
import type { ForgeServerConfig } from './types.js'

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface ExplicitRetentionMetadata {
  explicitUnbounded: boolean
}

function readExplicitRetentionMetadata(value: unknown): ExplicitRetentionMetadata | null {
  if (!isObject(value)) {
    return null
  }

  const metadata = value['__dzupagentRetention']
  if (!isObject(metadata) || typeof metadata['explicitUnbounded'] !== 'boolean') {
    return null
  }

  return {
    explicitUnbounded: metadata['explicitUnbounded'],
  }
}

/**
 * Compose an additional async drain hook onto a {@link GracefulShutdown}'s
 * existing `onDrain` callback. The previous hook still runs after the new
 * one, and errors from the new hook are deferred until after the original
 * hook completes — preserving the legacy contract from `app.ts`.
 */
export function registerShutdownDrainHook(
  shutdown: GracefulShutdown,
  hook: () => Promise<void>,
): void {
  const shutdownConfig = shutdown as unknown as { config: { onDrain?: () => Promise<void> } }
  const previousOnDrain = shutdownConfig.config.onDrain

  shutdownConfig.config.onDrain = async () => {
    let hookError: unknown

    try {
      await hook()
    } catch (error) {
      hookError = error
    }

    try {
      await previousOnDrain?.()
    } finally {
      if (hookError) {
        throw hookError
      }
    }
  }
}

/**
 * Emit a console warning when in-memory stores are running with explicit
 * unbounded retention. Mirrors the message text from the original `app.ts`
 * implementation so log scrapers continue to match.
 */
export function warnIfUnboundedInMemoryRetention(config: ForgeServerConfig): void {
  const runStoreRetention = readExplicitRetentionMetadata(config.runStore)
  if (runStoreRetention?.explicitUnbounded) {
    console.warn(
      '[ForgeServer] InMemoryRunStore is running with unbounded retention. ' +
        'Set finite limits for production workloads unless this opt-out is intentional.',
    )
  }

  const traceStoreRetention = readExplicitRetentionMetadata(config.traceStore)
  if (traceStoreRetention?.explicitUnbounded) {
    console.warn(
      '[ForgeServer] InMemoryRunTraceStore is running with unbounded retention. ' +
        'Set finite limits for production workloads unless this opt-out is intentional.',
    )
  }
}
