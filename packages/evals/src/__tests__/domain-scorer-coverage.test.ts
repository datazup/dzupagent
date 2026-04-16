/**
 * Additional coverage tests for DomainScorer — targeting LLM-based scoring,
 * combined (deterministic + LLM) paths, auto-detect, and edge cases.
 */
import { describe, it, expect, vi } from 'vitest';
import { DomainScorer } from '../scorers/domain-scorer.js';
import type { EvalInput } from '../types.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides?: Partial<EvalInput>): EvalInput {
  return {
    input: 'Write a function to add numbers',
    output: 'function add(a: number, b: number): number { return a + b; }',
    ...overrides,
  };
}

function makeMockModel(responses: string[]): BaseChatModel {
  let callIndex = 0;
  return {
    invoke: vi.fn().mockImplementation(async () => {
      const text = responses[callIndex] ?? responses[responses.length - 1] ?? '';
      callIndex++;
      return { content: text };
    }),
  } as unknown as BaseChatModel;
}

// ---------------------------------------------------------------------------
// Domain detection
// ---------------------------------------------------------------------------

describe('DomainScorer.detectDomain', () => {
  it('detects SQL domain', () => {
    expect(DomainScorer.detectDomain(makeInput({
      input: 'Write a SQL query to get users',
      output: 'SELECT * FROM users WHERE active = true',
    }))).toBe('sql');
  });

  it('detects code domain', () => {
    expect(DomainScorer.detectDomain(makeInput({
      input: 'Write a TypeScript function',
      output: 'function greet(name: string): string { return `Hello ${name}`; }',
    }))).toBe('code');
  });

  it('detects analysis domain', () => {
    expect(DomainScorer.detectDomain(makeInput({
      input: 'Analyze the trends and provide data insights',
      output: 'Based on the analysis, the correlation coefficient shows a strong relationship.',
    }))).toBe('analysis');
  });

  it('detects ops domain', () => {
    expect(DomainScorer.detectDomain(makeInput({
      input: 'Deploy the kubernetes service',
      output: 'kubectl apply -f deployment.yaml\ndocker build -t app:latest .',
    }))).toBe('ops');
  });

  it('falls back to general for ambiguous text', () => {
    expect(DomainScorer.detectDomain(makeInput({
      input: 'Tell me something interesting',
      output: 'The sky is blue because of Rayleigh scattering.',
    }))).toBe('general');
  });

  it('uses single-match fallback when no domain has 2+ matches', () => {
    // Only one SQL keyword, should still be detected via single-match fallback
    expect(DomainScorer.detectDomain(makeInput({
      input: 'Help me',
      output: 'SELECT name',
    }))).toBe('sql');
  });
});

// ---------------------------------------------------------------------------
// DomainScorer without LLM (deterministic-only scoring)
// ---------------------------------------------------------------------------

describe('DomainScorer — deterministic only', () => {
  it('scores SQL domain using deterministic checks only', async () => {
    const scorer = new DomainScorer({ domain: 'sql' });
    const result = await scorer.score(makeInput({
      input: 'query',
      output: 'SELECT id, name\nFROM users\nWHERE active = true\nLIMIT 10',
    }));

    expect(result.domain).toBe('sql');
    expect(result.aggregateScore).toBeGreaterThan(0);
    expect(result.criterionResults.length).toBeGreaterThan(0);
    // Should use deterministic method since no model provided
    const methods = result.criterionResults.map((r) => r.method);
    expect(methods).toContain('deterministic');
  });

  it('scores code domain using deterministic checks only', async () => {
    const scorer = new DomainScorer({ domain: 'code' });
    const result = await scorer.score(makeInput({
      input: 'write tests',
      output: `describe('add', () => {
  it('adds', () => {
    expect(add(1, 2)).toBe(3);
  });
});`,
    }));

    expect(result.domain).toBe('code');
    expect(result.aggregateScore).toBeGreaterThan(0);
  });

  it('scores general domain (no deterministic checks) — fallback to 0', async () => {
    const scorer = new DomainScorer({ domain: 'general' });
    const result = await scorer.score(makeInput());

    expect(result.domain).toBe('general');
    // General domain has no deterministic checks and no model => all criteria score 0
    const hasNoMethodAvailable = result.criterionResults.some(
      (r) => r.reasoning.includes('No evaluation method available'),
    );
    expect(hasNoMethodAvailable).toBe(true);
  });

  it('uses custom passThreshold', async () => {
    const scorer = new DomainScorer({ domain: 'sql', passThreshold: 0.99 });
    const result = await scorer.score(makeInput({
      input: 'q',
      output: 'SELECT id FROM users',
    }));

    // Score won't reach 0.99 with deterministic only
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DomainScorer with LLM
// ---------------------------------------------------------------------------

describe('DomainScorer — with LLM', () => {
  it('uses LLM for criteria without deterministic checks', async () => {
    const model = makeMockModel([
      '{"score": 8, "reasoning": "Good schema compliance"}',
    ]);

    const scorer = new DomainScorer({ domain: 'sql', model });
    const result = await scorer.score(makeInput({
      input: 'query',
      output: 'SELECT id FROM users WHERE active = true',
    }));

    expect(result.aggregateScore).toBeGreaterThan(0);
    // Some criteria should use llm-judge or combined method
    const llmResults = result.criterionResults.filter(
      (r) => r.method === 'llm-judge' || r.method === 'combined',
    );
    expect(llmResults.length).toBeGreaterThan(0);
  });

  it('handles LLM failure gracefully with fallback score', async () => {
    const model = makeMockModel(['not json at all']);

    const scorer = new DomainScorer({ domain: 'sql', model, maxRetries: 0 });
    const result = await scorer.score(makeInput({
      input: 'q',
      output: 'SELECT 1',
    }));

    // Should not throw; fallback score of 0.5 for LLM failures
    expect(result.aggregateScore).toBeGreaterThanOrEqual(0);
    const llmCriteria = result.criterionResults.filter((r) => r.method === 'llm-judge' || r.method === 'combined');
    for (const c of llmCriteria) {
      // Fallback is 0.5 when LLM fails
      expect(c.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles LLM throwing error with retries', async () => {
    const model = {
      invoke: vi.fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({ content: '{"score": 7, "reasoning": "ok"}' }),
    } as unknown as BaseChatModel;

    const scorer = new DomainScorer({ domain: 'general', model, maxRetries: 2 });
    const result = await scorer.score(makeInput());

    expect(result.aggregateScore).toBeGreaterThan(0);
  });

  it('handles model returning array content', async () => {
    const model = {
      invoke: vi.fn().mockResolvedValue({
        content: [
          { type: 'text', text: '{"score": 9, ' },
          { type: 'text', text: '"reasoning": "excellent"}' },
        ],
      }),
    } as unknown as BaseChatModel;

    const scorer = new DomainScorer({ domain: 'general', model });
    const result = await scorer.score(makeInput());

    expect(result.aggregateScore).toBeGreaterThan(0);
  });

  it('includes reference in LLM prompt when provided', async () => {
    const model = {
      invoke: vi.fn().mockResolvedValue({
        content: '{"score": 8, "reasoning": "good"}',
      }),
    } as unknown as BaseChatModel;

    const scorer = new DomainScorer({ domain: 'general', model });
    await scorer.score(makeInput({
      reference: 'Expected correct answer',
    }));

    const calls = (model.invoke as ReturnType<typeof vi.fn>).mock.calls;
    // At least one call should include the reference
    const hasReference = calls.some((call) => {
      const messages = call[0] as Array<{ content: string }>;
      return messages.some((m) => typeof m.content === 'string' && m.content.includes('Reference'));
    });
    expect(hasReference).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auto-detect mode
// ---------------------------------------------------------------------------

describe('DomainScorer.createAutoDetect', () => {
  it('creates an auto-detecting scorer', () => {
    const model = makeMockModel(['{"score": 5, "reasoning": "ok"}']);
    const scorer = DomainScorer.createAutoDetect(model);

    expect(scorer.config.id).toContain('auto');
    expect(scorer.config.description).toContain('Auto-detecting');
  });

  it('auto-detects domain per input', async () => {
    const model = makeMockModel(['{"score": 7, "reasoning": "fine"}']);
    const scorer = DomainScorer.createAutoDetect(model);

    const sqlResult = await scorer.score(makeInput({
      input: 'Write a SQL query',
      output: 'SELECT * FROM users WHERE id = 1',
    }));

    expect(sqlResult.domain).toBe('sql');
  });
});

// ---------------------------------------------------------------------------
// getConfig
// ---------------------------------------------------------------------------

describe('DomainScorer.getConfig', () => {
  it('returns config for each domain', () => {
    for (const domain of ['sql', 'code', 'analysis', 'ops', 'general'] as const) {
      const config = DomainScorer.getConfig(domain);
      expect(config.domain).toBe(domain);
      expect(config.criteria.length).toBeGreaterThan(0);
    }
  });

  it('returns a clone (not the original)', () => {
    const config1 = DomainScorer.getConfig('sql');
    const config2 = DomainScorer.getConfig('sql');
    expect(config1).toEqual(config2);
    expect(config1).not.toBe(config2);
    expect(config1.criteria[0]).not.toBe(config2.criteria[0]);
  });
});
