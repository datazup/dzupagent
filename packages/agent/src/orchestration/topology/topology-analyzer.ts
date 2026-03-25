/**
 * TopologyAnalyzer — recommends the best agent communication topology
 * based on task characteristics using scoring heuristics.
 */
import type {
  TaskCharacteristics,
  TopologyRecommendation,
  TopologyType,
} from './topology-types.js'

interface ScoredTopology {
  topology: TopologyType
  score: number
  reason: string
}

export class TopologyAnalyzer {
  /**
   * Analyze task characteristics and recommend the best topology.
   *
   * Each topology is scored 0-1 based on weighted characteristics.
   * The highest-scoring topology is recommended. Confidence is the
   * gap between the top and second-best scores.
   */
  analyze(characteristics: TaskCharacteristics): TopologyRecommendation {
    const scored = this.scoreAll(characteristics)

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score)

    const best = scored[0]!
    const secondBest = scored[1]!

    const confidence = Math.min(1, Math.max(0, best.score - secondBest.score))

    return {
      recommended: best.topology,
      confidence,
      reason: best.reason,
      alternatives: scored.slice(1).map(s => ({
        topology: s.topology,
        score: s.score,
        reason: s.reason,
      })),
    }
  }

  private scoreAll(c: TaskCharacteristics): ScoredTopology[] {
    return [
      this.scoreHierarchical(c),
      this.scorePipeline(c),
      this.scoreStar(c),
      this.scoreMesh(c),
      this.scoreRing(c),
    ]
  }

  private scoreHierarchical(c: TaskCharacteristics): ScoredTopology {
    const subtaskBonus = c.subtaskCount > 3 ? 0.3 : 0.1
    const score =
      c.coordinationComplexity * 0.4 +
      subtaskBonus +
      (1 - c.speedPriority) * 0.3

    return {
      topology: 'hierarchical',
      score,
      reason: 'High coordination complexity and many subtasks benefit from a central coordinator.',
    }
  }

  private scorePipeline(c: TaskCharacteristics): ScoredTopology {
    const score =
      c.sequentialNature * 0.5 +
      (1 - c.interdependence) * 0.3 +
      (1 - c.iterativeRefinement) * 0.2

    return {
      topology: 'pipeline',
      score,
      reason: 'Sequential task nature with low interdependence suits a linear pipeline.',
    }
  }

  private scoreStar(c: TaskCharacteristics): ScoredTopology {
    const score =
      c.speedPriority * 0.4 +
      (1 - c.interdependence) * 0.4 +
      (1 - c.coordinationComplexity) * 0.2

    return {
      topology: 'star',
      score,
      reason: 'High speed priority with independent subtasks favors parallel star execution.',
    }
  }

  private scoreMesh(c: TaskCharacteristics): ScoredTopology {
    const subtaskBonus = c.subtaskCount <= 5 ? 0.2 : 0.0
    const score =
      c.interdependence * 0.5 +
      c.coordinationComplexity * 0.3 +
      subtaskBonus

    return {
      topology: 'mesh',
      score,
      reason: 'Highly interdependent subtasks benefit from all-to-all communication.',
    }
  }

  private scoreRing(c: TaskCharacteristics): ScoredTopology {
    const subtaskBonus = c.subtaskCount <= 4 ? 0.2 : 0.1
    const score =
      c.iterativeRefinement * 0.5 +
      (1 - c.speedPriority) * 0.3 +
      subtaskBonus

    return {
      topology: 'ring',
      score,
      reason: 'Iterative refinement needs suit circular pass topology.',
    }
  }
}
