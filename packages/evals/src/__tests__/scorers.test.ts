import { describe, it, expect, vi } from 'vitest';
import { DeterministicScorer } from '../deterministic-scorer.js';
import { LLMJudgeScorer } from '../llm-judge-scorer.js';
import { CompositeScorer } from '../composite-scorer.js';
import { runEvalSuite } from '../eval-runner.js';
import type { EvalScorer } from '../types.js';

describe('DeterministicScorer', () => {
  describe('exactMatch mode', () => {
    it('scores 1.0 for identical strings', async () => {
      const scorer = new DeterministicScorer({ mode: 'exactMatch' });
      const result = await scorer.score('input', 'hello world', 'hello world');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('scores 0.0 for different strings', async () => {
      const scorer = new DeterministicScorer({ mode: 'exactMatch' });
      const result = await scorer.score('input', 'hello', 'world');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });

    it('supports caseInsensitive matching', async () => {
      const scorer = new DeterministicScorer({
        mode: 'exactMatch',
        caseInsensitive: true,
      });
      const result = await scorer.score('input', 'Hello World', 'hello world');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('returns 0.0 when no reference is provided', async () => {
      const scorer = new DeterministicScorer({ mode: 'exactMatch' });
      const result = await scorer.score('input', 'hello');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });
  });

  describe('contains mode', () => {
    it('scores 1.0 when substring is found', async () => {
      const scorer = new DeterministicScorer({ mode: 'contains' });
      const result = await scorer.score('input', 'hello world foo', 'world');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('scores 0.0 when substring is not found', async () => {
      const scorer = new DeterministicScorer({ mode: 'contains' });
      const result = await scorer.score('input', 'hello world', 'xyz');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });

    it('supports caseInsensitive contains', async () => {
      const scorer = new DeterministicScorer({
        mode: 'contains',
        caseInsensitive: true,
      });
      const result = await scorer.score('input', 'Hello World', 'hello');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });
  });

  describe('regex mode', () => {
    it('scores 1.0 when pattern matches', async () => {
      const scorer = new DeterministicScorer({
        mode: 'regex',
        pattern: /^\d{3}-\d{4}$/,
      });
      const result = await scorer.score('input', '123-4567');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('scores 0.0 when pattern does not match', async () => {
      const scorer = new DeterministicScorer({
        mode: 'regex',
        pattern: /^\d{3}-\d{4}$/,
      });
      const result = await scorer.score('input', 'abc-defg');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });

    it('returns 0.0 when no pattern is provided', async () => {
      const scorer = new DeterministicScorer({ mode: 'regex' });
      const result = await scorer.score('input', 'anything');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });
  });

  describe('jsonSchema mode', () => {
    it('scores 1.0 when JSON matches schema with required fields', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          required: ['name', 'age'],
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
        },
      });
      const result = await scorer.score(
        'input',
        JSON.stringify({ name: 'Alice', age: 30 }),
      );
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('scores 0.0 when required field is missing', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          required: ['name', 'age'],
        },
      });
      const result = await scorer.score(
        'input',
        JSON.stringify({ name: 'Alice' }),
      );
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('age');
    });

    it('scores 0.0 for invalid JSON', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: { required: ['name'] },
      });
      const result = await scorer.score('input', 'not json at all');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('not valid JSON');
    });

    it('scores 0.0 when field type is wrong', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          properties: {
            age: { type: 'number' },
          },
        },
      });
      const result = await scorer.score(
        'input',
        JSON.stringify({ age: 'thirty' }),
      );
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });
  });
});

describe('LLMJudgeScorer', () => {
  it('calls LLM with formatted prompt and parses response', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.85, pass: true, reasoning: 'Well structured' }),
    );

    const scorer = new LLMJudgeScorer({
      llm,
      rubric: 'Check for clarity',
    });

    const result = await scorer.score('What is 2+2?', '4');
    expect(result.score).toBe(0.85);
    expect(result.pass).toBe(true);
    expect(result.reasoning).toBe('Well structured');

    expect(llm).toHaveBeenCalledOnce();
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Check for clarity');
    expect(prompt).toContain('What is 2+2?');
    expect(prompt).toContain('4');
  });

  it('includes reference in prompt when provided', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.9, pass: true, reasoning: 'Good' }),
    );

    const scorer = new LLMJudgeScorer({
      llm,
      rubric: 'Accuracy',
    });

    await scorer.score('question', 'answer', 'expected answer');

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Reference: expected answer');
  });

  it('does not include reference line when reference is not provided', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.5, pass: true, reasoning: 'OK' }),
    );

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    await scorer.score('input', 'output');

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).not.toContain('Reference:');
  });

  it('handles LLM parse failure gracefully with score 0.0', async () => {
    const llm = vi.fn().mockResolvedValue('not valid json at all');

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');

    expect(result.score).toBe(0.0);
    expect(result.pass).toBe(false);
    expect(result.reasoning).toBe('Failed to parse LLM response');
  });

  it('handles LLM call failure gracefully', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('API error'));

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');

    expect(result.score).toBe(0.0);
    expect(result.pass).toBe(false);
    expect(result.reasoning).toBe('Failed to call LLM');
  });

  it('clamps score to [0, 1] range', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 1.5, pass: true, reasoning: 'Over' }),
    );

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');

    expect(result.score).toBe(1.0);
  });
});

describe('CompositeScorer', () => {
  function makeScorer(name: string, score: number): EvalScorer {
    return {
      name,
      score: vi.fn().mockResolvedValue({
        score,
        pass: score >= 0.5,
        reasoning: `${name} scored ${score}`,
      }),
    };
  }

  it('computes weighted average of two scorers', async () => {
    const s1 = makeScorer('s1', 1.0);
    const s2 = makeScorer('s2', 0.0);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 1 },
        { scorer: s2, weight: 1 },
      ],
    });

    const result = await scorer.score('input', 'output');
    expect(result.score).toBeCloseTo(0.5);
  });

  it('normalizes weights', async () => {
    const s1 = makeScorer('s1', 1.0);
    const s2 = makeScorer('s2', 0.0);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 3 },
        { scorer: s2, weight: 1 },
      ],
    });

    const result = await scorer.score('input', 'output');
    // (1.0 * 3 + 0.0 * 1) / 4 = 0.75
    expect(result.score).toBeCloseTo(0.75);
  });

  it('runs scorers in parallel', async () => {
    const slowScorer: EvalScorer = {
      name: 'slow',
      score: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { score: 1.0, pass: true, reasoning: 'slow done' };
      },
    };
    const fastScorer: EvalScorer = {
      name: 'fast',
      score: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { score: 0.8, pass: true, reasoning: 'fast done' };
      },
    };

    const composite = new CompositeScorer({
      scorers: [
        { scorer: slowScorer, weight: 1 },
        { scorer: fastScorer, weight: 1 },
      ],
    });

    const start = Date.now();
    await composite.score('input', 'output');
    const elapsed = Date.now() - start;

    // If run in parallel, total time should be ~50ms, not ~100ms
    expect(elapsed).toBeLessThan(120);
  });

  it('combines reasoning from all scorers', async () => {
    const s1 = makeScorer('accuracy', 0.9);
    const s2 = makeScorer('clarity', 0.7);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 1 },
        { scorer: s2, weight: 1 },
      ],
    });

    const result = await scorer.score('input', 'output');
    expect(result.reasoning).toContain('accuracy');
    expect(result.reasoning).toContain('clarity');
  });

  it('pass is based on 0.5 threshold', async () => {
    const s1 = makeScorer('s1', 0.3);
    const s2 = makeScorer('s2', 0.2);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 1 },
        { scorer: s2, weight: 1 },
      ],
    });

    const result = await scorer.score('input', 'output');
    expect(result.score).toBeCloseTo(0.25);
    expect(result.pass).toBe(false);
  });

  it('handles empty scorers array', async () => {
    const scorer = new CompositeScorer({ scorers: [] });
    const result = await scorer.score('input', 'output');
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
  });
});

describe('runEvalSuite', () => {
  it('runs a suite and computes aggregate results', async () => {
    const scorer = new DeterministicScorer({ mode: 'exactMatch' });

    const result = await runEvalSuite(
      {
        name: 'test-suite',
        cases: [
          { id: 'c1', input: 'hello', expectedOutput: 'HELLO' },
          { id: 'c2', input: 'world', expectedOutput: 'WORLD' },
        ],
        scorers: [scorer],
        passThreshold: 0.5,
      },
      async (input: string) => input.toUpperCase(),
    );

    expect(result.suiteId).toBe('test-suite');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.pass).toBe(true);
    expect(result.results[1]!.pass).toBe(true);
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passRate).toBe(1.0);
  });

  it('handles partial pass rate', async () => {
    const scorer = new DeterministicScorer({ mode: 'exactMatch' });

    const result = await runEvalSuite(
      {
        name: 'partial-suite',
        cases: [
          { id: 'c1', input: 'hello', expectedOutput: 'hello' },
          { id: 'c2', input: 'world', expectedOutput: 'WRONG' },
        ],
        scorers: [scorer],
        passThreshold: 0.5,
      },
      async (input: string) => input,
    );

    expect(result.passRate).toBe(0.5);
    expect(result.aggregateScore).toBe(0.5);
  });
});

// ===========================================================================
// W18-B2: Gap-filling tests for legacy scorers
// ===========================================================================

describe('LLMJudgeScorer (gap coverage)', () => {
  describe('valid JSON parsing', () => {
    it('returns score=0.8 when LLM returns {"score": 0.8, ...}', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({ score: 0.8, pass: true, reasoning: 'good' }),
      );
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.score).toBe(0.8);
    });

    it('does not clamp when LLM returns score=0', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({ score: 0, pass: false, reasoning: 'zero' }),
      );
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.score).toBe(0);
    });

    it('does not clamp when LLM returns score=1', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({ score: 1, pass: true, reasoning: 'one' }),
      );
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.score).toBe(1);
    });

    it('clamps score > 1 to 1.0', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({ score: 2.5, pass: true, reasoning: 'over' }),
      );
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.score).toBe(1.0);
    });

    it('clamps negative score to 0.0', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({ score: -0.7, pass: false, reasoning: 'negative' }),
      );
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.score).toBe(0.0);
    });
  });

  describe('malformed responses', () => {
    it('returns score=0 with diagnostic reasoning for malformed JSON', async () => {
      const llm = vi.fn().mockResolvedValue('this is not json {');
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('parse');
    });

    it('handles missing score field gracefully (defaults to 0)', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({ pass: true, reasoning: 'no score field' }),
      );
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.score).toBe(0);
      // pass-field is honored since it's a valid boolean
      expect(result.pass).toBe(true);
      expect(result.reasoning).toBe('no score field');
    });

    it('treats JSON array as failure (not an object)', async () => {
      const llm = vi.fn().mockResolvedValue(JSON.stringify([1, 2, 3]));
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('parse');
    });

    it('treats JSON null as failure (not an object)', async () => {
      const llm = vi.fn().mockResolvedValue('null');
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
    });

    it('returns score=0 and diagnostic reasoning when LLM rejects', async () => {
      const llm = vi.fn().mockRejectedValue(new Error('connection reset'));
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toBe('Failed to call LLM');
    });
  });

  describe('reasoning preservation', () => {
    it('preserves the LLM-provided reasoning string verbatim', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({
          score: 0.42,
          pass: false,
          reasoning: 'This response lacked depth and missed the main point.',
        }),
      );
      const scorer = new LLMJudgeScorer({ llm, rubric: 'depth' });
      const result = await scorer.score('Q?', 'A.');
      expect(result.reasoning).toBe(
        'This response lacked depth and missed the main point.',
      );
    });

    it('falls back to "No reasoning provided" when reasoning is missing', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({ score: 0.5, pass: true }),
      );
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      const result = await scorer.score('in', 'out');
      expect(result.reasoning).toBe('No reasoning provided');
    });
  });

  describe('configuration', () => {
    it('defaults the .name to "llm-judge"', () => {
      const llm = vi.fn();
      const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
      expect(scorer.name).toBe('llm-judge');
    });

    it('honors a custom .name', () => {
      const llm = vi.fn();
      const scorer = new LLMJudgeScorer({
        llm,
        rubric: 'r',
        name: 'my-judge',
      });
      expect(scorer.name).toBe('my-judge');
    });

    it('uses custom scoreRange in the prompt when provided', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({ score: 0.5, pass: true, reasoning: 'ok' }),
      );
      const scorer = new LLMJudgeScorer({
        llm,
        rubric: 'r',
        scoreRange: '1 to 5',
      });
      await scorer.score('in', 'out');
      const prompt = llm.mock.calls[0]![0] as string;
      expect(prompt).toContain('1 to 5');
    });
  });
});

describe('DeterministicScorer (gap coverage)', () => {
  describe('exactMatch — case sensitivity defaults', () => {
    it('is case-sensitive by default ("Hello" !== "hello")', async () => {
      const scorer = new DeterministicScorer({ mode: 'exactMatch' });
      const result = await scorer.score('in', 'Hello', 'hello');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });
  });

  describe('contains — case sensitivity defaults', () => {
    it('contains is case-sensitive by default ("HELLO" does not contain "hello")', async () => {
      const scorer = new DeterministicScorer({ mode: 'contains' });
      const result = await scorer.score('in', 'HELLO WORLD', 'hello');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });

    it('returns 0.0 with diagnostic reasoning when no reference provided', async () => {
      const scorer = new DeterministicScorer({ mode: 'contains' });
      const result = await scorer.score('in', 'output');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('No reference');
    });
  });

  describe('regex — patterns', () => {
    it('matches a complex valid regex', async () => {
      const scorer = new DeterministicScorer({
        mode: 'regex',
        pattern: /^[a-z]+\s+\d+$/i,
      });
      const result = await scorer.score('in', 'Hello 42');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('returns 0.0 when valid regex does not match', async () => {
      const scorer = new DeterministicScorer({
        mode: 'regex',
        pattern: /\d+/,
      });
      const result = await scorer.score('in', 'no digits here');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('does not match');
    });

    it('embeds the pattern in the reasoning string', async () => {
      const scorer = new DeterministicScorer({
        mode: 'regex',
        pattern: /^foo$/,
      });
      const matched = await scorer.score('in', 'foo');
      expect(matched.reasoning).toContain('/^foo$/');
      const unmatched = await scorer.score('in', 'bar');
      expect(unmatched.reasoning).toContain('/^foo$/');
    });
  });

  describe('jsonSchema — additional paths', () => {
    it('rejects JSON arrays (not objects)', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: { required: ['name'] },
      });
      const result = await scorer.score('in', JSON.stringify([1, 2, 3]));
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('not a JSON object');
    });

    it('rejects JSON null', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: { required: ['name'] },
      });
      const result = await scorer.score('in', 'null');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('not a JSON object');
    });

    it('returns 0.0 when no schema is configured', async () => {
      const scorer = new DeterministicScorer({ mode: 'jsonSchema' });
      const result = await scorer.score('in', JSON.stringify({ x: 1 }));
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('No schema');
    });

    it('detects array properties as type "array" (not "object")', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          properties: {
            tags: { type: 'array' },
          },
        },
      });
      const ok = await scorer.score(
        'in',
        JSON.stringify({ tags: ['a', 'b'] }),
      );
      expect(ok.score).toBe(1.0);
      const wrong = await scorer.score(
        'in',
        JSON.stringify({ tags: 'not-array' }),
      );
      expect(wrong.score).toBe(0.0);
      expect(wrong.reasoning).toContain('array');
    });

    it('passes when properties are absent and schema only specifies optional types', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          properties: {
            optional: { type: 'string' },
          },
        },
      });
      // No "optional" key in object -> schema only checks existing keys
      const result = await scorer.score('in', JSON.stringify({ other: 1 }));
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });
  });

  describe('name property', () => {
    it('defaults .name to "deterministic-<mode>"', () => {
      const exact = new DeterministicScorer({ mode: 'exactMatch' });
      expect(exact.name).toBe('deterministic-exactMatch');
      const contains = new DeterministicScorer({ mode: 'contains' });
      expect(contains.name).toBe('deterministic-contains');
      const regex = new DeterministicScorer({ mode: 'regex', pattern: /./ });
      expect(regex.name).toBe('deterministic-regex');
      const json = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {},
      });
      expect(json.name).toBe('deterministic-jsonSchema');
    });

    it('honors a custom .name', () => {
      const scorer = new DeterministicScorer({
        mode: 'exactMatch',
        name: 'string-equality',
      });
      expect(scorer.name).toBe('string-equality');
    });
  });
});

describe('CompositeScorer (gap coverage)', () => {
  function fixedScorer(name: string, score: number): EvalScorer {
    return {
      name,
      score: vi.fn().mockResolvedValue({
        score,
        pass: score >= 0.5,
        reasoning: `${name}=${score}`,
      }),
    };
  }

  describe('basic composition', () => {
    it('returns the same score as the underlying scorer when wrapping a single one', async () => {
      const inner = fixedScorer('inner', 0.42);
      const composite = new CompositeScorer({
        scorers: [{ scorer: inner, weight: 1 }],
      });
      const result = await composite.score('in', 'out');
      expect(result.score).toBeCloseTo(0.42);
    });

    it('computes plain average when two scorers have equal weights', async () => {
      const composite = new CompositeScorer({
        scorers: [
          { scorer: fixedScorer('a', 0.4), weight: 2 },
          { scorer: fixedScorer('b', 0.8), weight: 2 },
        ],
      });
      const result = await composite.score('in', 'out');
      // (0.4*2 + 0.8*2) / 4 = 0.6
      expect(result.score).toBeCloseTo(0.6);
    });

    it('computes weighted average with 0.8/0.2 weights', async () => {
      const composite = new CompositeScorer({
        scorers: [
          { scorer: fixedScorer('main', 1.0), weight: 0.8 },
          { scorer: fixedScorer('aux', 0.0), weight: 0.2 },
        ],
      });
      const result = await composite.score('in', 'out');
      // (1.0*0.8 + 0.0*0.2) / 1.0 = 0.8
      expect(result.score).toBeCloseTo(0.8);
    });

    it('falls back to score=0 when all weights are zero (totalWeight==0)', async () => {
      const composite = new CompositeScorer({
        scorers: [
          { scorer: fixedScorer('a', 1.0), weight: 0 },
          { scorer: fixedScorer('b', 1.0), weight: 0 },
        ],
      });
      const result = await composite.score('in', 'out');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('Total weight is zero');
    });

    it('produces score=0 with empty scorers array', async () => {
      const composite = new CompositeScorer({ scorers: [] });
      const result = await composite.score('in', 'out');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('No scorers configured');
    });
  });

  describe('reasoning and metadata', () => {
    it('reasoning string includes every component scorer name', async () => {
      const composite = new CompositeScorer({
        scorers: [
          { scorer: fixedScorer('alpha', 0.5), weight: 1 },
          { scorer: fixedScorer('beta', 0.5), weight: 2 },
          { scorer: fixedScorer('gamma', 0.5), weight: 3 },
        ],
      });
      const result = await composite.score('in', 'out');
      expect(result.reasoning).toContain('alpha');
      expect(result.reasoning).toContain('beta');
      expect(result.reasoning).toContain('gamma');
    });

    it('metadata includes per-scorer raw and normalized weights', async () => {
      const composite = new CompositeScorer({
        scorers: [
          { scorer: fixedScorer('a', 0.5), weight: 3 },
          { scorer: fixedScorer('b', 0.5), weight: 1 },
        ],
      });
      const result = await composite.score('in', 'out');
      const md = result.metadata as
        | { scorerResults: Array<Record<string, number | string>> }
        | undefined;
      expect(md).toBeDefined();
      expect(md!.scorerResults).toHaveLength(2);
      expect(md!.scorerResults[0]!['weight']).toBe(3);
      expect(md!.scorerResults[0]!['normalizedWeight']).toBeCloseTo(0.75);
      expect(md!.scorerResults[1]!['weight']).toBe(1);
      expect(md!.scorerResults[1]!['normalizedWeight']).toBeCloseTo(0.25);
    });
  });

  describe('configuration', () => {
    it('defaults .name to "composite"', () => {
      const composite = new CompositeScorer({ scorers: [] });
      expect(composite.name).toBe('composite');
    });

    it('honors a custom .name', () => {
      const composite = new CompositeScorer({
        scorers: [],
        name: 'overall-score',
      });
      expect(composite.name).toBe('overall-score');
    });

    it('passes input/output/reference through to component scorers', async () => {
      const seen: Array<{ input: string; output: string; ref?: string }> = [];
      const sniff: EvalScorer = {
        name: 'sniff',
        score: async (input, output, reference) => {
          seen.push({ input, output, ref: reference });
          return { score: 1.0, pass: true, reasoning: 'sniffed' };
        },
      };
      const composite = new CompositeScorer({
        scorers: [{ scorer: sniff, weight: 1 }],
      });
      await composite.score('the-input', 'the-output', 'the-reference');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({
        input: 'the-input',
        output: 'the-output',
        ref: 'the-reference',
      });
    });
  });
});
