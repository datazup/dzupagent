/**
 * Community detection via label propagation on the entity graph,
 * with optional LLM-generated summaries per community.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryCommunity {
  /** Unique community identifier */
  id: string
  /** Memory keys belonging to this community */
  memberKeys: string[]
  /** LLM-generated summary of all members */
  summary: string
  /** Most representative entities in this community */
  centroidEntities: string[]
  /** When community was last updated */
  updatedAt: number
}

export interface CommunityDetectorConfig {
  /** Minimum community size to keep (default: 2) */
  minCommunitySize?: number | undefined
  /** Max iterations for label propagation (default: 10) */
  maxIterations?: number | undefined
  /** Max communities to generate summaries for (default: 20) */
  maxCommunities?: number | undefined
}

export interface CommunityDetectionResult {
  communities: MemoryCommunity[]
  /** Total nodes processed */
  nodesProcessed: number
  /** Nodes that didn't join any community */
  isolatedNodes: number
  /** Number of LLM calls used for summaries */
  llmCallsUsed: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fisher-Yates shuffle (in-place on a copy).
 */
function shuffle<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

/**
 * Extract named entities from text.
 * Detects: `backtick-enclosed`, PascalCase identifiers, and "quoted strings".
 * (Mirrors the logic in graph-search.ts.)
 */
function extractEntities(text: string): Set<string> {
  const entities = new Set<string>()

  // Backtick-enclosed identifiers
  const backtickMatches = text.matchAll(/`([^`]+)`/g)
  for (const m of backtickMatches) {
    if (m[1] !== undefined) entities.add(m[1].toLowerCase())
  }

  // PascalCase words (at least two uppercase-led segments)
  // eslint-disable-next-line security/detect-unsafe-regex
  const pascalMatches = text.matchAll(/\b((?:[A-Z][a-z]{1,30}){2,10})\b/g)
  for (const m of pascalMatches) {
    if (m[1] !== undefined) entities.add(m[1].toLowerCase())
  }

  // Double-quoted strings (3+ chars)
  const quoteMatches = text.matchAll(/"([^"]{3,})"/g)
  for (const m of quoteMatches) {
    if (m[1] !== undefined) entities.add(m[1].toLowerCase())
  }

  return entities
}

/**
 * Get displayable text from a record value.
 */
function getRecordText(value: Record<string, unknown>): string {
  if (typeof value['text'] === 'string') return value['text']
  if (typeof value['content'] === 'string') return value['content']
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// CommunityDetector
// ---------------------------------------------------------------------------

export class CommunityDetector {
  constructor(private readonly config?: CommunityDetectorConfig) {}

  /**
   * Detect communities using label propagation algorithm.
   *
   * Algorithm:
   * 1. Assign each node its own label (= its key)
   * 2. For each iteration:
   *    a. For each node in random order:
   *       - Count labels among neighbours
   *       - Adopt the most frequent neighbour label
   * 3. Repeat until stable or maxIterations reached
   * 4. Group nodes by label
   * 5. Filter communities below minCommunitySize
   *
   * @param adjacency Map of node key -> neighbour keys (undirected)
   * @returns Map of community label -> member keys
   */
  detect(adjacency: Map<string, string[]>): Map<string, string[]> {
    // 1. Initialise labels: each node = its own label
    const labels = new Map<string, string>()
    for (const node of adjacency.keys()) {
      labels.set(node, node)
    }

    const maxIter = this.config?.maxIterations ?? 10

    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false
      const nodes = shuffle([...adjacency.keys()])

      for (const node of nodes) {
        const neighbors = adjacency.get(node) ?? []
        if (neighbors.length === 0) continue

        // Count neighbour labels
        const labelCounts = new Map<string, number>()
        for (const neighbor of neighbors) {
          const neighborLabel = labels.get(neighbor) ?? neighbor
          labelCounts.set(neighborLabel, (labelCounts.get(neighborLabel) ?? 0) + 1)
        }

        // Find most frequent label
        let bestLabel = labels.get(node)!
        let bestCount = 0
        for (const [label, count] of labelCounts) {
          if (count > bestCount) {
            bestCount = count
            bestLabel = label
          }
        }

        if (bestLabel !== labels.get(node)) {
          labels.set(node, bestLabel)
          changed = true
        }
      }

      if (!changed) break // Converged
    }

    // Group by label, filter small communities
    const minSize = this.config?.minCommunitySize ?? 2
    const groups = new Map<string, string[]>()
    for (const [node, label] of labels) {
      const group = groups.get(label) ?? []
      group.push(node)
      groups.set(label, group)
    }

    const result = new Map<string, string[]>()
    for (const [label, members] of groups) {
      if (members.length >= minSize) {
        result.set(label, members)
      }
    }
    return result
  }

  /**
   * Generate LLM summaries for detected communities.
   * Reads memory content, sends to LLM for summarisation.
   *
   * @param communities Output from detect()
   * @param records Map of memory key -> value (for reading content)
   * @param model LLM for summarisation (use cheap tier)
   * @returns MemoryCommunity objects with summaries
   */
  async summarize(
    communities: Map<string, string[]>,
    records: Map<string, Record<string, unknown>>,
    model: BaseChatModel,
  ): Promise<MemoryCommunity[]> {
    const maxCommunities = this.config?.maxCommunities ?? 20
    const entries = [...communities.entries()].slice(0, maxCommunities)
    const results: MemoryCommunity[] = []

    for (const [label, memberKeys] of entries) {
      // Collect member texts (first 200 chars each)
      const memberTexts: string[] = []
      const entityCounts = new Map<string, number>()

      for (const key of memberKeys) {
        const value = records.get(key)
        if (!value) continue
        const fullText = getRecordText(value)
        memberTexts.push(fullText.slice(0, 200))

        // Count entities across members for centroid calculation
        const entities = extractEntities(fullText)
        for (const ent of entities) {
          entityCounts.set(ent, (entityCounts.get(ent) ?? 0) + 1)
        }
      }

      // Centroid entities: appear in >50% of members
      const threshold = memberKeys.length / 2
      const centroidEntities = [...entityCounts.entries()]
        .filter(([, count]) => count > threshold)
        .sort((a, b) => b[1] - a[1])
        .map(([entity]) => entity)

      // Generate summary via LLM (non-fatal)
      let summary = ''
      try {
        const bulletList = memberTexts.map((t) => `- ${t}`).join('\n')
        const response = await model.invoke([
          new SystemMessage(
            'You are a concise summariser. Output ONLY a single paragraph summary, nothing else.',
          ),
          new HumanMessage(
            `Summarize this group of related memories into a single concise paragraph.\n` +
              `Focus on the shared theme or topic that connects them.\n\n` +
              `Memories:\n${bulletList}\n\nSummary:`,
          ),
        ])
        const text =
          typeof response.content === 'string'
            ? response.content
            : Array.isArray(response.content)
              ? response.content
                  .filter(
                    (b): b is { type: 'text'; text: string } =>
                      typeof b === 'object' && b !== null && 'type' in b && b.type === 'text',
                  )
                  .map((b) => b.text)
                  .join('')
              : ''
        summary = text.trim()
      } catch (_err: unknown) {
        // LLM failure is non-fatal; community still created without summary
        summary = ''
      }

      results.push({
        id: label,
        memberKeys,
        summary,
        centroidEntities,
        updatedAt: Date.now(),
      })
    }

    return results
  }

  /**
   * Full pipeline: detect communities and generate summaries.
   */
  async detectAndSummarize(
    adjacency: Map<string, string[]>,
    records: Map<string, Record<string, unknown>>,
    model: BaseChatModel,
  ): Promise<CommunityDetectionResult> {
    const nodesProcessed = adjacency.size
    const communities = this.detect(adjacency)

    // Count isolated nodes (those not in any community)
    const memberNodes = new Set<string>()
    for (const members of communities.values()) {
      for (const m of members) {
        memberNodes.add(m)
      }
    }
    const isolatedNodes = nodesProcessed - memberNodes.size

    const summarized = await this.summarize(communities, records, model)
    // Count LLM calls = number of communities that attempted summarisation
    const llmCallsUsed = summarized.length

    return {
      communities: summarized,
      nodesProcessed,
      isolatedNodes,
      llmCallsUsed,
    }
  }
}
