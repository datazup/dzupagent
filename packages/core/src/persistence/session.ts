import { createHash } from 'node:crypto'
import type { RunnableConfig } from '@langchain/core/runnables'

/**
 * Manages LangGraph thread IDs and runnable configs.
 *
 * Thread IDs are deterministic SHA-256 hashes derived from a scope
 * object (e.g. `{ tenantId, projectId, sessionId }`), ensuring the
 * same scope always maps to the same thread.
 */
export class SessionManager {
  /**
   * Derives a deterministic thread ID from a scope object.
   * Keys are sorted alphabetically before hashing so insertion order
   * does not affect the result.
   */
  getThreadId(scope: Record<string, string>): string {
    const sorted = Object.entries(scope).sort(([a], [b]) => a.localeCompare(b))
    const key = sorted.map(([k, v]) => `${k}:${v}`).join('|')
    return createHash('sha256').update(key).digest('hex').slice(0, 32)
  }

  /**
   * Builds a `RunnableConfig` suitable for passing to LangGraph
   * `.invoke()` / `.stream()` calls.
   */
  getConfig(threadId: string, callbacks?: unknown[]): RunnableConfig {
    return {
      configurable: { thread_id: threadId },
      ...(callbacks && callbacks.length > 0
        ? { callbacks: callbacks as RunnableConfig['callbacks'] }
        : {}),
    }
  }
}
