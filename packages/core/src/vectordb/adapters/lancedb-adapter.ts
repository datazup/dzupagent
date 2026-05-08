/**
 * LanceDB vector store adapter -- Arrow-native embedded vector database.
 *
 * Supports:
 * - Persistent local storage (no external service required)
 * - Hybrid search (BM25 full-text + vector similarity + metadata filters)
 * - Zero-copy Arrow Table exchange with @dzupagent/memory-ipc
 * - S3-backed storage for production deployments
 * - MVCC versioning (time-travel queries)
 *
 * Uses dynamic import() -- @lancedb/lancedb is an optional peer dependency.
 *
 * This file is a thin re-export barrel: implementation lives in sibling
 * `lancedb-adapter-*.ts` modules. Public API is preserved -- callers should
 * continue to import from `./lancedb-adapter.js`.
 */

// Public API: configuration and main adapter class
export type { LanceDBAdapterConfig } from './lancedb-adapter-types.js'
export { LanceDBAdapter } from './lancedb-adapter-core.js'

// Public API: SQL filter translation helper (used by tests + custom integrations)
export { translateFilter } from './lancedb-adapter-filter.js'
