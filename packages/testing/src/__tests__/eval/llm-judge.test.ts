import { describe, it, expect } from 'vitest';
import { LlmJudgeScorer } from '../../eval/scorers/llm-judge.js';
import type { AnthropicClient } from '../../eval/scorers/llm-judge.js';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeClient(responseText: string): AnthropicClient {
  return {
    messages: {
      async create() {
        return { content: [{ type: 'text', text: responseText }] };
      },
    },
  };
}

function jsonClient(score: number, pass: boolean, reasoning: string): AnthropicClient {
  return makeClient(JSON.stringify({ score, pass, reasoning }));
}

function errorClient(): AnthropicClient {
  return {
    messages: {
      async create(): Promise<never> {
        throw new Error('network error');
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LlmJudgeScorer', () => {
  it('has default id "llm-judge"', () => {
    const sut = new LlmJudgeScorer({ client: jsonClient(1, true, 'ok') });
    expect(sut.id).toBe('llm-judge');
  });

  it('uses custom id when provided', () => {
    const sut = new LlmJudgeScorer({ client: jsonClient(1, true, 'ok'), id: 'my-judge' });
    expect(sut.id).toBe('my-judge');
  });

  describe('valid JSON response', () => {
    it('returns score and pass from judge', async () => {
      const sut = new LlmJudgeScorer({ client: jsonClient(0.85, true, 'Good answer') });
      const result = await sut.score('What is 2+2?', '4', '4');
      expect(result.score).toBe(0.85);
      expect(result.pass).toBe(true);
      expect(result.reasoning).toBe('Good answer');
    });

    it('returns pass=false when score is low', async () => {
      const sut = new LlmJudgeScorer({ client: jsonClient(0.3, false, 'Poor answer') });
      const result = await sut.score('What is 2+2?', '5');
      expect(result.score).toBe(0.3);
      expect(result.pass).toBe(false);
    });

    it('clamps score to [0, 1] when model returns out-of-range value', async () => {
      const sut = new LlmJudgeScorer({ client: makeClient(JSON.stringify({ score: 1.5, pass: true, reasoning: 'over' })) });
      const result = await sut.score('q', 'a');
      expect(result.score).toBeLessThanOrEqual(1.0);
    });
  });

  describe('JSON wrapped in markdown fences', () => {
    it('strips ``` json fences before parsing', async () => {
      const fenced = '```json\n{"score":0.9,"pass":true,"reasoning":"fine"}\n```';
      const sut = new LlmJudgeScorer({ client: makeClient(fenced) });
      const result = await sut.score('q', 'a');
      expect(result.score).toBe(0.9);
      expect(result.pass).toBe(true);
    });
  });

  describe('malformed responses', () => {
    it('returns score=0, pass=false on non-JSON response', async () => {
      const sut = new LlmJudgeScorer({ client: makeClient('sorry I cannot score this') });
      const result = await sut.score('q', 'a');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toMatch(/could not parse/i);
    });

    it('returns score=0, pass=false when JSON is array', async () => {
      const sut = new LlmJudgeScorer({ client: makeClient('[1, 2, 3]') });
      const result = await sut.score('q', 'a');
      expect(result.pass).toBe(false);
    });

    it('defaults pass to score>=0.5 when pass field is missing', async () => {
      const sut = new LlmJudgeScorer({
        client: makeClient(JSON.stringify({ score: 0.8, reasoning: 'ok' })),
      });
      const result = await sut.score('q', 'a');
      expect(result.pass).toBe(true); // 0.8 >= 0.5
    });
  });

  describe('LLM call failure', () => {
    it('returns pass=false with error reasoning on network failure', async () => {
      const sut = new LlmJudgeScorer({ client: errorClient() });
      const result = await sut.score('q', 'a');
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reasoning).toMatch(/failed/i);
    });
  });

  describe('passes expected to judge context', () => {
    it('includes reference when expected provided', async () => {
      let capturedContent = '';
      const client: AnthropicClient = {
        messages: {
          async create(params) {
            capturedContent = params.messages[0]?.content ?? '';
            return { content: [{ type: 'text', text: JSON.stringify({ score: 1, pass: true, reasoning: 'ok' }) }] };
          },
        },
      };
      const sut = new LlmJudgeScorer({ client });
      await sut.score('question', 'answer', 'expected-ref');
      expect(capturedContent).toContain('expected-ref');
    });
  });
});
