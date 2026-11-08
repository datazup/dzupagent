/**
 * MC-07a — provider-free retrieval relevance, leakage and token evaluation
 * (MEMCTX-RETRIEVAL-EVAL-20261108-R1).
 *
 * Ingests a fixed two-tenant corpus through `MemoryService.put` and scores
 * what `MemoryService.search(namespace, scope, query, 5)` returns over a fixed
 * query set, in two configurations:
 *
 *   - `keyword-only`   — no `semanticStore`; the in-memory store's keyword
 *                        channel with decay re-ranking;
 *   - `keyword+vector` — the same plus a deterministic in-test
 *                        `SemanticStoreAdapter` (hashed bag-of-words, cosine),
 *                        fused by reciprocal rank.
 *
 * Record identity comes from a corpus oracle keyed by each record's globally
 * unique `text`, never from the returned value (search returns values without
 * their store key). No provider, network, database or model call; the clock is
 * fixed. One `MC07A_RESULT ` JSON line is printed per configuration.
 *
 * Low recall or a high false-recall rate is a measurement, not a failure. The
 * assertions guard the harness (nothing failed silently), tenant isolation,
 * determinism and the integrity of the reported numbers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import { MemoryService } from '../memory-service.js'
import { createStore } from '../store-factory.js'
import type {
  NamespaceConfig,
  SemanticMetadataFilter,
  SemanticStoreAdapter,
} from '../memory-types.js'
import type { DecayMetadata } from '../decay-engine.js'

// ---------------------------------------------------------------------------
// Fixed clock and namespace
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.UTC(2026, 10, 8, 12, 0, 0)
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const K = 5
const NAMESPACE = 'kb'
const NS_CONFIG: NamespaceConfig[] = [
  { name: NAMESPACE, scopeKeys: ['tenantId'], searchable: true },
]

type Tenant = 'acme' | 'globex'
const TENANTS: readonly Tenant[] = ['acme', 'globex']
const otherTenant = (t: Tenant): Tenant => (t === 'acme' ? 'globex' : 'acme')

/** Stale version of a fact: last touched twenty days ago, one-day half-life. */
const STALE_DECAY: DecayMetadata = {
  strength: 1,
  accessCount: 0,
  lastAccessedAt: FIXED_NOW - 20 * DAY_MS,
  createdAt: FIXED_NOW - 20 * DAY_MS,
  halfLifeMs: DAY_MS,
}

/** Fresh version of the same fact: last touched one hour ago. */
const FRESH_DECAY: DecayMetadata = {
  strength: 1,
  accessCount: 0,
  lastAccessedAt: FIXED_NOW - HOUR_MS,
  createdAt: FIXED_NOW - HOUR_MS,
  halfLifeMs: DAY_MS,
}

// ---------------------------------------------------------------------------
// Corpus — 40 records, 20 per tenant. The tenants hold parallel facts with
// different values, so a scope error surfaces as leakage. Each tenant has one
// stale/fresh pair carrying explicit `_decay` (the stale one is written first,
// so it ranks first by insertion and only decay re-ranking puts the fresh one
// ahead). Every `text` is globally unique.
// ---------------------------------------------------------------------------

interface CorpusRecord {
  key: string
  tenant: Tenant
  text: string
  decay?: DecayMetadata
}

const CORPUS: readonly CorpusRecord[] = [
  // acme
  { key: 'acme-refund-stale', tenant: 'acme', decay: STALE_DECAY, text: 'Refund window policy: customers may request a refund within fourteen days of purchase.' },
  { key: 'acme-refund-fresh', tenant: 'acme', decay: FRESH_DECAY, text: 'Refund window policy: customers may request a refund within thirty days of purchase.' },
  { key: 'acme-freeze', tenant: 'acme', text: 'Deploy freeze begins every Friday at noon and lasts until Monday morning.' },
  { key: 'acme-oncall', tenant: 'acme', text: 'The on-call rotation hands over every Tuesday; the primary engineer carries the pager for one week.' },
  { key: 'acme-backup', tenant: 'acme', text: 'Database backups run nightly and are kept for ninety days in cold storage.' },
  { key: 'acme-vpn', tenant: 'acme', text: 'Remote staff connect through the WireGuard tunnel before opening the admin console.' },
  { key: 'acme-severity', tenant: 'acme', text: 'Incident severity one means customer data is unavailable; page the incident commander immediately.' },
  { key: 'acme-review', tenant: 'acme', text: 'Every pull request needs two approving reviews before merge to the trunk branch.' },
  { key: 'acme-release', tenant: 'acme', text: 'The release train departs on the first and third Wednesday of each month.' },
  { key: 'acme-invoice', tenant: 'acme', text: 'Invoices are issued on the last business day and are payable within net forty five terms.' },
  { key: 'acme-office', tenant: 'acme', text: 'The Lisbon office opens at eight and closes at six on weekdays.' },
  { key: 'acme-coffee', tenant: 'acme', text: 'The espresso machine on the third floor is descaled every second Thursday.' },
  { key: 'acme-build', tenant: 'acme', text: 'Build agents are reimaged every sixty days from the golden image.' },
  { key: 'acme-retention', tenant: 'acme', text: 'Chat transcripts are deleted after one year unless a legal hold applies.' },
  { key: 'acme-mascot', tenant: 'acme', text: 'The team mascot is a ceramic owl named Pemberton.' },
  { key: 'acme-parking', tenant: 'acme', text: 'Visitor parking is in the north garage on level two.' },
  { key: 'acme-latency', tenant: 'acme', text: 'The checkout service latency budget is three hundred milliseconds at the tail.' },
  { key: 'acme-holiday', tenant: 'acme', text: 'The winter shutdown runs from late December until the second week of January.' },
  { key: 'acme-laptop', tenant: 'acme', text: 'New hires receive a fourteen inch laptop with an external monitor on their first day.' },
  { key: 'acme-standup', tenant: 'acme', text: 'The daily standup happens at half past nine in the blue room.' },
  // globex
  { key: 'globex-refund-stale', tenant: 'globex', decay: STALE_DECAY, text: 'Refund window rule: buyers may ask for a refund within seven days of the order.' },
  { key: 'globex-refund-fresh', tenant: 'globex', decay: FRESH_DECAY, text: 'Refund window rule: buyers may ask for a refund within twenty one days of the order.' },
  { key: 'globex-freeze', tenant: 'globex', text: 'Deploy freeze starts each Thursday evening and ends on Monday at nine.' },
  { key: 'globex-oncall', tenant: 'globex', text: 'The on-call rotation changes every Monday; the secondary engineer shadows the primary for two weeks.' },
  { key: 'globex-backup', tenant: 'globex', text: 'Database backups run every six hours and are retained for thirty days.' },
  { key: 'globex-vpn', tenant: 'globex', text: 'Contractors connect through the OpenVPN gateway before reaching the staging cluster.' },
  { key: 'globex-severity', tenant: 'globex', text: 'Incident severity one means payments are failing; open a bridge call within five minutes.' },
  { key: 'globex-review', tenant: 'globex', text: 'Every pull request needs one approving review and a green pipeline before merge.' },
  { key: 'globex-release', tenant: 'globex', text: 'The release train leaves every Tuesday after the change advisory board meets.' },
  { key: 'globex-invoice', tenant: 'globex', text: 'Invoices are sent on the fifteenth and are payable within net thirty terms.' },
  { key: 'globex-office', tenant: 'globex', text: 'The Osaka office opens at nine and closes at seven on weekdays.' },
  { key: 'globex-coffee', tenant: 'globex', text: 'The tea kettle in the fifth floor kitchen is replaced every spring.' },
  { key: 'globex-build', tenant: 'globex', text: 'Build agents are rebuilt weekly from the hardened base image.' },
  { key: 'globex-retention', tenant: 'globex', text: 'Support tickets are archived after two years and purged after five.' },
  { key: 'globex-antenna', tenant: 'globex', text: 'The ground station antenna is recalibrated after every solar storm warning.' },
  { key: 'globex-parking', tenant: 'globex', text: 'Visitor parking is behind the south warehouse next to the loading dock.' },
  { key: 'globex-latency', tenant: 'globex', text: 'The search service latency budget is two hundred milliseconds at the median.' },
  { key: 'globex-holiday', tenant: 'globex', text: 'The summer shutdown covers the first two weeks of August.' },
  { key: 'globex-laptop', tenant: 'globex', text: 'New hires receive a sixteen inch laptop and a standing desk in their first week.' },
  { key: 'globex-standup', tenant: 'globex', text: 'The weekly planning meeting happens on Monday afternoon in the atrium.' },
]

// ---------------------------------------------------------------------------
// Queries — 16 answerable (gold keys in the queried tenant), 6 unanswerable
// (the answer exists only in the other tenant, or nowhere). Short exact
// phrases mixed with natural-language questions.
// ---------------------------------------------------------------------------

interface EvalQuery {
  id: string
  tenant: Tenant
  text: string
  gold: readonly string[]
}

const ANSWERABLE: readonly EvalQuery[] = [
  { id: 'A01', tenant: 'acme', text: 'refund window', gold: ['acme-refund-fresh'] },
  { id: 'A02', tenant: 'acme', text: 'How many days do customers have to request a refund?', gold: ['acme-refund-fresh'] },
  { id: 'A03', tenant: 'acme', text: 'WireGuard tunnel', gold: ['acme-vpn'] },
  { id: 'A04', tenant: 'acme', text: 'pager handover weekday for the primary engineer', gold: ['acme-oncall'] },
  { id: 'A05', tenant: 'acme', text: 'deploy freeze', gold: ['acme-freeze'] },
  { id: 'A06', tenant: 'acme', text: 'When does the release train depart?', gold: ['acme-release'] },
  { id: 'A07', tenant: 'acme', text: 'database backups', gold: ['acme-backup'] },
  { id: 'A08', tenant: 'acme', text: 'What is the latency budget for checkout?', gold: ['acme-latency'] },
  { id: 'A09', tenant: 'acme', text: 'office opening times and visitor parking', gold: ['acme-office', 'acme-parking'] },
  { id: 'A10', tenant: 'globex', text: 'refund window', gold: ['globex-refund-fresh'] },
  { id: 'A11', tenant: 'globex', text: 'How many days do buyers have to ask for a refund?', gold: ['globex-refund-fresh'] },
  { id: 'A12', tenant: 'globex', text: 'OpenVPN gateway', gold: ['globex-vpn'] },
  { id: 'A13', tenant: 'globex', text: 'pull request', gold: ['globex-review'] },
  { id: 'A14', tenant: 'globex', text: 'Where should visitor cars park?', gold: ['globex-parking'] },
  { id: 'A15', tenant: 'globex', text: 'incident severity one', gold: ['globex-severity'] },
  { id: 'A16', tenant: 'globex', text: 'shutdown', gold: ['globex-holiday'] },
]

const UNANSWERABLE: readonly EvalQuery[] = [
  { id: 'U01', tenant: 'acme', text: 'ground station antenna', gold: [] }, // only in globex
  { id: 'U02', tenant: 'globex', text: 'ceramic owl mascot', gold: [] }, // only in acme
  { id: 'U03', tenant: 'acme', text: 'How often is the tea kettle replaced?', gold: [] }, // only in globex
  { id: 'U04', tenant: 'globex', text: 'Lisbon office', gold: [] }, // only in acme
  { id: 'U05', tenant: 'acme', text: 'quarterly bonus payout schedule', gold: [] }, // nowhere
  { id: 'U06', tenant: 'globex', text: 'What is the guest wifi network name?', gold: [] }, // nowhere
]

const ALL_QUERIES: readonly EvalQuery[] = [...ANSWERABLE, ...UNANSWERABLE]
const QUERY_BY_ID = new Map(ALL_QUERIES.map(q => [q.id, q]))

/** Positive controls (assertion 1). */
const KEYWORD_CONTROL = { queryId: 'A03', goldKey: 'acme-vpn' }
const VECTOR_CONTROL = { queryId: 'A04', goldKey: 'acme-oncall' }

// ---------------------------------------------------------------------------
// Oracle: globally unique text -> corpus record
// ---------------------------------------------------------------------------

const ORACLE_BY_TEXT = new Map<string, CorpusRecord[]>()
for (const rec of CORPUS) {
  const list = ORACLE_BY_TEXT.get(rec.text) ?? []
  list.push(rec)
  ORACLE_BY_TEXT.set(rec.text, list)
}
const ORACLE_BY_KEY = new Map(CORPUS.map(r => [r.key, r]))

/** Resolve a returned record to its single corpus entry, or explain why not. */
function resolve(record: Record<string, unknown>): { rec?: CorpusRecord; error?: string } {
  const text = record['text']
  if (typeof text !== 'string') return { error: 'returned record has no string text' }
  const hits = ORACLE_BY_TEXT.get(text) ?? []
  if (hits.length === 0) return { error: `unresolved text: ${text.slice(0, 60)}` }
  if (hits.length > 1) return { error: `ambiguous text: ${text.slice(0, 60)}` }
  return { rec: hits[0]! }
}

// ---------------------------------------------------------------------------
// Deterministic in-test SemanticStoreAdapter
// ---------------------------------------------------------------------------

const DIM = 4096
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or', 'is',
  'are', 'be', 'do', 'does', 'how', 'what', 'when', 'where', 'which', 'who',
  'why', 'many', 'much', 'have', 'has', 'with', 'their', 'they', 'may', 'should',
  'it', 'its', 'this', 'that', 'from', 'every', 'each', 'often',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(t => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t))
}

/** FNV-1a 32-bit. */
function fnv1a(token: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function embed(text: string): Float64Array {
  const v = new Float64Array(DIM)
  for (const t of tokenize(text)) v[fnv1a(t) % DIM]! += 1
  return v
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < DIM; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

/** Evaluate the `eq`/`and` filter shape MemoryService passes. Anything else throws. */
function matchesFilter(meta: Record<string, unknown>, filter: SemanticMetadataFilter): boolean {
  if ('and' in filter) return filter.and.every(f => matchesFilter(meta, f))
  if ('or' in filter) throw new Error('unsupported filter: or')
  if (filter.op !== 'eq') throw new Error(`unsupported filter op: ${filter.op}`)
  return meta[filter.field] === filter.value
}

interface StoredDoc {
  id: string
  text: string
  metadata: Record<string, unknown>
  vector: Float64Array
}

class HashedBowAdapter implements SemanticStoreAdapter {
  readonly collections = new Map<string, Map<string, StoredDoc>>()
  readonly upsertDocIds: string[] = []
  readonly searchCalls: Array<{ collection: string; query: string; limit: number; filter: SemanticMetadataFilter | undefined }> = []

  async ensureCollection(collection: string): Promise<void> {
    if (!this.collections.has(collection)) this.collections.set(collection, new Map())
  }

  async upsert(
    collection: string,
    docs: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>,
  ): Promise<void> {
    const col = this.collections.get(collection)
    if (!col) throw new Error(`missing collection ${collection}`)
    for (const d of docs) {
      this.upsertDocIds.push(d.id)
      col.set(d.id, { id: d.id, text: d.text, metadata: { ...(d.metadata ?? {}) }, vector: embed(d.text) })
    }
  }

  async search(
    collection: string,
    query: string,
    limit: number,
    filter?: SemanticMetadataFilter,
  ): Promise<Array<{ id: string; text: string; score: number; metadata: Record<string, unknown> }>> {
    this.searchCalls.push({ collection, query, limit, filter: filter ? structuredClone(filter) : undefined })
    const col = this.collections.get(collection)
    if (!col) throw new Error(`missing collection ${collection}`)
    const q = embed(query)
    const scored: Array<{ id: string; text: string; score: number; metadata: Record<string, unknown> }> = []
    for (const doc of col.values()) {
      if (filter && !matchesFilter(doc.metadata, filter)) continue
      const score = cosine(q, doc.vector)
      // Minimum similarity: at least one shared content token.
      if (score > 0) scored.push({ id: doc.id, text: doc.text, score, metadata: { ...doc.metadata } })
    }
    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return scored.slice(0, limit)
  }

  async delete(): Promise<void> {
    /* not used by the evaluation */
  }
}

// ---------------------------------------------------------------------------
// Recording store proxy
// ---------------------------------------------------------------------------

interface StoreRecorder {
  searchCalls: number
  searchThrows: number
}

function recordingStore(target: BaseStore, rec: StoreRecorder): BaseStore {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver) as unknown
      if (prop === 'search' && typeof value === 'function') {
        return async (...args: unknown[]) => {
          rec.searchCalls += 1
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(t, args)
          } catch (err) {
            rec.searchThrows += 1
            throw err
          }
        }
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value
    },
  })
}

// ---------------------------------------------------------------------------
// One run of one configuration
// ---------------------------------------------------------------------------

type ConfigName = 'keyword-only' | 'keyword+vector'
const CONFIGS: readonly ConfigName[] = ['keyword-only', 'keyword+vector']

interface PutCheck {
  key: string
  status: string
  piiRedacted: boolean | undefined
  storedText: unknown
}

interface QueryLog {
  id: string
  tenant: Tenant
  rankedKeys: string[]
  resolveErrors: string[]
  prompt: string
}

interface RunResult {
  config: ConfigName
  puts: PutCheck[]
  storeRecorder: StoreRecorder
  adapter: HashedBowAdapter | undefined
  events: Array<{ type: string } & Record<string, unknown>>
  queries: QueryLog[]
}

async function runConfig(config: ConfigName): Promise<RunResult> {
  const raw = await createStore({ type: 'memory' })
  const storeRecorder: StoreRecorder = { searchCalls: 0, searchThrows: 0 }
  const store = recordingStore(raw, storeRecorder)
  const adapter = config === 'keyword+vector' ? new HashedBowAdapter() : undefined
  const events: RunResult['events'] = []
  const svc = new MemoryService(store, NS_CONFIG, {
    ...(adapter ? { semanticStore: adapter } : {}),
    eventBus: { emit: e => { events.push(e) } },
    agentId: 'mc07a-eval',
  })

  const puts: PutCheck[] = []
  for (const rec of CORPUS) {
    const value: Record<string, unknown> = { text: rec.text }
    if (rec.decay) value['_decay'] = { ...rec.decay }
    const result = await svc.put(NAMESPACE, { tenantId: rec.tenant }, rec.key, value)
    const stored = await raw.get([NAMESPACE, rec.tenant], rec.key)
    puts.push({
      key: rec.key,
      status: result.status,
      piiRedacted: result.status === 'written' ? result.piiRedacted : undefined,
      storedText: (stored?.value as Record<string, unknown> | undefined)?.['text'],
    })
  }

  const queries: QueryLog[] = []
  for (const q of ALL_QUERIES) {
    const results = await svc.search(NAMESPACE, { tenantId: q.tenant }, q.text, K)
    const rankedKeys: string[] = []
    const resolveErrors: string[] = []
    for (const r of results) {
      const { rec, error } = resolve(r)
      if (rec) rankedKeys.push(rec.key)
      else resolveErrors.push(error ?? 'unknown')
    }
    queries.push({ id: q.id, tenant: q.tenant, rankedKeys, resolveErrors, prompt: svc.formatForPrompt(results) })
  }
  await svc.close()
  return { config, puts, storeRecorder, adapter, events, queries }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4
const tokenEstimate = (chars: number): number => Math.ceil(chars / 4)

interface Report {
  config: ConfigName
  k: number
  answerable: number
  unanswerable: number
  recallAt1: number
  recallAt3: number
  recallAt5: number
  hitAt1: number
  hitAt3: number
  hitAt5: number
  falseRecall: { numerator: number; denominator: number; rate: number }
  leakageCount: number
  promptSize: {
    tokenEstimate: 'chars/4'
    sumChars: number
    sumTokens: number
    meanChars: number
    meanTokens: number
  }
  tokensPerSuccess: { numerator: number; denominator: number; value: number | 'undefined:no-success' }
  perQuery: Array<{ id: string; tenant: Tenant; kind: 'answerable' | 'unanswerable'; rankedKeys: string[]; chars: number; tokens: number }>
}

function buildReport(run: RunResult): Report {
  const perQuery = run.queries.map(l => {
    const q = QUERY_BY_ID.get(l.id)!
    const chars = l.prompt.length
    return {
      id: l.id,
      tenant: l.tenant,
      kind: q.gold.length > 0 ? ('answerable' as const) : ('unanswerable' as const),
      rankedKeys: [...l.rankedKeys],
      chars,
      tokens: tokenEstimate(chars),
    }
  })
  const recall = (k: number): number => {
    let s = 0
    for (const q of ANSWERABLE) {
      const top = perQuery.find(p => p.id === q.id)!.rankedKeys.slice(0, k)
      s += q.gold.filter(g => top.includes(g)).length / q.gold.length
    }
    return s / ANSWERABLE.length
  }
  const hit = (k: number): number => {
    let s = 0
    for (const q of ANSWERABLE) {
      const top = perQuery.find(p => p.id === q.id)!.rankedKeys.slice(0, k)
      if (q.gold.some(g => top.includes(g))) s += 1
    }
    return s / ANSWERABLE.length
  }
  const falseRecallNum = UNANSWERABLE.filter(q => perQuery.find(p => p.id === q.id)!.rankedKeys.length > 0).length
  let leakageCount = 0
  for (const p of perQuery) {
    for (const key of p.rankedKeys) if (ORACLE_BY_KEY.get(key)!.tenant !== p.tenant) leakageCount += 1
  }
  const sumChars = perQuery.reduce((a, p) => a + p.chars, 0)
  const sumTokens = perQuery.reduce((a, p) => a + p.tokens, 0)
  const successes = ANSWERABLE.filter(q => {
    const top = perQuery.find(p => p.id === q.id)!.rankedKeys.slice(0, 5)
    return q.gold.some(g => top.includes(g))
  }).length
  return {
    config: run.config,
    k: K,
    answerable: ANSWERABLE.length,
    unanswerable: UNANSWERABLE.length,
    recallAt1: round4(recall(1)),
    recallAt3: round4(recall(3)),
    recallAt5: round4(recall(5)),
    hitAt1: round4(hit(1)),
    hitAt3: round4(hit(3)),
    hitAt5: round4(hit(5)),
    falseRecall: {
      numerator: falseRecallNum,
      denominator: UNANSWERABLE.length,
      rate: round4(falseRecallNum / UNANSWERABLE.length),
    },
    leakageCount,
    promptSize: {
      tokenEstimate: 'chars/4',
      sumChars,
      sumTokens,
      meanChars: round4(sumChars / perQuery.length),
      meanTokens: round4(sumTokens / perQuery.length),
    },
    tokensPerSuccess: {
      numerator: sumTokens,
      denominator: successes,
      value: successes === 0 ? 'undefined:no-success' : round4(sumTokens / successes),
    },
    perQuery,
  }
}

/**
 * Independent recomputation (assertion 4) from the logged per-query ranked
 * keys only, with unrounded values. Gold sets come from the query table and
 * prompt sizes from the oracle texts, never from the reported numbers.
 */
function recompute(logged: Report['perQuery'], format: (r: Record<string, unknown>[]) => string) {
  const byId = new Map(logged.map(p => [p.id, p.rankedKeys]))
  const a = ALL_QUERIES.filter(q => q.gold.length > 0)
  const u = ALL_QUERIES.filter(q => q.gold.length === 0)
  const rk = (id: string, k: number): string[] => (byId.get(id) ?? []).slice(0, k)
  const out = {
    recall: {} as Record<number, number>,
    hit: {} as Record<number, number>,
    falseRecallNum: 0,
    leakage: 0,
    chars: new Map<string, number>(),
    sumChars: 0,
    sumTokens: 0,
    successes: 0,
  }
  for (const k of [1, 3, 5]) {
    let r = 0
    let h = 0
    for (const q of a) {
      const got = new Set(rk(q.id, k))
      let inter = 0
      for (const g of q.gold) if (got.has(g)) inter++
      r += inter / q.gold.length
      h += inter > 0 ? 1 : 0
    }
    out.recall[k] = r / a.length
    out.hit[k] = h / a.length
  }
  for (const q of u) if (rk(q.id, K).length > 0) out.falseRecallNum++
  for (const q of ALL_QUERIES) {
    for (const key of byId.get(q.id) ?? []) {
      if (ORACLE_BY_KEY.get(key)?.tenant !== q.tenant) out.leakage++
    }
    const chars = format((byId.get(q.id) ?? []).map(key => ({ text: ORACLE_BY_KEY.get(key)!.text }))).length
    out.chars.set(q.id, chars)
    out.sumChars += chars
    out.sumTokens += Math.ceil(chars / 4)
  }
  for (const q of a) if (q.gold.some(g => rk(q.id, 5).includes(g))) out.successes++
  return out
}

// ---------------------------------------------------------------------------
// The evaluation
// ---------------------------------------------------------------------------

describe('MC-07a retrieval economy evaluation (MemoryService put/search, k=5)', () => {
  const runs = new Map<ConfigName, [RunResult, RunResult]>()
  const lines = new Map<ConfigName, string>()
  const formatter = new MemoryService({} as BaseStore, NS_CONFIG)

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_NOW)
    for (const config of CONFIGS) {
      const first = await runConfig(config)
      const second = await runConfig(config)
      runs.set(config, [first, second])
      lines.set(config, `MC07A_RESULT ${JSON.stringify(buildReport(first))}`)
    }
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('fixture shape matches the card (30-60 records, two tenants, >=12 answerable, >=5 unanswerable, unique texts and keys)', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(30)
    expect(CORPUS.length).toBeLessThanOrEqual(60)
    expect(new Set(CORPUS.map(r => r.tenant))).toEqual(new Set(TENANTS))
    expect(new Set(CORPUS.map(r => r.key)).size).toBe(CORPUS.length)
    expect(new Set(CORPUS.map(r => r.text)).size).toBe(CORPUS.length)
    expect(CORPUS.filter(r => r.decay).length).toBeGreaterThanOrEqual(2)
    expect(ANSWERABLE.length).toBeGreaterThanOrEqual(12)
    expect(UNANSWERABLE.length).toBeGreaterThanOrEqual(5)
    for (const q of ANSWERABLE) {
      for (const g of q.gold) expect(ORACLE_BY_KEY.get(g)?.tenant).toBe(q.tenant)
    }
    // Unanswerable: no corpus record of the queried tenant is gold for it by
    // construction; the "only in the other tenant" ones have a foreign match.
    expect(UNANSWERABLE.every(q => q.gold.length === 0)).toBe(true)
  })

  describe('1. harness integrity', () => {
    it.each(CONFIGS)('%s: every put is written, unredacted, and stores the oracle text', config => {
      for (const run of runs.get(config)!) {
        expect(run.puts).toHaveLength(CORPUS.length)
        for (const p of run.puts) {
          const rec = ORACLE_BY_KEY.get(p.key)!
          expect({ key: p.key, status: p.status, piiRedacted: p.piiRedacted, text: p.storedText })
            .toEqual({ key: p.key, status: 'written', piiRedacted: false, text: rec.text })
        }
      }
    })

    it('keyword+vector: the adapter received exactly one upsert per corpus record', () => {
      for (const run of runs.get('keyword+vector')!) {
        const ids = run.adapter!.upsertDocIds
        expect(ids).toHaveLength(CORPUS.length)
        expect(new Set(ids).size).toBe(CORPUS.length)
        expect(ids).toEqual(CORPUS.map(r => `${NAMESPACE}/${r.tenant}/${r.key}`))
      }
    })

    it('keyword+vector: the adapter search ran once per query', () => {
      for (const run of runs.get('keyword+vector')!) {
        expect(run.adapter!.searchCalls.map(c => c.query)).toEqual(ALL_QUERIES.map(q => q.text))
        for (const c of run.adapter!.searchCalls) expect(c.limit).toBe(K)
      }
    })

    it.each(CONFIGS)('%s: no memory:error or memory:vector_search_failed event was emitted', config => {
      for (const run of runs.get(config)!) {
        const bad = run.events.filter(e => e.type === 'memory:error' || e.type === 'memory:vector_search_failed')
        expect(bad).toEqual([])
      }
    })

    it.each(CONFIGS)('%s: the recorded base-store search ran once per query and never threw', config => {
      for (const run of runs.get(config)!) {
        expect(run.storeRecorder).toEqual({ searchCalls: ALL_QUERIES.length, searchThrows: 0 })
      }
    })

    it.each(CONFIGS)('%s: every returned record resolves to exactly one corpus entry', config => {
      for (const run of runs.get(config)!) {
        for (const q of run.queries) expect({ id: q.id, errors: q.resolveErrors }).toEqual({ id: q.id, errors: [] })
      }
    })

    it('positive control: an exact-phrase query is answered by the keyword channel alone', () => {
      const q = QUERY_BY_ID.get(KEYWORD_CONTROL.queryId)!
      expect(ORACLE_BY_KEY.get(KEYWORD_CONTROL.goldKey)!.text.toLowerCase()).toContain(q.text.toLowerCase())
      for (const run of runs.get('keyword-only')!) {
        const log = run.queries.find(l => l.id === q.id)!
        expect(log.rankedKeys).toContain(KEYWORD_CONTROL.goldKey)
      }
    })

    it('positive control: a paraphrase with no gold substring is answered only with fusion (vector channel)', () => {
      const q = QUERY_BY_ID.get(VECTOR_CONTROL.queryId)!
      expect(ORACLE_BY_KEY.get(VECTOR_CONTROL.goldKey)!.text.toLowerCase()).not.toContain(q.text.toLowerCase())
      for (const run of runs.get('keyword-only')!) {
        expect(run.queries.find(l => l.id === q.id)!.rankedKeys).not.toContain(VECTOR_CONTROL.goldKey)
      }
      for (const run of runs.get('keyword+vector')!) {
        expect(run.queries.find(l => l.id === q.id)!.rankedKeys).toContain(VECTOR_CONTROL.goldKey)
      }
    })
  })

  describe('2. no leakage', () => {
    it.each(CONFIGS)('%s: no returned record belongs to the other tenant', config => {
      for (const run of runs.get(config)!) {
        const leaked = run.queries.flatMap(l =>
          l.rankedKeys
            .filter(k => ORACLE_BY_KEY.get(k)!.tenant === otherTenant(l.tenant))
            .map(k => `${l.id}:${k}`),
        )
        expect(leaked).toEqual([])
      }
    })

    it('keyword+vector: every filter the adapter received names the queried scope', () => {
      for (const run of runs.get('keyword+vector')!) {
        expect(run.adapter!.searchCalls).toHaveLength(ALL_QUERIES.length)
        run.adapter!.searchCalls.forEach((call, i) => {
          const q = ALL_QUERIES[i]!
          expect(call.collection).toBe(`memory_${NAMESPACE}`)
          expect(call.filter).toEqual({
            and: [
              { field: '_ns', op: 'eq', value: NAMESPACE },
              { field: 'tenantId', op: 'eq', value: q.tenant },
            ],
          })
        })
      }
    })
  })

  describe('3. determinism', () => {
    it.each(CONFIGS)('%s: two runs give identical ranked keys', config => {
      const [a, b] = runs.get(config)!
      expect(b.queries.map(q => [q.id, q.rankedKeys])).toEqual(a.queries.map(q => [q.id, q.rankedKeys]))
      expect(buildReport(b)).toEqual(buildReport(a))
    })
  })

  describe('4. measurement integrity and MC07A_RESULT', () => {
    it.each(CONFIGS)('%s: every reported value matches a recomputation from the logged ranked keys', config => {
      const line = lines.get(config)!
      expect(line.startsWith('MC07A_RESULT {')).toBe(true)
      const reported = JSON.parse(line.slice('MC07A_RESULT '.length)) as Report
      const re = recompute(reported.perQuery, r => formatter.formatForPrompt(r))
      const run = runs.get(config)![0]

      // The logged ranked keys are the ones the run observed.
      expect(reported.perQuery.map(p => [p.id, p.rankedKeys])).toEqual(run.queries.map(q => [q.id, q.rankedKeys]))
      expect(reported.config).toBe(config)
      expect(reported.k).toBe(K)
      expect([reported.answerable, reported.unanswerable]).toEqual([ANSWERABLE.length, UNANSWERABLE.length])

      expect(reported.recallAt1).toBe(round4(re.recall[1]!))
      expect(reported.recallAt3).toBe(round4(re.recall[3]!))
      expect(reported.recallAt5).toBe(round4(re.recall[5]!))
      expect(reported.hitAt1).toBe(round4(re.hit[1]!))
      expect(reported.hitAt3).toBe(round4(re.hit[3]!))
      expect(reported.hitAt5).toBe(round4(re.hit[5]!))
      expect(reported.falseRecall).toEqual({
        numerator: re.falseRecallNum,
        denominator: UNANSWERABLE.length,
        rate: round4(re.falseRecallNum / UNANSWERABLE.length),
      })
      expect(reported.leakageCount).toBe(re.leakage)
      expect(reported.leakageCount).toBe(0)

      for (const p of reported.perQuery) {
        expect({ id: p.id, chars: p.chars, tokens: p.tokens }).toEqual({
          id: p.id,
          chars: re.chars.get(p.id),
          tokens: Math.ceil(re.chars.get(p.id)! / 4),
        })
      }
      expect(reported.promptSize).toEqual({
        tokenEstimate: 'chars/4',
        sumChars: re.sumChars,
        sumTokens: re.sumTokens,
        meanChars: round4(re.sumChars / ALL_QUERIES.length),
        meanTokens: round4(re.sumTokens / ALL_QUERIES.length),
      })
      expect(reported.tokensPerSuccess).toEqual({
        numerator: re.sumTokens,
        denominator: re.successes,
        value: re.successes === 0 ? 'undefined:no-success' : round4(re.sumTokens / re.successes),
      })

      // All counts are integers; all ratios are finite JSON numbers.
      for (const n of [reported.leakageCount, reported.falseRecall.numerator, reported.promptSize.sumChars, reported.promptSize.sumTokens, reported.tokensPerSuccess.numerator, reported.tokensPerSuccess.denominator]) {
        expect(Number.isInteger(n)).toBe(true)
      }
      for (const x of [reported.recallAt1, reported.recallAt3, reported.recallAt5, reported.hitAt1, reported.hitAt3, reported.hitAt5, reported.falseRecall.rate, reported.promptSize.meanChars, reported.promptSize.meanTokens]) {
        expect(Number.isFinite(x)).toBe(true)
        expect(round4(x)).toBe(x)
      }

      // eslint-disable-next-line no-console
      console.log(line)
    })
  })
})
