import { promises as fs } from 'node:fs'
import {
  createBuiltinToolRegistry,
  type BuiltinToolOptions,
  type BuiltinToolRegistryBundle,
} from '../tools/builtin.js'
import type { TopicRecord } from '../tools/topics.js'

/**
 * Shape of a single topic entry in `topicLandscape.topics` produced by the
 * review knowledge index generator. Only the fields we care about are typed —
 * unknown fields are tolerated.
 */
interface KnowledgeIndexTopic {
  id?: unknown
  name?: unknown
  aliases?: unknown
  tokenSet?: unknown
  explicitTopics?: unknown
}

/**
 * Top-level shape of the review knowledge index JSON. The generator has
 * historically written the cluster-like section under one of several keys.
 * We look at all of them and take whichever is populated first.
 */
interface KnowledgeIndexFile {
  topicLandscape?: { topics?: unknown }
  topicClusters?: unknown
  featureClusters?: unknown
  clusters?: unknown
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) out.push(entry)
  }
  return out
}

function coerceTopicRecord(raw: unknown): TopicRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as KnowledgeIndexTopic
  const rawName = typeof obj.name === 'string' ? obj.name : ''
  const rawId = typeof obj.id === 'string' ? obj.id : ''
  const title = rawName.trim()
  const idSource = rawId.trim() !== '' ? rawId.trim() : slugify(title)
  if (idSource === '' || title === '') return null

  const aliases = asStringArray(obj.aliases)
  const tokenSet = asStringArray(obj.tokenSet)
  const explicit = asStringArray(obj.explicitTopics)

  // Tags: prefer explicit topic labels (human-meaningful), then fall back
  // to tokenSet, then aliases — deduped, lowercased.
  const tagPool = [...explicit, ...tokenSet, ...aliases]
  const tags = Array.from(
    new Set(tagPool.map((t) => t.toLowerCase()).filter((t) => t.length > 0)),
  )

  // Summary: first alias that differs from the title, else the joined tokenSet.
  const distinctAlias = aliases.find((a) => a.trim() !== title)
  const summary =
    distinctAlias ??
    (tokenSet.length > 0 ? tokenSet.join(' ') : undefined)

  const record: TopicRecord = { id: idSource, title }
  if (summary !== undefined) record.summary = summary
  if (tags.length > 0) record.tags = tags
  return record
}

function extractTopicArray(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== 'object') return []
  const file = parsed as KnowledgeIndexFile

  const landscape = file.topicLandscape
  if (landscape && typeof landscape === 'object') {
    const topics = (landscape as { topics?: unknown }).topics
    if (Array.isArray(topics)) return topics
  }

  if (Array.isArray(file.topicClusters)) return file.topicClusters
  if (Array.isArray(file.featureClusters)) return file.featureClusters
  if (Array.isArray(file.clusters)) return file.clusters

  return []
}

/**
 * Load topic records from a knowledge index JSON file produced by the
 * review knowledge indexer. Tolerant of missing files and malformed JSON —
 * returns an empty array rather than throwing so callers can use this as
 * an optional seed source.
 */
export async function loadTopicsFromKnowledgeIndex(
  indexPath: string,
): Promise<TopicRecord[]> {
  let raw: string
  try {
    raw = await fs.readFile(indexPath, 'utf8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  const candidates = extractTopicArray(parsed)
  const records: TopicRecord[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const record = coerceTopicRecord(candidate)
    if (record === null) continue
    if (seen.has(record.id)) continue
    seen.add(record.id)
    records.push(record)
  }
  return records
}

/**
 * Async variant of {@link createBuiltinToolRegistry} that seeds the
 * `topics.*` catalog from a knowledge index JSON file on disk.
 *
 * Explicitly-provided `opts.topics` take precedence on id collision so
 * callers can pin or override specific entries when needed.
 */
export async function createBuiltinToolRegistryFromIndex(
  opts: BuiltinToolOptions & { knowledgeIndexPath: string },
): Promise<BuiltinToolRegistryBundle> {
  const { knowledgeIndexPath, topics: explicitTopics, ...rest } = opts
  const fromIndex = await loadTopicsFromKnowledgeIndex(knowledgeIndexPath)

  // Merge: index first, explicit seeds override on id collision.
  const merged = new Map<string, TopicRecord>()
  for (const topic of fromIndex) merged.set(topic.id, topic)
  if (explicitTopics) {
    for (const topic of explicitTopics) merged.set(topic.id, topic)
  }

  return createBuiltinToolRegistry({
    ...rest,
    topics: merged.values(),
  })
}
