import { describe, it, expect, beforeEach } from 'vitest'
import {
  PhaseAwareWindowManager,
  DEFAULT_PHASES,
} from '../phase-window.js'
import type { PhaseWindowConfig, ConversationPhase } from '../phase-window.js'
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msgs(...contents: Array<{ role: 'human' | 'ai' | 'system' | 'tool'; text: string; toolCallId?: string }>): BaseMessage[] {
  return contents.map(c => {
    switch (c.role) {
      case 'human': return new HumanMessage(c.text)
      case 'ai': return new AIMessage(c.text)
      case 'system': return new SystemMessage(c.text)
      case 'tool': return new ToolMessage({ content: c.text, tool_call_id: c.toolCallId ?? 'tc-1' })
    }
  })
}

function aiWithToolCalls(text: string, callIds: string[]): AIMessage {
  const msg = new AIMessage({
    content: text,
    tool_calls: callIds.map(id => ({ id, name: 'test_tool', args: {} })),
  })
  return msg
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PhaseAwareWindowManager', () => {
  let sut: PhaseAwareWindowManager

  // -----------------------------------------------------------------------
  // detectPhase()
  // -----------------------------------------------------------------------

  describe('detectPhase()', () => {
    beforeEach(() => {
      sut = new PhaseAwareWindowManager()
    })

    it('should detect planning phase from planning keywords', () => {
      const messages = msgs(
        { role: 'human', text: 'How should we design the architecture?' },
        { role: 'ai', text: 'Let me plan the approach and structure.' },
      )

      const result = sut.detectPhase(messages)

      expect(result.phase).toBe('planning')
      expect(result.confidence).toBeGreaterThan(0)
      expect(result.matchedPattern).toBeDefined()
    })

    it('should detect debugging phase from error keywords', () => {
      const messages = msgs(
        { role: 'human', text: 'I have a bug that causes a crash' },
        { role: 'ai', text: 'Let me debug this error for you' },
      )

      const result = sut.detectPhase(messages)

      expect(result.phase).toBe('debugging')
    })

    it('should detect coding phase from code blocks', () => {
      const messages = msgs(
        { role: 'human', text: 'Implement a function to parse JSON' },
        { role: 'ai', text: 'Here is the implementation:\n```ts\nfunction parse() {}\n```' },
      )

      const result = sut.detectPhase(messages)

      expect(result.phase).toBe('coding')
    })

    it('should return general phase when no triggers match', () => {
      const messages = msgs(
        { role: 'human', text: 'Hello, how are you today?' },
        { role: 'ai', text: 'I am doing well, thank you.' },
      )

      const result = sut.detectPhase(messages)

      expect(result.phase).toBe('general')
      expect(result.confidence).toBe(0.5)
      expect(result.matchedPattern).toBeUndefined()
    })

    it('should only scan the last N messages (phaseDetectionWindow)', () => {
      sut = new PhaseAwareWindowManager({ phaseDetectionWindow: 2 })

      // Old messages have planning keywords, but window only looks at last 2
      const messages = msgs(
        { role: 'human', text: 'Let me plan the architecture and design the structure' },
        { role: 'ai', text: 'Great approach to the strategy' },
        { role: 'human', text: 'Hello, nice day' },
        { role: 'ai', text: 'Indeed it is quite nice' },
      )

      const result = sut.detectPhase(messages)

      // Last 2 messages have no trigger keywords
      expect(result.phase).toBe('general')
    })

    it('should pick the phase with the most matches when multiple phases match', () => {
      const messages = msgs(
        { role: 'human', text: 'There is an error in the build' },
        { role: 'ai', text: 'The bug causes the test to fail' },
        { role: 'human', text: 'The crash happens when it is broken' },
        { role: 'ai', text: 'Let me fix this issue' },
        { role: 'human', text: 'Yes please debug this' },
      )

      const result = sut.detectPhase(messages)

      // All 5 messages have debugging keywords
      expect(result.phase).toBe('debugging')
      expect(result.confidence).toBe(1.0)
    })

    it('should detect reviewing phase', () => {
      const messages = msgs(
        { role: 'human', text: 'Please review this code and verify it works' },
        { role: 'ai', text: 'LGTM, looks good to merge' },
      )

      const result = sut.detectPhase(messages)

      expect(result.phase).toBe('reviewing')
    })
  })

  // -----------------------------------------------------------------------
  // scoreMessages()
  // -----------------------------------------------------------------------

  describe('scoreMessages()', () => {
    it('should give system messages the highest base score', () => {
      sut = new PhaseAwareWindowManager()
      const messages = [
        new SystemMessage('You are a helpful assistant'),
        new HumanMessage('Hello'),
        new AIMessage('Hi there'),
        new ToolMessage({ content: 'tool output', tool_call_id: 'tc-1' }),
      ]

      const scores = sut.scoreMessages(messages)

      // System base=10, Human base=5, AI base=4, Tool base=3
      // Find system score (index 0) — it has the lowest recency (index 0 of 4)
      // but the highest base score
      const systemScore = scores.find(s => s.index === 0)!
      const toolScore = scores.find(s => s.index === 3)!

      // System has base 10, tool has base 3
      // Even with recency disadvantage, system should still have a meaningful score
      expect(systemScore.score).toBeGreaterThan(0)
      expect(scores[0]!.reason).toContain('base(system)=10')
      expect(scores[3]!.reason).toContain('base(tool)=3')
    })

    it('should give tool messages the lowest base score', () => {
      sut = new PhaseAwareWindowManager()
      // Put messages at the same position to isolate base score comparison
      const messages = [
        new ToolMessage({ content: 'output', tool_call_id: 'tc-1' }),
      ]

      const scores = sut.scoreMessages(messages)

      expect(scores[0]!.reason).toContain('base(tool)=3')
    })

    it('should apply recency bonus — newer messages score higher (all else equal)', () => {
      sut = new PhaseAwareWindowManager()
      // Use messages of the same type so only recency differs
      const messages = [
        new HumanMessage('first message'),
        new HumanMessage('second message'),
        new HumanMessage('third message'),
      ]

      const scores = sut.scoreMessages(messages)

      // Recency goes from 0 (oldest) to 5 (newest)
      expect(scores[2]!.score).toBeGreaterThan(scores[0]!.score)
      expect(scores[1]!.score).toBeGreaterThan(scores[0]!.score)
      expect(scores[2]!.score).toBeGreaterThan(scores[1]!.score)
    })

    it('should add +2 for code blocks in content', () => {
      sut = new PhaseAwareWindowManager()
      const messages = [
        new AIMessage('Here is code:\n```ts\nconst x = 1;\n```'),
      ]

      const scores = sut.scoreMessages(messages)

      expect(scores[0]!.reason).toContain('code=+2')
    })

    it('should add +1 for file paths in content', () => {
      sut = new PhaseAwareWindowManager()
      const messages = [
        new AIMessage('Check the file at src/utils/helper.ts'),
      ]

      const scores = sut.scoreMessages(messages)

      expect(scores[0]!.reason).toContain('paths=+1')
    })

    it('should add +2 for error indicators in content', () => {
      sut = new PhaseAwareWindowManager()
      const messages = [
        new HumanMessage('I got a TypeError: cannot read property of undefined'),
      ]

      const scores = sut.scoreMessages(messages)

      expect(scores[0]!.reason).toContain('errors=+2')
    })

    it('should subtract 2 for very short messages', () => {
      sut = new PhaseAwareWindowManager()
      const messages = [
        new HumanMessage('ok'),
      ]

      const scores = sut.scoreMessages(messages)

      expect(scores[0]!.reason).toContain('short=-2')
    })

    it('should apply phase multiplier — debugging phase doubles scores', () => {
      sut = new PhaseAwareWindowManager()
      // All messages are debugging-related
      const messages = [
        new HumanMessage('There is an error in the code'),
        new AIMessage('Let me debug this bug and fix the issue'),
      ]

      const scores = sut.scoreMessages(messages)

      // Debugging retentionMultiplier is 2.0
      for (const s of scores) {
        expect(s.reason).toContain('x2(debugging)')
      }
    })

    it('should apply planning multiplier (1.5)', () => {
      sut = new PhaseAwareWindowManager()
      const messages = [
        new HumanMessage('How should we design the architecture?'),
        new AIMessage('Let me plan the approach'),
      ]

      const scores = sut.scoreMessages(messages)

      for (const s of scores) {
        expect(s.reason).toContain('x1.5(planning)')
      }
    })

    it('should give a single message full recency bonus (5)', () => {
      sut = new PhaseAwareWindowManager()
      const messages = [new HumanMessage('Hello there, how are you')]

      const scores = sut.scoreMessages(messages)

      expect(scores[0]!.reason).toContain('recency=5.0')
    })
  })

  // -----------------------------------------------------------------------
  // findRetentionSplit()
  // -----------------------------------------------------------------------

  describe('findRetentionSplit()', () => {
    it('should return 0 when messages fit within targetKeep', () => {
      sut = new PhaseAwareWindowManager()
      const messages = msgs(
        { role: 'human', text: 'hello' },
        { role: 'ai', text: 'hi' },
      )

      const split = sut.findRetentionSplit(messages, 10)
      expect(split).toBe(0)
    })

    it('should return a split point when messages exceed targetKeep', () => {
      sut = new PhaseAwareWindowManager()
      const messages = Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? new HumanMessage(`Question ${i}`)
          : new AIMessage(`Answer ${i}`),
      )

      const split = sut.findRetentionSplit(messages, 5)

      // Split should be in the range that keeps roughly 5 messages at the end
      expect(split).toBeGreaterThan(0)
      expect(split).toBeLessThanOrEqual(messages.length - 5)
    })

    it('should not split mid-tool-call group', () => {
      sut = new PhaseAwareWindowManager()

      // Create a sequence where a naive split would land inside a tool-call group
      const messages: BaseMessage[] = [
        new HumanMessage('Low value filler message'),
        new HumanMessage('Another low value message'),
        new HumanMessage('Yet another filler'),
        new HumanMessage('More filler content here'),
        new HumanMessage('Still more filler'),
        aiWithToolCalls('Let me check that', ['tc-1']),
        new ToolMessage({ content: 'tool result', tool_call_id: 'tc-1' }),
        new HumanMessage('Thanks for checking'),
        new AIMessage('Here is the final answer with all details explained'),
      ]

      const split = sut.findRetentionSplit(messages, 3)

      // Split should not land on the ToolMessage (index 6) or the AI with tool_calls (index 5)
      // It should be at or before the AI with tool_calls
      if (split >= 5 && split <= 6) {
        // If the naive split would have been at 5 or 6, boundary alignment should push it back
        expect(split).toBeLessThanOrEqual(5)
      }

      // Verify: message at split index should not be a tool message
      if (split < messages.length) {
        const atSplit = messages[split]!
        expect(atSplit._getType()).not.toBe('tool')
      }
    })

    it('should handle edge case of targetKeep equal to message count', () => {
      sut = new PhaseAwareWindowManager()
      const messages = msgs(
        { role: 'human', text: 'one' },
        { role: 'ai', text: 'two' },
        { role: 'human', text: 'three' },
      )

      const split = sut.findRetentionSplit(messages, 3)
      expect(split).toBe(0)
    })

    it('should handle edge case of targetKeep = 1', () => {
      sut = new PhaseAwareWindowManager()
      const messages = msgs(
        { role: 'human', text: 'one' },
        { role: 'ai', text: 'two' },
        { role: 'human', text: 'three' },
      )

      const split = sut.findRetentionSplit(messages, 1)

      expect(split).toBeGreaterThanOrEqual(0)
      expect(split).toBeLessThanOrEqual(messages.length - 1)
    })

    it('should never return a negative split index', () => {
      sut = new PhaseAwareWindowManager()
      const messages = msgs(
        { role: 'human', text: 'hello' },
      )

      const split = sut.findRetentionSplit(messages, 5)
      expect(split).toBeGreaterThanOrEqual(0)
    })
  })

  // -----------------------------------------------------------------------
  // Default phases configuration
  // -----------------------------------------------------------------------

  describe('default phases', () => {
    it('should have 4 default phases (planning, coding, debugging, reviewing)', () => {
      expect(DEFAULT_PHASES).toHaveLength(4)
      const names = DEFAULT_PHASES.map(p => p.name)
      expect(names).toContain('planning')
      expect(names).toContain('coding')
      expect(names).toContain('debugging')
      expect(names).toContain('reviewing')
    })

    it('should work out of the box with no config', () => {
      sut = new PhaseAwareWindowManager()
      const messages = msgs(
        { role: 'human', text: 'Hello' },
      )

      // Should not throw
      const phase = sut.detectPhase(messages)
      expect(phase).toBeDefined()
      expect(phase.phase).toBeDefined()

      const scores = sut.scoreMessages(messages)
      expect(scores).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // Custom PhaseWindowConfig overrides
  // -----------------------------------------------------------------------

  describe('custom PhaseWindowConfig', () => {
    it('should use custom phases when provided', () => {
      const customConfig: PhaseWindowConfig = {
        phases: [
          {
            name: 'debugging',
            triggers: [/\bcustom-trigger\b/i],
            retentionMultiplier: 3.0,
            priorityTypes: ['human'],
          },
        ],
      }
      sut = new PhaseAwareWindowManager(customConfig)

      const messages = msgs(
        { role: 'human', text: 'This has the custom-trigger word' },
      )

      const result = sut.detectPhase(messages)
      expect(result.phase).toBe('debugging')
    })

    it('should use custom baseScores when provided', () => {
      const customConfig: PhaseWindowConfig = {
        baseScores: {
          system: 100,
          human: 50,
          ai: 40,
          tool: 30,
        },
      }
      sut = new PhaseAwareWindowManager(customConfig)

      const messages = [new SystemMessage('Important system message')]
      const scores = sut.scoreMessages(messages)

      expect(scores[0]!.reason).toContain('base(system)=100')
    })

    it('should use custom phaseDetectionWindow', () => {
      sut = new PhaseAwareWindowManager({ phaseDetectionWindow: 1 })

      const messages = msgs(
        { role: 'human', text: 'Let me plan the architecture design' },
        { role: 'ai', text: 'Sure, let me help you' },
        { role: 'human', text: 'Hello there nice day' },
      )

      // Only the last 1 message is scanned — no planning keywords there
      const result = sut.detectPhase(messages)
      expect(result.phase).toBe('general')
    })

    it('should fall back to defaults for fields not provided in config', () => {
      sut = new PhaseAwareWindowManager({ phaseDetectionWindow: 3 })

      // Should still use DEFAULT_PHASES since phases was not overridden
      const messages = msgs(
        { role: 'human', text: 'I found a bug that causes a crash' },
      )
      const result = sut.detectPhase(messages)
      expect(result.phase).toBe('debugging')
    })
  })
})
