import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  VerificationProtocol,
  jaccardSimilarity,
} from '../self-correction/verification-protocol.js'

// ---------------------------------------------------------------------------
// Mock model helper (same pattern as reflection-loop.test.ts)
// ---------------------------------------------------------------------------

function createMockModel(responses: string[]): BaseChatModel {
  let callIndex = 0
  return {
    invoke: vi.fn(async () => {
      const content = responses[callIndex] ?? 'fallback response'
      if (callIndex < responses.length) callIndex++
      return new AIMessage({ content })
    }),
  } as unknown as BaseChatModel
}

// ---------------------------------------------------------------------------
// jaccardSimilarity
// ---------------------------------------------------------------------------

describe('jaccardSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1)
  })

  it('returns 0 for completely different strings', () => {
    expect(jaccardSimilarity('alpha beta', 'gamma delta')).toBe(0)
  })

  it('returns a value between 0 and 1 for partial overlap', () => {
    const sim = jaccardSimilarity('the quick brown fox', 'the slow brown dog')
    expect(sim).toBeGreaterThan(0)
    expect(sim).toBeLessThan(1)
    // Overlap: {the, brown} = 2, Union: {the, quick, brown, fox, slow, dog} = 6
    expect(sim).toBeCloseTo(2 / 6, 2)
  })

  it('returns 1 for two empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(1)
  })

  it('is case-insensitive', () => {
    expect(jaccardSimilarity('Hello World', 'hello world')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// selectStrategy
// ---------------------------------------------------------------------------

describe('VerificationProtocol.selectStrategy', () => {
  it('maps critical to consensus', () => {
    expect(VerificationProtocol.selectStrategy('critical')).toBe('consensus')
  })

  it('maps sensitive to debate', () => {
    expect(VerificationProtocol.selectStrategy('sensitive')).toBe('debate')
  })

  it('maps standard to vote', () => {
    expect(VerificationProtocol.selectStrategy('standard')).toBe('vote')
  })

  it('maps cosmetic to single', () => {
    expect(VerificationProtocol.selectStrategy('cosmetic')).toBe('single')
  })
})

// ---------------------------------------------------------------------------
// vote()
// ---------------------------------------------------------------------------

describe('VerificationProtocol.vote', () => {
  it('picks the majority proposal when agents agree', async () => {
    const agents = [
      createMockModel(['The answer is 42']),
      createMockModel(['The answer is 42']),
      createMockModel(['The answer is completely different and unrelated']),
    ]

    const protocol = new VerificationProtocol({ similarityThreshold: 0.7 })
    const result = await protocol.vote(agents, 'What is the answer?')

    expect(result.strategy).toBe('vote')
    expect(result.proposals).toHaveLength(3)
    // Two identical proposals form a cluster, agreement = 2/3
    expect(result.agreement).toBeCloseTo(2 / 3, 2)
    expect(result.result).toBe('The answer is 42')
    expect(result.rounds).toBe(1)
    expect(result.converged).toBe(true) // 2/3 > default minAgreement 0.5
  })

  it('returns low agreement when all agents disagree', async () => {
    const agents = [
      createMockModel(['apples oranges bananas']),
      createMockModel(['cars trucks motorcycles']),
      createMockModel(['planets stars galaxies']),
    ]

    const protocol = new VerificationProtocol({
      similarityThreshold: 0.7,
      minAgreement: 0.6,
    })
    const result = await protocol.vote(agents, 'Name some things')

    expect(result.strategy).toBe('vote')
    expect(result.proposals).toHaveLength(3)
    // Each proposal is its own cluster, agreement = 1/3
    expect(result.agreement).toBeCloseTo(1 / 3, 2)
    expect(result.converged).toBe(false) // 1/3 < 0.6
  })

  it('handles empty agents array', async () => {
    const protocol = new VerificationProtocol()
    const result = await protocol.vote([], 'task')

    expect(result.result).toBe('')
    expect(result.proposals).toHaveLength(0)
    expect(result.agreement).toBe(0)
  })

  it('handles a single agent', async () => {
    const agents = [createMockModel(['only answer'])]

    const protocol = new VerificationProtocol()
    const result = await protocol.vote(agents, 'task')

    expect(result.result).toBe('only answer')
    expect(result.agreement).toBe(1)
    expect(result.converged).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// consensus()
// ---------------------------------------------------------------------------

describe('VerificationProtocol.consensus', () => {
  it('converges when all agents produce similar output', async () => {
    // All agents produce similar text -> converges in round 1
    const agents = [
      createMockModel(['The answer is forty-two']),
      createMockModel(['The answer is forty-two']),
    ]
    const judge = createMockModel(['The answer is forty-two synthesized'])

    const protocol = new VerificationProtocol({
      maxRounds: 3,
      similarityThreshold: 0.7,
    })
    const result = await protocol.consensus(agents, judge, 'What is the answer?')

    expect(result.strategy).toBe('consensus')
    expect(result.converged).toBe(true)
    expect(result.rounds).toBe(1)
    // Judge is called once for final synthesis
    expect(result.result).toBeTruthy()
  })

  it('iterates up to maxRounds when proposals diverge', async () => {
    // Agents always produce different text, never converge
    const agent1 = createMockModel([
      'proposal alpha initial',
      'proposal alpha refined',
      'proposal alpha final',
    ])
    const agent2 = createMockModel([
      'proposal beta initial',
      'proposal beta refined',
      'proposal beta final',
    ])
    const judge = createMockModel([
      'synthesis round 1',
      'synthesis round 2',
      'final synthesis',
    ])

    const protocol = new VerificationProtocol({
      maxRounds: 2,
      similarityThreshold: 0.9, // Very high threshold -> hard to converge
    })
    const result = await protocol.consensus([agent1, agent2], judge, 'Complex task')

    expect(result.strategy).toBe('consensus')
    expect(result.converged).toBe(false)
    expect(result.rounds).toBe(2)
    expect(result.result).toBeTruthy()
  })

  it('handles empty agents array', async () => {
    const judge = createMockModel(['synthesis'])
    const protocol = new VerificationProtocol()
    const result = await protocol.consensus([], judge, 'task')

    expect(result.result).toBe('')
    expect(result.proposals).toHaveLength(0)
    expect(result.converged).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// verify() auto-selects strategy
// ---------------------------------------------------------------------------

describe('VerificationProtocol.verify', () => {
  it('uses single strategy for cosmetic risk class', async () => {
    const agent = createMockModel(['cosmetic output'])
    const judge = createMockModel(['judge output'])

    const protocol = new VerificationProtocol()
    const result = await protocol.verify(
      [agent],
      judge,
      'Fix a typo',
      'cosmetic',
    )

    expect(result.strategy).toBe('single')
    expect(result.result).toBe('cosmetic output')
    expect(result.agreement).toBe(1)
    expect(result.converged).toBe(true)
    expect(result.proposals).toEqual(['cosmetic output'])
    // Judge should NOT be called for single strategy
    expect((judge.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('uses vote strategy for standard risk class', async () => {
    const agents = [
      createMockModel(['standard output A']),
      createMockModel(['standard output A']),
      createMockModel(['standard output A']),
    ]
    const judge = createMockModel(['judge output'])

    const protocol = new VerificationProtocol()
    const result = await protocol.verify(agents, judge, 'Standard task', 'standard')

    expect(result.strategy).toBe('vote')
    expect(result.rounds).toBe(1)
  })

  it('uses vote strategy for sensitive risk class (debate defers to orchestrator)', async () => {
    const agents = [
      createMockModel(['sensitive output']),
      createMockModel(['sensitive output']),
    ]
    const judge = createMockModel(['judge output'])

    const protocol = new VerificationProtocol()
    const result = await protocol.verify(agents, judge, 'Sensitive task', 'sensitive')

    expect(result.strategy).toBe('debate')
    // Internally uses vote since full debate is at orchestrator level
    expect(result.rounds).toBe(1)
  })

  it('uses consensus strategy for critical risk class', async () => {
    const agents = [
      createMockModel(['critical output same']),
      createMockModel(['critical output same']),
    ]
    const judge = createMockModel(['critical consensus synthesis'])

    const protocol = new VerificationProtocol({
      maxRounds: 2,
      similarityThreshold: 0.7,
    })
    const result = await protocol.verify(agents, judge, 'Critical task', 'critical')

    expect(result.strategy).toBe('consensus')
    expect(result.converged).toBe(true)
  })

  it('returns empty result for single strategy with no agents', async () => {
    const judge = createMockModel(['judge output'])

    const protocol = new VerificationProtocol()
    const result = await protocol.verify([], judge, 'task', 'cosmetic')

    expect(result.strategy).toBe('single')
    expect(result.result).toBe('')
    expect(result.agreement).toBe(1)
    expect(result.converged).toBe(true)
  })
})
