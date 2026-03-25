/**
 * Personalized PageRank (PPR) for query-relative node ranking.
 *
 * Unlike global PageRank where popular nodes always win, PPR starts from
 * query-relevant seed nodes and propagates importance through the graph.
 * The same graph yields completely different rankings per query.
 * Computes in ~5ms for thousands of nodes.
 */

export interface PPRConfig {
  /** Damping factor — probability of following an edge vs teleporting back to seed (default: 0.85) */
  damping?: number
  /** Max iterations (default: 20) */
  maxIterations?: number
  /** Convergence threshold (default: 1e-6) */
  epsilon?: number
}

export interface PPRResult {
  /** Node key -> PPR score (higher = more important relative to seeds) */
  scores: Map<string, number>
  /** Number of iterations until convergence */
  iterations: number
  /** Whether convergence was reached before maxIterations */
  converged: boolean
}

const DEFAULT_DAMPING = 0.85
const DEFAULT_MAX_ITERATIONS = 20
const DEFAULT_EPSILON = 1e-6

/**
 * Normalize seed weights so they sum to 1.0.
 * Returns a new map; never mutates the input.
 */
function normalizeSeeds(seeds: Map<string, number>): Map<string, number> {
  let total = 0
  for (const w of seeds.values()) total += w
  if (total === 0) return new Map(seeds)
  const normalized = new Map<string, number>()
  for (const [k, w] of seeds) {
    normalized.set(k, w / total)
  }
  return normalized
}

/**
 * Build an inverted adjacency: for each node, collect all nodes that point TO it.
 * Also collects the full set of nodes present in the graph.
 */
function buildInbound(
  adjacency: Map<string, string[]>,
): { inbound: Map<string, string[]>; allNodes: Set<string> } {
  const inbound = new Map<string, string[]>()
  const allNodes = new Set<string>()

  for (const [src, neighbors] of adjacency) {
    allNodes.add(src)
    for (const dst of neighbors) {
      allNodes.add(dst)
      let list = inbound.get(dst)
      if (!list) {
        list = []
        inbound.set(dst, list)
      }
      list.push(src)
    }
  }
  return { inbound, allNodes }
}

/**
 * Compute Personalized PageRank starting from seed nodes.
 *
 * @param seeds Map of seed node keys to initial weights (should sum to 1.0)
 * @param adjacency Map of node key -> array of neighbor keys (directed edges)
 * @param config PPR parameters
 * @returns PPR scores for all reachable nodes
 */
export function computePPR(
  seeds: Map<string, number>,
  adjacency: Map<string, string[]>,
  config?: PPRConfig,
): PPRResult {
  if (seeds.size === 0) {
    return { scores: new Map(), iterations: 0, converged: true }
  }

  const damping = config?.damping ?? DEFAULT_DAMPING
  const maxIterations = config?.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const epsilon = config?.epsilon ?? DEFAULT_EPSILON

  const seedNorm = normalizeSeeds(seeds)
  const { inbound, allNodes } = buildInbound(adjacency)

  // Ensure seed nodes are in the node set
  for (const k of seedNorm.keys()) allNodes.add(k)

  // Pre-compute out-degree for each node
  const outDegree = new Map<string, number>()
  for (const node of allNodes) {
    outDegree.set(node, (adjacency.get(node) ?? []).length)
  }

  // Initialize scores from seeds
  let scores = new Map<string, number>()
  for (const node of allNodes) {
    scores.set(node, seedNorm.get(node) ?? 0)
  }

  let converged = false
  let iterations = 0

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1
    const newScores = new Map<string, number>()
    let diff = 0

    for (const node of allNodes) {
      const teleport = (1 - damping) * (seedNorm.get(node) ?? 0)

      let propagation = 0
      const inboundList = inbound.get(node)
      if (inboundList) {
        for (const neighbor of inboundList) {
          const deg = outDegree.get(neighbor) ?? 0
          if (deg > 0) {
            propagation += (scores.get(neighbor) ?? 0) / deg
          }
        }
      }

      const score = teleport + damping * propagation
      newScores.set(node, score)
      diff += Math.abs(score - (scores.get(node) ?? 0))
    }

    scores = newScores

    if (diff < epsilon) {
      converged = true
      break
    }
  }

  // Filter out zero-score nodes for a cleaner result
  const result = new Map<string, number>()
  for (const [node, score] of scores) {
    if (score > 0) result.set(node, score)
  }

  return { scores: result, iterations, converged }
}

/**
 * Extract named entities from text.
 * Detects: `backtick-enclosed`, PascalCase identifiers, and "quoted strings".
 * (Mirrors the extraction logic in graph-search.ts)
 */
function extractEntities(text: string): Set<string> {
  const entities = new Set<string>()

  // Backtick-enclosed identifiers
  const backtickMatches = text.matchAll(/`([^`]+)`/g)
  for (const m of backtickMatches) {
    if (m[1] !== undefined) entities.add(m[1].toLowerCase())
  }

  // PascalCase words (at least two uppercase-started segments)
  const pascalMatches = text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)
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
 * Convenience: compute PPR from a query by using entity extraction to find seed nodes.
 * 1. Extract entities from query
 * 2. Look up which graph nodes these entities correspond to
 * 3. Set equal seed weights
 * 4. Run PPR
 *
 * @param query Search query text
 * @param entityIndex Map of entity name -> set of memory keys
 * @param adjacency Graph adjacency (memory key -> neighbor keys)
 * @param config PPR parameters
 */
export function queryPPR(
  query: string,
  entityIndex: Map<string, Set<string>>,
  adjacency: Map<string, string[]>,
  config?: PPRConfig,
): PPRResult {
  const queryEntities = extractEntities(query)
  if (queryEntities.size === 0) {
    return { scores: new Map(), iterations: 0, converged: true }
  }

  // Collect all memory keys that match any extracted entity
  const seedKeys = new Set<string>()
  for (const entity of queryEntities) {
    const keys = entityIndex.get(entity)
    if (keys) {
      for (const k of keys) seedKeys.add(k)
    }
  }

  if (seedKeys.size === 0) {
    return { scores: new Map(), iterations: 0, converged: true }
  }

  // Equal weight for all seed nodes
  const weight = 1 / seedKeys.size
  const seeds = new Map<string, number>()
  for (const k of seedKeys) {
    seeds.set(k, weight)
  }

  return computePPR(seeds, adjacency, config)
}
