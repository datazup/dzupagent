/**
 * Snapshot builder utility.
 *
 * Given a live `MemoryService`-compatible object, a namespace, and an optional
 * scope, {@link buildFrozenSnapshot} loads the current records and produces a
 * populated {@link FrozenSnapshot} ready to be assigned to `DzupAgentConfig`.
 *
 * The helper depends only on a structural interface (`MemoryServiceLike`) so
 * that `@dzupagent/context` stays free of a hard dependency on
 * `@dzupagent/memory`. Any object exposing a compatible `get()` method — the
 * production `MemoryService`, a test double, or a thin adapter — can be passed.
 *
 * Errors raised by the memory service (for example a missing scope key on a
 * strictly scoped namespace) are swallowed so that snapshot construction is
 * non-fatal: callers receive an empty, inactive-looking snapshot instead of an
 * exception propagating through the agent bootstrap path.
 */
import { FrozenSnapshot } from './auto-compress.js'

/**
 * Minimal subset of `MemoryService` required by {@link buildFrozenSnapshot}.
 *
 * Declared locally so this package does not need to import from
 * `@dzupagent/memory` — the production class already matches this shape.
 */
export interface MemoryServiceLike {
  /**
   * Retrieve all records from a namespace under the given scope. When
   * `key` is omitted the implementation lists every record in the scope.
   */
  get(
    namespace: string,
    scope: Record<string, string>,
    key?: string,
  ): Promise<Record<string, unknown>[]>
}

/**
 * Options controlling how records are serialized into the frozen context blob.
 */
export interface BuildFrozenSnapshotOptions {
  /** Maximum number of records to include in the snapshot (default: unlimited) */
  maxRecords?: number
  /** Maximum characters per serialized record before truncation (default: 2000) */
  maxCharsPerRecord?: number
  /** Header line prepended to the formatted snapshot (default: "## Memory Snapshot") */
  header?: string
}

const DEFAULT_HEADER = '## Memory Snapshot'
const DEFAULT_MAX_CHARS = 2000

/**
 * Serialize a record to a readable string. Prefers a `text` field when
 * present; falls back to deterministic JSON serialization otherwise.
 */
function serializeRecord(record: Record<string, unknown>, maxChars: number): string {
  const text =
    typeof record['text'] === 'string' ? record['text'] : JSON.stringify(record)
  return text.length > maxChars ? text.slice(0, maxChars) + '...' : text
}

/**
 * Build a {@link FrozenSnapshot} from the records currently held by a
 * `MemoryService`-like object.
 *
 * The snapshot is already `freeze()`d and therefore `isActive() === true`. The
 * embedded context string contains the serialized records separated by blank
 * lines, so it can be dropped directly into a system prompt.
 *
 * This helper is intentionally non-fatal — if the memory service throws (for
 * example, because the scope is missing a required key) the returned snapshot
 * is frozen with an empty record list.
 */
export async function buildFrozenSnapshot(
  memory: MemoryServiceLike,
  namespace: string,
  scope?: Record<string, string>,
  options?: BuildFrozenSnapshotOptions,
): Promise<FrozenSnapshot> {
  const maxChars = options?.maxCharsPerRecord ?? DEFAULT_MAX_CHARS
  const header = options?.header ?? DEFAULT_HEADER

  let records: Record<string, unknown>[] = []
  try {
    records = await memory.get(namespace, scope ?? {})
  } catch {
    // Non-fatal — fall through with an empty snapshot body.
    records = []
  }

  // Drop expired records (P10 Track C — memory decay / TTL).  A record is
  // expired when it carries a numeric `expiresAt` timestamp less than the
  // current wall clock.  Records without `expiresAt` are never filtered so
  // untagged records keep their pre-TTL behaviour.
  const now = Date.now()
  const live = records.filter(record => {
    const expiresAt = record['expiresAt']
    return typeof expiresAt !== 'number' || expiresAt >= now
  })

  const limited =
    options?.maxRecords !== undefined ? live.slice(0, options.maxRecords) : live

  const body =
    limited.length === 0
      ? ''
      : limited.map(r => serializeRecord(r, maxChars)).join('\n\n')

  const context = body.length === 0 ? header : `${header}\n\n${body}`

  const snapshot = new FrozenSnapshot()
  snapshot.freeze(context)
  return snapshot
}
