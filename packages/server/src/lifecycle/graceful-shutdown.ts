/**
 * Graceful shutdown handler for DzipAgent server.
 *
 * On SIGTERM/SIGINT:
 * 1. Stop accepting new runs
 * 2. Wait for in-progress runs to complete (with timeout)
 * 3. Flush event logs
 * 4. Close DB/MCP/WS connections
 * 5. Mark interrupted runs as 'cancelled'
 */
import type { RunStore } from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'
import type { EventBridge } from '../ws/event-bridge.js'

export interface ShutdownConfig {
  /** Maximum time to wait for in-progress runs (default: 30_000 ms) */
  drainTimeoutMs: number
  /** RunStore for marking interrupted runs */
  runStore: RunStore
  /** EventBus to emit shutdown events */
  eventBus: DzipEventBus
  /** EventBridge to close WebSocket connections */
  eventBridge?: EventBridge
  /** Custom cleanup callbacks */
  onDrain?: () => Promise<void>
}

export type ShutdownState = 'running' | 'draining' | 'stopped'

export class GracefulShutdown {
  private state: ShutdownState = 'running'
  private activeRunIds = new Set<string>()
  private shutdownPromise: Promise<void> | null = null
  private readonly config: ShutdownConfig

  constructor(config: ShutdownConfig) {
    this.config = {
      ...config,
      drainTimeoutMs: config.drainTimeoutMs ?? 30_000,
    }
  }

  /** Register signal handlers. Call once at server startup. */
  registerSignalHandlers(): void {
    const handler = () => { void this.shutdown() }
    process.on('SIGTERM', handler)
    process.on('SIGINT', handler)
  }

  /** Check if the server is accepting new runs */
  isAcceptingRuns(): boolean {
    return this.state === 'running'
  }

  /** Track an active run */
  trackRun(runId: string): void {
    this.activeRunIds.add(runId)
  }

  /** Untrack a completed/failed run */
  untrackRun(runId: string): void {
    this.activeRunIds.delete(runId)
  }

  /** Get current shutdown state */
  getState(): ShutdownState {
    return this.state
  }

  /** Initiate graceful shutdown */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise

    this.shutdownPromise = this.performShutdown()
    return this.shutdownPromise
  }

  private async performShutdown(): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[ForgeServer] Initiating graceful shutdown...')
    this.state = 'draining'

    this.config.eventBus.emit({
      type: 'agent:started',
      agentId: '__system__',
      runId: '__shutdown__',
    })

    // Wait for in-progress runs with timeout
    if (this.activeRunIds.size > 0) {
      // eslint-disable-next-line no-console
      console.log(`[ForgeServer] Waiting for ${this.activeRunIds.size} active run(s)...`)

      await Promise.race([
        this.waitForActiveRuns(),
        this.timeout(this.config.drainTimeoutMs),
      ])
    }

    // Mark any remaining runs as cancelled
    if (this.activeRunIds.size > 0) {
      // eslint-disable-next-line no-console
      console.log(`[ForgeServer] Cancelling ${this.activeRunIds.size} remaining run(s)`)

      const cancelPromises = [...this.activeRunIds].map(async (runId) => {
        try {
          await this.config.runStore.update(runId, {
            status: 'cancelled',
            completedAt: new Date(),
          })
        } catch {
          // Best-effort cancellation
        }
      })
      await Promise.allSettled(cancelPromises)
    }

    // Close WebSocket connections
    if (this.config.eventBridge) {
      this.config.eventBridge.disconnectAll()
    }

    // Run custom cleanup
    if (this.config.onDrain) {
      try {
        await this.config.onDrain()
      } catch {
        // Best-effort cleanup
      }
    }

    this.state = 'stopped'
    // eslint-disable-next-line no-console
    console.log('[ForgeServer] Shutdown complete.')
    process.exit(0)
  }

  private waitForActiveRuns(): Promise<void> {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.activeRunIds.size === 0) {
          clearInterval(check)
          resolve()
        }
      }, 500)
    })
  }

  private timeout(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
