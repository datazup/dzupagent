/**
 * Multi-Network Memory — Hindsight-inspired 4-network architecture.
 *
 * Separates memories into purpose-specific networks (factual, experiential,
 * opinion, entity), each with its own retrieval weights and contradiction
 * handling policy. Composes with MemoryService — does not modify it.
 */
import type { MemoryService } from './memory-service.js'
import type { FormatOptions } from './memory-types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four memory networks */
export type MemoryNetwork = 'factual' | 'experiential' | 'opinion' | 'entity'

/** Configuration for a memory network */
export interface NetworkConfig {
  network: MemoryNetwork
  /** Namespace name in the MemoryService */
  namespace: string
  /** Default retrieval weights for this network */
  retrievalWeights: {
    vector: number
    fts: number
    graph: number
  }
  /** How to handle contradictions within this network */
  contradictionPolicy: 'latest-wins' | 'confidence-wins' | 'flag-for-review'
  /** Whether this network is searchable (semantic search) */
  searchable: boolean
}

/** A memory record with network metadata */
export interface NetworkMemoryRecord {
  key: string
  network: MemoryNetwork
  value: Record<string, unknown>
}

/** Search result from multi-network search */
export interface MultiNetworkSearchResult {
  key: string
  network: MemoryNetwork
  value: Record<string, unknown>
  /** Relevance score */
  score: number
}

/** Stats per network */
export interface NetworkStats {
  network: MemoryNetwork
  recordCount: number
  namespace: string
}

// ---------------------------------------------------------------------------
// Default configurations
// ---------------------------------------------------------------------------

export const DEFAULT_NETWORK_CONFIGS: NetworkConfig[] = [
  {
    network: 'factual',
    namespace: 'net-factual',
    retrievalWeights: { vector: 0.6, fts: 0.3, graph: 0.1 },
    contradictionPolicy: 'flag-for-review',
    searchable: true,
  },
  {
    network: 'experiential',
    namespace: 'net-experiential',
    retrievalWeights: { vector: 0.3, fts: 0.2, graph: 0.5 },
    contradictionPolicy: 'latest-wins',
    searchable: true,
  },
  {
    network: 'opinion',
    namespace: 'net-opinion',
    retrievalWeights: { vector: 0.5, fts: 0.3, graph: 0.2 },
    contradictionPolicy: 'confidence-wins',
    searchable: true,
  },
  {
    network: 'entity',
    namespace: 'net-entity',
    retrievalWeights: { vector: 0.2, fts: 0.4, graph: 0.4 },
    contradictionPolicy: 'latest-wins',
    searchable: true,
  },
]

// ---------------------------------------------------------------------------
// Constructor config
// ---------------------------------------------------------------------------

export interface MultiNetworkMemoryConfig {
  /** MemoryService instance (must have all network namespaces registered) */
  memoryService: MemoryService
  /** Scope for all operations */
  scope: Record<string, string>
  /** Network configurations (uses defaults if not provided) */
  networks?: NetworkConfig[] | undefined
}

// ---------------------------------------------------------------------------
// Classification patterns (compiled once)
// ---------------------------------------------------------------------------

const EXPERIENTIAL_PATTERNS: RegExp[] = [
  /\b(i tried|we found|we discovered|i noticed|i learned)\b/i,
  /\b(error|bug|crash|fail|broke|exception)\b/i,
  /\b(attempted|tested|debugged|fixed|resolved)\b/i,
  /\b(worked|didn't work|succeeded|failed)\b/i,
]

const OPINION_PATTERNS: RegExp[] = [
  /\b(prefer|better|worse|recommend|suggest|should|opinion)\b/i,
  /\b(like|dislike|love|hate|favorite)\b/i,
  /\b(confidence|believe|think|feel|seems)\b/i,
  /\b(pros?|cons?|trade-?off|advantage|disadvantage)\b/i,
]

const ENTITY_PATTERNS: RegExp[] = [
  /`[^`]+`/,
  // eslint-disable-next-line security/detect-unsafe-regex
  /\b(?:[A-Z][a-z]{1,30}){2,10}\b/,
  /\b(project|user|team|service|component|module)\s*:/i,
  /\b(stack|status|version|type)\s*[:=]/i,
]

// ---------------------------------------------------------------------------
// Network labels for prompt formatting
// ---------------------------------------------------------------------------

const NETWORK_LABELS: Record<MemoryNetwork, string> = {
  factual: 'Factual Memory',
  experiential: 'Experiential Memory',
  opinion: 'Opinions & Preferences',
  entity: 'Entity Profiles',
}

// ---------------------------------------------------------------------------
// MultiNetworkMemory
// ---------------------------------------------------------------------------

export class MultiNetworkMemory {
  private readonly networks: Map<MemoryNetwork, NetworkConfig>
  private readonly memoryService: MemoryService
  private readonly scope: Record<string, string>

  constructor(config: MultiNetworkMemoryConfig) {
    this.memoryService = config.memoryService
    this.scope = config.scope
    const cfgs = config.networks ?? DEFAULT_NETWORK_CONFIGS
    this.networks = new Map(cfgs.map(c => [c.network, c]))
  }

  // ---- Write --------------------------------------------------------------

  /**
   * Store a memory in a specific network.
   * Automatically adds _network metadata to the record.
   */
  async put(
    network: MemoryNetwork,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const config = this.networks.get(network)
    if (!config) throw new Error(`Unknown network: ${network}`)
    const enriched: Record<string, unknown> = { ...value, _network: network }
    await this.memoryService.put(config.namespace, this.scope, key, enriched)
  }

  // ---- Read ---------------------------------------------------------------

  /**
   * Get records from a specific network.
   */
  async get(
    network: MemoryNetwork,
    key?: string,
  ): Promise<Record<string, unknown>[]> {
    const config = this.networks.get(network)
    if (!config) throw new Error(`Unknown network: ${network}`)
    return this.memoryService.get(config.namespace, this.scope, key)
  }

  // ---- Search -------------------------------------------------------------

  /**
   * Search a specific network.
   */
  async search(
    network: MemoryNetwork,
    query: string,
    limit = 10,
  ): Promise<Record<string, unknown>[]> {
    const config = this.networks.get(network)
    if (!config) throw new Error(`Unknown network: ${network}`)
    return this.memoryService.search(config.namespace, this.scope, query, limit)
  }

  /**
   * Search across ALL networks simultaneously.
   * Merges results using network-specific retrieval weights.
   * Returns results tagged with their source network.
   */
  async searchAll(
    query: string,
    limit = 10,
  ): Promise<MultiNetworkSearchResult[]> {
    const allResults: MultiNetworkSearchResult[] = []

    for (const [network, config] of this.networks) {
      try {
        const results = await this.memoryService.search(
          config.namespace,
          this.scope,
          query,
          limit,
        )
        const w = config.retrievalWeights
        const weightSum = (w.vector + w.fts + w.graph) / 3
        for (let i = 0; i < results.length; i++) {
          const rec = results[i]!
          allResults.push({
            key:
              typeof rec['key'] === 'string'
                ? (rec['key'] as string)
                : `${network}-${i}`,
            network,
            value: rec,
            score: (1 / (i + 1)) * weightSum,
          })
        }
      } catch {
        // Non-fatal: skip this network on failure
      }
    }

    allResults.sort((a, b) => b.score - a.score)
    return allResults.slice(0, limit)
  }

  // ---- Classification -----------------------------------------------------

  /**
   * Classify which network a piece of content belongs to.
   * Uses heuristic pattern matching:
   * - Factual: objective statements, technical facts, documentation references
   * - Experiential: "I tried", "we found", error reports, action history
   * - Opinion: "prefer", "better", "should", confidence language
   * - Entity: names, identifiers, profile-like descriptions
   */
  classifyNetwork(text: string): MemoryNetwork {
    const experientialScore = EXPERIENTIAL_PATTERNS.filter(p => p.test(text)).length
    const opinionScore = OPINION_PATTERNS.filter(p => p.test(text)).length
    const entityScore = ENTITY_PATTERNS.filter(p => p.test(text)).length

    const scores: Array<[MemoryNetwork, number]> = [
      ['experiential', experientialScore],
      ['opinion', opinionScore],
      ['entity', entityScore],
    ]

    const best = scores.reduce((a, b) => (b[1] > a[1] ? b : a))
    if (best[1] >= 2) return best[0]

    // Default: factual
    return 'factual'
  }

  // ---- Auto-store ---------------------------------------------------------

  /**
   * Auto-store: classify the content and store in the appropriate network.
   */
  async autoStore(
    key: string,
    value: Record<string, unknown>,
  ): Promise<{ network: MemoryNetwork }> {
    const text =
      typeof value['text'] === 'string'
        ? (value['text'] as string)
        : JSON.stringify(value)
    const network = this.classifyNetwork(text)
    await this.put(network, key, value)
    return { network }
  }

  // ---- Stats --------------------------------------------------------------

  /**
   * Get stats for all networks.
   */
  async getStats(): Promise<NetworkStats[]> {
    const stats: NetworkStats[] = []
    for (const [network, config] of this.networks) {
      try {
        const records = await this.memoryService.get(config.namespace, this.scope)
        stats.push({ network, recordCount: records.length, namespace: config.namespace })
      } catch {
        stats.push({ network, recordCount: 0, namespace: config.namespace })
      }
    }
    return stats
  }

  // ---- Prompt formatting --------------------------------------------------

  /**
   * Format memories from all networks for prompt injection.
   * Groups by network with headers.
   */
  async formatForPrompt(
    query: string,
    options?: FormatOptions & { maxPerNetwork?: number },
  ): Promise<string> {
    const maxPerNetwork = options?.maxPerNetwork ?? 5
    const maxChars = options?.maxCharsPerItem ?? 2000
    const sections: string[] = []

    for (const [network, config] of this.networks) {
      try {
        const results = await this.memoryService.search(
          config.namespace,
          this.scope,
          query,
          maxPerNetwork,
        )
        if (results.length === 0) continue

        const items = results.map(r => {
          const text =
            typeof r['text'] === 'string'
              ? (r['text'] as string)
              : JSON.stringify(r)
          return text.length > maxChars ? text.slice(0, maxChars) + '...' : text
        })

        sections.push(`## ${NETWORK_LABELS[network]}\n${items.map(i => `- ${i}`).join('\n')}`)
      } catch {
        // Non-fatal: skip network
      }
    }

    if (sections.length === 0) return ''
    const header = options?.header ?? '# Multi-Network Memory'
    return `${header}\n\n${sections.join('\n\n')}`
  }

  // ---- Config accessors ---------------------------------------------------

  /** Get the configuration for a specific network */
  getNetworkConfig(network: MemoryNetwork): NetworkConfig | undefined {
    return this.networks.get(network)
  }

  /** Get all network configurations */
  getNetworks(): NetworkConfig[] {
    return [...this.networks.values()]
  }

  // ---- Static helpers -----------------------------------------------------

  /**
   * Get the NamespaceConfig objects needed to register all networks
   * with a MemoryService. Helper for setup.
   */
  static getNamespaceConfigs(
    networks?: NetworkConfig[],
    scopeKeys?: string[],
  ): Array<{ name: string; scopeKeys: string[]; searchable: boolean }> {
    const cfgs = networks ?? DEFAULT_NETWORK_CONFIGS
    const keys = scopeKeys ?? ['tenantId', 'network']
    return cfgs.map(c => ({
      name: c.namespace,
      scopeKeys: keys,
      searchable: c.searchable,
    }))
  }
}
