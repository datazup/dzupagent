import { describe, it, expect } from 'vitest';
import { createDemoEvalSuite, buildStubAnthropicClient } from '../../eval/demo-suite.js';
import { runEvalSuite } from '../../eval/runner.js';

describe('Demo eval suite', () => {
  it('runs to completion with stub client and all cases pass', async () => {
    const suite = createDemoEvalSuite(buildStubAnthropicClient());
    const result = await runEvalSuite(suite);

    expect(result.suiteName).toBe('demo-eval-suite');
    expect(result.cases).toHaveLength(4);
    // Every case should hit passThreshold because exact-match and llm-judge both pass.
    expect(result.allPassed).toBe(true);
  });

  it('reports passRate=1.0 with the default stub', async () => {
    const suite = createDemoEvalSuite();
    const result = await runEvalSuite(suite);
    expect(result.passRate).toBe(1.0);
  });

  it('buildStubAnthropicClient returns configurable responses', async () => {
    const failClient = buildStubAnthropicClient({ score: 0.1, pass: false, reasoning: 'bad' });
    const msg = await failClient.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: 'test' }],
    });
    const text = msg.content[0]?.text ?? '';
    const parsed = JSON.parse(text) as { score: number; pass: boolean; reasoning: string };
    expect(parsed.score).toBe(0.1);
    expect(parsed.pass).toBe(false);
  });

  it('each case result carries caseId matching suite definition', async () => {
    const suite = createDemoEvalSuite();
    const result = await runEvalSuite(suite);
    const ids = result.cases.map((c) => c.caseId);
    expect(ids).toContain('capital-france');
    expect(ids).toContain('capital-germany');
    expect(ids).toContain('addition');
    expect(ids).toContain('json-greeting');
  });

  it('result has three scorer entries per case (exact-match, alphanumeric-only, llm-judge)', async () => {
    const suite = createDemoEvalSuite();
    const result = await runEvalSuite(suite);
    for (const caseResult of result.cases) {
      expect(caseResult.scorerScores).toHaveLength(3);
      const scorerIds = caseResult.scorerScores.map((s) => s.scorerId);
      expect(scorerIds).toContain('exact-match');
      expect(scorerIds).toContain('alphanumeric-only');
      expect(scorerIds).toContain('llm-judge');
    }
  });
});
