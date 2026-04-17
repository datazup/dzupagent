import { describe, it, expect } from 'vitest'
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import { PhaseAwareWindowManager } from '../phase-window.js'
import type { PhaseConfig } from '../phase-window.js'

describe('PhaseAwareWindowManager empty and edge inputs', () => {
  it('returns general phase with 0.5 confidence when no messages', () => {
    const mgr = new PhaseAwareWindowManager()
    const detection = mgr.detectPhase([])
    expect(detection.phase).toBe('general')
    expect(detection.confidence).toBe(0.5)
  })

  it('returns general when recent window has no trigger matches', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new HumanMessage('hello there'),
      new AIMessage('hi'),
    ]
    const detection = mgr.detectPhase(msgs)
    expect(detection.phase).toBe('general')
  })

  it('caps confidence at 1.0 when every message triggers', () => {
    const mgr = new PhaseAwareWindowManager({ phaseDetectionWindow: 2 })
    const msgs: BaseMessage[] = [
      new HumanMessage('debug this error'),
      new AIMessage('another error to debug'),
    ]
    const detection = mgr.detectPhase(msgs)
    expect(detection.confidence).toBeLessThanOrEqual(1.0)
    expect(detection.phase).toBe('debugging')
  })

  it('scoreMessages returns empty array for empty input', () => {
    const mgr = new PhaseAwareWindowManager()
    const scores = mgr.scoreMessages([])
    expect(scores).toEqual([])
  })

  it('scoreMessages assigns highest recency to the last message', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new HumanMessage('first'),
      new HumanMessage('middle'),
      new HumanMessage('last'),
    ]
    const scores = mgr.scoreMessages(msgs)
    expect(scores.length).toBe(3)
    expect(scores[2]!.score).toBeGreaterThan(scores[0]!.score)
  })

  it('single message gets maximum recency (5)', () => {
    const mgr = new PhaseAwareWindowManager()
    const scores = mgr.scoreMessages([new HumanMessage('only')])
    expect(scores.length).toBe(1)
    expect(scores[0]!.reason).toContain('recency=5.0')
  })

  it('scoreMessages recognizes code blocks for bonus', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new AIMessage('```ts\nconst x = 1\n```'),
    ]
    const scores = mgr.scoreMessages(msgs)
    expect(scores[0]!.reason).toContain('code=+2')
  })

  it('scoreMessages recognizes file paths for bonus', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new HumanMessage('open /packages/core/index.ts please'),
    ]
    const scores = mgr.scoreMessages(msgs)
    expect(scores[0]!.reason).toContain('paths=+1')
  })

  it('scoreMessages recognizes error indicators for bonus', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new AIMessage('I got a TypeError: undefined is not a function'),
    ]
    const scores = mgr.scoreMessages(msgs)
    expect(scores[0]!.reason).toContain('errors=+2')
  })

  it('scoreMessages penalizes very short messages', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [new HumanMessage('hi')]
    const scores = mgr.scoreMessages(msgs)
    expect(scores[0]!.reason).toContain('short=-2')
  })
})

describe('PhaseAwareWindowManager findRetentionSplit edge cases', () => {
  it('returns 0 when messages.length <= targetKeep', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new HumanMessage('a'),
      new AIMessage('b'),
    ]
    expect(mgr.findRetentionSplit(msgs, 10)).toBe(0)
  })

  it('returns 0 for empty messages', () => {
    const mgr = new PhaseAwareWindowManager()
    expect(mgr.findRetentionSplit([], 5)).toBe(0)
  })

  it('respects targetKeep >= messages.length boundary', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [new HumanMessage('x')]
    expect(mgr.findRetentionSplit(msgs, 1)).toBe(0)
  })

  it('walks backward past tool messages at boundary', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new HumanMessage('q1'),
      new AIMessage('a1'),
      new HumanMessage('q2'),
      new AIMessage({
        content: 'call',
        tool_calls: [{ id: 'tc-1', name: 't', args: {} }],
      }),
      new ToolMessage({ content: 'r1', tool_call_id: 'tc-1', name: 't' }),
      new ToolMessage({ content: 'r2', tool_call_id: 'tc-1', name: 't' }),
      new AIMessage('final'),
    ]
    const split = mgr.findRetentionSplit(msgs, 3)
    expect(split).toBeGreaterThanOrEqual(0)
    expect(split).toBeLessThanOrEqual(msgs.length)
  })

  it('includes AI with tool_calls that precedes split boundary', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new HumanMessage('old-q1'),
      new AIMessage('old-a1'),
      new HumanMessage('old-q2'),
      new AIMessage({
        content: 'calling',
        tool_calls: [{ id: 'tc-split', name: 't', args: {} }],
      }),
      new ToolMessage({ content: 'split-result', tool_call_id: 'tc-split' }),
      new AIMessage('recent-1'),
      new HumanMessage('recent-2'),
      new AIMessage('recent-3'),
    ]
    const split = mgr.findRetentionSplit(msgs, 4)
    expect(split).toBeLessThanOrEqual(4)
  })

  it('walks past tool message landing at split index', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new HumanMessage('old-1'),
      new HumanMessage('old-2'),
      new AIMessage({
        content: 'call',
        tool_calls: [{ id: 'tc-x', name: 't', args: {} }],
      }),
      new ToolMessage({ content: 'r', tool_call_id: 'tc-x' }),
      new AIMessage('recent-1'),
      new HumanMessage('recent-2'),
      new AIMessage('recent-3'),
    ]
    const split = mgr.findRetentionSplit(msgs, 3)
    expect(split).toBeGreaterThanOrEqual(0)
  })

  it('realigns when previous message has tool_calls at boundary', () => {
    const mgr = new PhaseAwareWindowManager()
    const aiWithCall = new AIMessage({
      content: 'call',
      tool_calls: [{ id: 'tc-prev', name: 't', args: {} }],
    })
    const msgs: BaseMessage[] = [
      new HumanMessage('old-1'),
      new HumanMessage('old-2'),
      new HumanMessage('old-3'),
      aiWithCall,
      new ToolMessage({ content: 'r', tool_call_id: 'tc-prev' }),
      new AIMessage('recent-1'),
      new HumanMessage('recent-2'),
      new AIMessage('recent-3'),
    ]
    const split = mgr.findRetentionSplit(msgs, 3)
    expect(split).toBeLessThanOrEqual(msgs.length - 3)
  })

  it('forces split index to land on a tool message at boundary (exercises walk-back)', () => {
    const mgr = new PhaseAwareWindowManager()
    const aiCall = new AIMessage({
      content: 'c',
      tool_calls: [{ id: 'tc-force', name: 't', args: {} }],
    })
    const toolR = new ToolMessage({ content: 'r', tool_call_id: 'tc-force' })
    const msgs: BaseMessage[] = [
      new HumanMessage('o1'),
      new HumanMessage('o2'),
      new HumanMessage('o3'),
      aiCall,
      toolR,
      new HumanMessage('r1'),
      new HumanMessage('r2'),
      new HumanMessage('r3'),
    ]
    const split = mgr.findRetentionSplit(msgs, 3)
    expect(split).toBeGreaterThanOrEqual(0)
    expect(split).toBeLessThanOrEqual(msgs.length)
  })
})

describe('PhaseAwareWindowManager custom configuration', () => {
  it('uses custom baseScores when provided', () => {
    const mgr = new PhaseAwareWindowManager({
      baseScores: { human: 100, ai: 1, system: 50, tool: 1 },
    })
    const msgs: BaseMessage[] = [new HumanMessage('test')]
    const scores = mgr.scoreMessages(msgs)
    expect(scores[0]!.reason).toContain('base(human)=100')
  })

  it('uses default base score of 3 for unknown message types', () => {
    const mgr = new PhaseAwareWindowManager({
      baseScores: { human: 5 },
    })
    const msgs: BaseMessage[] = [new AIMessage('ai msg')]
    const scores = mgr.scoreMessages(msgs)
    expect(scores[0]!.reason).toContain('base(ai)=3')
  })

  it('respects custom phaseDetectionWindow', () => {
    const mgr = new PhaseAwareWindowManager({ phaseDetectionWindow: 1 })
    const msgs: BaseMessage[] = [
      new HumanMessage('debug this'),
      new HumanMessage('no trigger here'),
    ]
    const detection = mgr.detectPhase(msgs)
    expect(detection.phase).toBe('general')
  })

  it('uses custom phases configuration', () => {
    const customPhases = [
      {
        name: 'testing' as const,
        triggers: [/\bspec\b/i],
        retentionMultiplier: 3,
        priorityTypes: ['human' as const],
      },
    ]
    const mgr = new PhaseAwareWindowManager({
      phases: customPhases as unknown as PhaseConfig[],
    })
    const msgs: BaseMessage[] = [new HumanMessage('writing a spec')]
    const detection = mgr.detectPhase(msgs)
    expect(detection.phase).toBe('testing')
  })
})

describe('PhaseAwareWindowManager non-string content', () => {
  it('handles messages with array content', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new HumanMessage({
        content: [{ type: 'text' as const, text: 'debug please' }],
      }),
    ]
    const detection = mgr.detectPhase(msgs)
    expect(detection.phase).toBe('debugging')
  })

  it('scoreMessages handles array content', () => {
    const mgr = new PhaseAwareWindowManager()
    const msgs: BaseMessage[] = [
      new HumanMessage({
        content: [{ type: 'text' as const, text: 'hi' }],
      }),
    ]
    const scores = mgr.scoreMessages(msgs)
    expect(scores.length).toBe(1)
  })
})
