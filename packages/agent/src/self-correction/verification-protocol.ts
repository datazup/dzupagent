/**
 * VerificationProtocol --- multi-agent vote/consensus for critical outputs.
 *
 * Complements AgentOrchestrator.debate() by adding voting and consensus
 * protocols that can be auto-selected based on risk class. Critical outputs
 * use stronger verification (consensus) while cosmetic changes skip
 * multi-agent verification entirely.
 *
 * General-purpose --- works for any domain, not specific to code generation.
 *
 * @module self-correction/verification-protocol
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationStrategy = 'single' | 'vote' | 'debate' | 'consensus'

export interface VerificationResult {
  /** Final verified output. */
  result: string
  /** Verification strategy used. */
  strategy: VerificationStrategy
  /** Agreement level among agents (0-1, 1 = unanimous). */
  agreement: number
  /** Number of rounds/iterations used. */
  rounds: number
  /** All proposals generated (for audit). */
  proposals: string[]
  /** Whether consensus was reached (for consensus strategy). */
  converged: boolean
}

export interface VerificationConfig {
  /** Minimum agreement threshold for vote (0-1, default: 0.5). */
  minAgreement: number
  /** Max rounds for consensus (default: 3). */
  maxRounds: number
  /** Similarity threshold for clustering proposals (0-1, default: 0.7). */
  similarityThreshold: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONSENSUS_JUDGE_SYSTEM = `You are a synthesis judge. You will receive multiple proposals for the same task.
Synthesize them into a single, improved output that captures the best aspects of all proposals.
Output ONLY the synthesized result, no commentary.`

const CONSENSUS_REFINE_SYSTEM = `You are an expert assistant. A judge has synthesized multiple proposals into a unified version.
Review the synthesis and refine your original proposal to align with the consensus direction.
Output ONLY your refined proposal, no commentary.`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into a set of lowercase words.
 * Strips punctuation and splits on whitespace.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0),
  )
}

/**
 * Compute Jaccard similarity between two strings based on word overlap.
 * Returns a value in [0, 1].
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a)
  const setB = tokenize(b)

  if (setA.size === 0 && setB.size === 0) return 1.0

  let intersectionSize = 0
  for (const word of setA) {
    if (setB.has(word)) intersectionSize++
  }

  const unionSize = setA.size + setB.size - intersectionSize
  if (unionSize === 0) return 1.0

  return intersectionSize / unionSize
}

/**
 * Cluster proposals by Jaccard word-overlap similarity.
 * Returns an array of clusters (each cluster is an array of proposal indices).
 */
function clusterProposals(
  proposals: string[],
  threshold: number,
): number[][] {
  const clusters: number[][] = []

  for (let i = 0; i < proposals.length; i++) {
    let placed = false
    for (const cluster of clusters) {
      // Compare against the first element of the cluster (representative)
      const representative = proposals[cluster[0]!]!
      if (jaccardSimilarity(proposals[i]!, representative) >= threshold) {
        cluster.push(i)
        placed = true
        break
      }
    }
    if (!placed) {
      clusters.push([i])
    }
  }

  return clusters
}

/**
 * Extract text content from a model response.
 */
function extractContent(response: { content: string | unknown }): string {
  return typeof response.content === 'string'
    ? response.content
    : JSON.stringify(response.content)
}

// ---------------------------------------------------------------------------
// VerificationProtocol
// ---------------------------------------------------------------------------

export class VerificationProtocol {
  private readonly config: VerificationConfig

  constructor(config?: Partial<VerificationConfig>) {
    this.config = {
      minAgreement: config?.minAgreement ?? 0.5,
      maxRounds: config?.maxRounds ?? 3,
      similarityThreshold: config?.similarityThreshold ?? 0.7,
    }
  }

  /**
   * Select verification strategy based on risk class.
   *
   * - critical  -> consensus (strongest, iterative convergence)
   * - sensitive -> debate    (multi-round proposer/judge, handled by AgentOrchestrator)
   * - standard  -> vote      (majority vote)
   * - cosmetic  -> single    (no multi-agent verification)
   */
  static selectStrategy(
    riskClass: 'critical' | 'sensitive' | 'standard' | 'cosmetic',
  ): VerificationStrategy {
    switch (riskClass) {
      case 'critical':
        return 'consensus'
      case 'sensitive':
        return 'debate'
      case 'standard':
        return 'vote'
      case 'cosmetic':
        return 'single'
    }
  }

  /**
   * Majority vote: N agents generate in parallel, pick the most common
   * answer cluster using Jaccard word-overlap similarity.
   */
  async vote(
    agents: BaseChatModel[],
    task: string,
  ): Promise<VerificationResult> {
    if (agents.length === 0) {
      return {
        result: '',
        strategy: 'vote',
        agreement: 0,
        rounds: 0,
        proposals: [],
        converged: false,
      }
    }

    // All agents generate in parallel
    const responses = await Promise.all(
      agents.map(agent =>
        agent.invoke([new HumanMessage(task)]),
      ),
    )
    const proposals = responses.map(r => extractContent(r))

    // Cluster by similarity
    const clusters = clusterProposals(proposals, this.config.similarityThreshold)

    // Find the largest cluster
    let largestCluster = clusters[0]!
    for (const cluster of clusters) {
      if (cluster.length > largestCluster.length) {
        largestCluster = cluster
      }
    }

    const agreement = largestCluster.length / proposals.length

    // Pick the first proposal from the largest cluster as the result
    const resultIndex = largestCluster[0]!
    const result = proposals[resultIndex]!

    return {
      result,
      strategy: 'vote',
      agreement,
      rounds: 1,
      proposals,
      converged: agreement >= this.config.minAgreement,
    }
  }

  /**
   * Consensus: agents iteratively refine until convergence.
   *
   * 1. All agents generate initial proposals in parallel.
   * 2. Each round: judge synthesizes all proposals, then agents refine.
   * 3. If all proposals fall into a single cluster (converged) or
   *    maxRounds is reached, return the judge's final synthesis.
   */
  async consensus(
    agents: BaseChatModel[],
    judge: BaseChatModel,
    task: string,
  ): Promise<VerificationResult> {
    if (agents.length === 0) {
      return {
        result: '',
        strategy: 'consensus',
        agreement: 0,
        rounds: 0,
        proposals: [],
        converged: false,
      }
    }

    // Initial proposals
    const initialResponses = await Promise.all(
      agents.map(agent =>
        agent.invoke([new HumanMessage(task)]),
      ),
    )
    let proposals = initialResponses.map(r => extractContent(r))
    let converged = false
    let rounds = 0

    for (let round = 0; round < this.config.maxRounds; round++) {
      rounds++

      // Check convergence: all proposals in a single cluster
      const clusters = clusterProposals(proposals, this.config.similarityThreshold)
      if (clusters.length === 1) {
        converged = true
        break
      }

      // Judge synthesizes
      const proposalText = proposals
        .map((p, i) => `## Proposal ${i + 1}\n${p}`)
        .join('\n\n')

      const synthesis = await judge.invoke([
        new SystemMessage(CONSENSUS_JUDGE_SYSTEM),
        new HumanMessage(
          `Task: ${task}\n\n${proposalText}\n\nSynthesize a single improved output.`,
        ),
      ])
      const synthesisText = extractContent(synthesis)

      // If this is the last round, just return the synthesis
      if (round === this.config.maxRounds - 1) {
        proposals = [...proposals, synthesisText]
        break
      }

      // Agents refine based on the synthesis
      const refinedResponses = await Promise.all(
        agents.map(agent =>
          agent.invoke([
            new SystemMessage(CONSENSUS_REFINE_SYSTEM),
            new HumanMessage(
              `Original task: ${task}\n\nJudge synthesis:\n${synthesisText}\n\nProvide your refined proposal.`,
            ),
          ]),
        ),
      )
      proposals = refinedResponses.map(r => extractContent(r))
    }

    // Final synthesis by judge
    const finalProposalText = proposals
      .map((p, i) => `## Proposal ${i + 1}\n${p}`)
      .join('\n\n')

    const finalSynthesis = await judge.invoke([
      new SystemMessage(CONSENSUS_JUDGE_SYSTEM),
      new HumanMessage(
        `Task: ${task}\n\n${finalProposalText}\n\nProvide the final synthesized output.`,
      ),
    ])
    const finalResult = extractContent(finalSynthesis)

    // Compute agreement on the final set of proposals
    const finalClusters = clusterProposals(proposals, this.config.similarityThreshold)
    let largestCluster = finalClusters[0]!
    for (const cluster of finalClusters) {
      if (cluster.length > largestCluster.length) {
        largestCluster = cluster
      }
    }
    const agreement = largestCluster.length / proposals.length

    return {
      result: finalResult,
      strategy: 'consensus',
      agreement,
      rounds,
      proposals,
      converged,
    }
  }

  /**
   * Run verification with auto-selected strategy based on risk class.
   *
   * - cosmetic  -> single (first agent only)
   * - standard  -> vote
   * - sensitive -> vote (debate is handled at orchestrator level)
   * - critical  -> consensus
   */
  async verify(
    agents: BaseChatModel[],
    judge: BaseChatModel,
    task: string,
    riskClass: 'critical' | 'sensitive' | 'standard' | 'cosmetic',
  ): Promise<VerificationResult> {
    const strategy = VerificationProtocol.selectStrategy(riskClass)

    switch (strategy) {
      case 'single': {
        // Use only the first agent
        const agent = agents[0]
        if (!agent) {
          return {
            result: '',
            strategy: 'single',
            agreement: 1,
            rounds: 0,
            proposals: [],
            converged: true,
          }
        }
        const response = await agent.invoke([new HumanMessage(task)])
        const content = extractContent(response)
        return {
          result: content,
          strategy: 'single',
          agreement: 1,
          rounds: 1,
          proposals: [content],
          converged: true,
        }
      }

      case 'vote':
        return this.vote(agents, task)

      case 'debate': {
        // Debate strategy: use vote as the verification primitive here.
        // Full debate with multi-round proposer/judge is in AgentOrchestrator.debate().
        const debateResult = await this.vote(agents, task)
        return { ...debateResult, strategy: 'debate' }
      }

      case 'consensus':
        return this.consensus(agents, judge, task)
    }
  }
}
