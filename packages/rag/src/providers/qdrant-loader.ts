/**
 * Dynamic loader for `@qdrant/js-client-rest`.
 *
 * Mirrors the `loadBullMQ` pattern in `codev-app/api/queue.service.ts`:
 * the package is resolved at runtime via `import()`, so the optional
 * peer dep does not have to be installed for the framework to load.
 *
 * The constructor reference is memoised for the process lifetime; tests
 * can call `__resetQdrantLoaderForTests` to clear that state.
 */

import type { QdrantClientCtor } from './qdrant-types.js'

let _qdrantCtor: QdrantClientCtor | null = null
let _loadAttempted = false
const QDRANT_CLIENT_PEER = '@qdrant/js-client-rest'

async function importOptionalQdrantPeer(specifier: string): Promise<Record<string, unknown>> {
  return await import(specifier) as Record<string, unknown>
}

/**
 * Resolve the `QdrantClient` constructor from `@qdrant/js-client-rest`
 * via dynamic import. Returns `null` if the optional peer dep is not
 * installed. The result is memoised for the process lifetime.
 *
 * Exported for tests so they can reset state via
 * {@link __resetQdrantLoaderForTests}.
 */
export async function loadQdrantClient(): Promise<QdrantClientCtor | null> {
  if (_loadAttempted) return _qdrantCtor
  _loadAttempted = true

  try {
    const mod = await importOptionalQdrantPeer(QDRANT_CLIENT_PEER)
    const QdrantClient = mod['QdrantClient']
    if (typeof QdrantClient !== 'function') {
      _qdrantCtor = null
      return null
    }
    _qdrantCtor = QdrantClient as QdrantClientCtor
    return _qdrantCtor
  } catch {
    _qdrantCtor = null
    return null
  }
}

/** Test-only — clear the memoised loader state. */
export function __resetQdrantLoaderForTests(): void {
  _qdrantCtor = null
  _loadAttempted = false
}
