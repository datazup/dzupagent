import { describe, expect, it, vi } from 'vitest';
import {
  FactualityEval,
  FactualityScorer,
  type FactualityClaim,
  type FactualityClaimResult,
  type FactualityEvalInput,
  type ReferenceFact,
} from '../scorers/factuality-scorer.js';

const facts: ReferenceFact[] = [
  { id: 'fact-1', text: 'Paris is the capital of France.' },
  { id: 'fact-2', text: 'The Eiffel Tower is in Paris.' },
  { id: 'fact-3', text: 'Berlin is the capital of Germany.' },
];

const claims: FactualityClaim[] = [
  { id: 'claim-1', text: 'Paris is the capital of France.' },
  { id: 'claim-2', text: 'The Eiffel Tower is in Paris.' },
  { id: 'claim-3', text: 'The Eiffel Tower is in Lyon.' },
];

const makeInput = (overrides: Partial<FactualityEvalInput> = {}): FactualityEvalInput => ({
  input: 'Answer the geography question.',
  output: 'Paris is the capital of France.',
  referenceFacts: facts,
  ...overrides,
});

const resultFor = (
  claim: FactualityClaim,
  status: FactualityClaimResult['status'],
  matchedFactIds: string[] = [],
): FactualityClaimResult => ({
  claim,
  status,
  matchedFactIds,
  confidence: status === 'verified' ? 0.95 : 0.2,
  reasoning: `${claim.id} is ${status}`,
});

describe('FactualityScorer configuration', () => {
  it('uses a stable factuality scorer id by default', () => {
    expect(new FactualityScorer().config.id).toBe('factuality');
  });

  it('uses a deterministic scorer type', () => {
    expect(new FactualityScorer().config.type).toBe('deterministic');
  });

  it('names the scorer factuality', () => {
    expect(new FactualityScorer().config.name).toBe('factuality');
  });

  it('stores the default threshold on config', () => {
    expect(new FactualityScorer().config.threshold).toBe(1);
  });

  it('accepts a custom id', () => {
    expect(new FactualityScorer({ id: 'geo-facts' }).config.id).toBe('geo-facts');
  });

  it('accepts a custom threshold', () => {
    expect(new FactualityScorer({ threshold: 0.75 }).config.threshold).toBe(0.75);
  });

  it('exposes the FactualityEval alias for compatibility', () => {
    expect(FactualityEval).toBe(FactualityScorer);
  });

  it('does not create provider hooks when no hooks are supplied', async () => {
    await expect(new FactualityScorer().extractClaims(makeInput())).resolves.toEqual([]);
  });
});

describe('claim extraction hooks', () => {
  it('passes output text to the extraction hook', async () => {
    const extractClaims = vi.fn().mockReturnValue([claims[0]]);
    const scorer = new FactualityScorer({ extractClaims });
    await scorer.extractClaims(makeInput({ output: 'custom output' }));
    expect(extractClaims).toHaveBeenCalledWith('custom output', expect.objectContaining({ output: 'custom output' }));
  });

  it('returns claims produced by a synchronous hook', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0], claims[1]] });
    await expect(scorer.extractClaims(makeInput())).resolves.toEqual([claims[0], claims[1]]);
  });

  it('returns claims produced by an async hook', async () => {
    const scorer = new FactualityScorer({ extractClaims: async () => [claims[2]] });
    await expect(scorer.extractClaims(makeInput())).resolves.toEqual([claims[2]]);
  });

  it('preserves claim ids from the hook', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]] });
    const extracted = await scorer.extractClaims(makeInput());
    expect(extracted[0]?.id).toBe('claim-1');
  });

  it('preserves claim text from the hook', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [claims[1]] });
    const extracted = await scorer.extractClaims(makeInput());
    expect(extracted[0]?.text).toBe('The Eiffel Tower is in Paris.');
  });

  it('allows empty output without creating a hallucination claim', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [] });
    await expect(scorer.extractClaims(makeInput({ output: '' }))).resolves.toEqual([]);
  });

  it('does not call verification during extraction', async () => {
    const verifyClaims = vi.fn();
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]], verifyClaims });
    await scorer.extractClaims(makeInput());
    expect(verifyClaims).not.toHaveBeenCalled();
  });

  it('calls the extraction hook once per extraction request', async () => {
    const extractClaims = vi.fn().mockReturnValue([claims[0]]);
    const scorer = new FactualityScorer({ extractClaims });
    await scorer.extractClaims(makeInput());
    expect(extractClaims).toHaveBeenCalledTimes(1);
  });

  it('does not mutate reference facts during extraction', async () => {
    const referenceFacts = [...facts];
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]] });
    await scorer.extractClaims(makeInput({ referenceFacts }));
    expect(referenceFacts).toEqual(facts);
  });

  it('uses utf-8 source strings without encoding conversion', async () => {
    const extractClaims = vi.fn().mockReturnValue([{ id: 'claim-utf8', text: 'München is in Germany.' }]);
    const scorer = new FactualityScorer({ extractClaims });
    const extracted = await scorer.extractClaims(makeInput({ output: 'München is in Germany.' }));
    expect(extracted[0]?.text).toBe('München is in Germany.');
  });
});

describe('reference fact verification hooks', () => {
  it('passes claims and reference facts to the verification hook', async () => {
    const verifyClaims = vi.fn().mockReturnValue([resultFor(claims[0], 'verified', ['fact-1'])]);
    const scorer = new FactualityScorer({ verifyClaims });
    await scorer.verifyClaims([claims[0]], [facts[0]], makeInput());
    expect(verifyClaims).toHaveBeenCalledWith([claims[0]], [facts[0]], expect.any(Object));
  });

  it('returns verified claim results from a synchronous hook', async () => {
    const expected = [resultFor(claims[0], 'verified', ['fact-1'])];
    const scorer = new FactualityScorer({ verifyClaims: () => expected });
    await expect(scorer.verifyClaims([claims[0]], facts, makeInput())).resolves.toEqual(expected);
  });

  it('returns unsupported claim results from an async hook', async () => {
    const expected = [resultFor(claims[2], 'unsupported')];
    const scorer = new FactualityScorer({ verifyClaims: async () => expected });
    await expect(scorer.verifyClaims([claims[2]], facts, makeInput())).resolves.toEqual(expected);
  });

  it('returns an empty list when no verification hook exists', async () => {
    await expect(new FactualityScorer().verifyClaims([claims[0]], facts, makeInput())).resolves.toEqual([]);
  });

  it('does not infer support when reference facts are empty', async () => {
    const verifyClaims = vi.fn().mockReturnValue([resultFor(claims[0], 'unsupported')]);
    const scorer = new FactualityScorer({ verifyClaims });
    const verified = await scorer.verifyClaims([claims[0]], [], makeInput({ referenceFacts: [] }));
    expect(verified[0]?.status).toBe('unsupported');
  });

  it('preserves matched reference fact ids', async () => {
    const scorer = new FactualityScorer({ verifyClaims: () => [resultFor(claims[1], 'verified', ['fact-2'])] });
    const verified = await scorer.verifyClaims([claims[1]], facts, makeInput());
    expect(verified[0]?.matchedFactIds).toEqual(['fact-2']);
  });

  it('preserves contradicted status', async () => {
    const scorer = new FactualityScorer({ verifyClaims: () => [resultFor(claims[2], 'contradicted', ['fact-2'])] });
    const verified = await scorer.verifyClaims([claims[2]], facts, makeInput());
    expect(verified[0]?.status).toBe('contradicted');
  });

  it('does not drop duplicate claim results returned by the hook', async () => {
    const duplicate = resultFor(claims[2], 'unsupported');
    const scorer = new FactualityScorer({ verifyClaims: () => [duplicate, duplicate] });
    const verified = await scorer.verifyClaims([claims[2], claims[2]], facts, makeInput());
    expect(verified).toHaveLength(2);
  });

  it('does not mutate claims during verification', async () => {
    const inputClaims = [...claims];
    const scorer = new FactualityScorer({ verifyClaims: () => [resultFor(claims[0], 'verified')] });
    await scorer.verifyClaims(inputClaims, facts, makeInput());
    expect(inputClaims).toEqual(claims);
  });

  it('does not mutate reference facts during verification', async () => {
    const inputFacts = [...facts];
    const scorer = new FactualityScorer({ verifyClaims: () => [resultFor(claims[0], 'verified')] });
    await scorer.verifyClaims(claims, inputFacts, makeInput());
    expect(inputFacts).toEqual(facts);
  });
});

describe('hallucination score bounds', () => {
  it('scores zero hallucination for no claim results', () => {
    expect(new FactualityScorer().scoreHallucination([])).toBe(0);
  });

  it('scores zero hallucination for all verified claims', () => {
    const score = new FactualityScorer().scoreHallucination([
      resultFor(claims[0], 'verified'),
      resultFor(claims[1], 'verified'),
    ]);
    expect(score).toBe(0);
  });

  it('scores one hallucination for all unsupported claims', () => {
    const score = new FactualityScorer().scoreHallucination([
      resultFor(claims[0], 'unsupported'),
      resultFor(claims[1], 'unsupported'),
    ]);
    expect(score).toBe(1);
  });

  it('scores one hallucination for all contradicted claims', () => {
    const score = new FactualityScorer().scoreHallucination([
      resultFor(claims[0], 'contradicted'),
      resultFor(claims[1], 'contradicted'),
    ]);
    expect(score).toBe(1);
  });

  it('scores mixed unsupported claims as a ratio', () => {
    const score = new FactualityScorer().scoreHallucination([
      resultFor(claims[0], 'verified'),
      resultFor(claims[1], 'unsupported'),
    ]);
    expect(score).toBe(0.5);
  });

  it('scores mixed contradicted claims as a ratio', () => {
    const score = new FactualityScorer().scoreHallucination([
      resultFor(claims[0], 'verified'),
      resultFor(claims[1], 'contradicted'),
    ]);
    expect(score).toBe(0.5);
  });

  it('keeps duplicate unsupported claims within the upper bound', () => {
    const duplicate = resultFor(claims[2], 'unsupported');
    expect(new FactualityScorer().scoreHallucination([duplicate, duplicate])).toBe(1);
  });

  it('keeps duplicate contradicted claims within the upper bound', () => {
    const duplicate = resultFor(claims[2], 'contradicted');
    expect(new FactualityScorer().scoreHallucination([duplicate, duplicate])).toBe(1);
  });

  it('never returns below zero', () => {
    const score = new FactualityScorer().scoreHallucination([resultFor(claims[0], 'verified')]);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('never returns above one', () => {
    const score = new FactualityScorer().scoreHallucination([
      resultFor(claims[0], 'unsupported'),
      resultFor(claims[1], 'contradicted'),
      resultFor(claims[2], 'unsupported'),
    ]);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('treats unsupported and contradicted claims equivalently for bounds', () => {
    const score = new FactualityScorer().scoreHallucination([
      resultFor(claims[0], 'unsupported'),
      resultFor(claims[1], 'contradicted'),
      resultFor(claims[2], 'verified'),
    ]);
    expect(score).toBe(2 / 3);
  });

  it('does not penalize empty output when extraction returns no claims', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [], verifyClaims: () => [] });
    const report = await scorer.generateReport(makeInput({ output: '' }));
    expect(report.hallucinationScore).toBe(0);
  });

  it('keeps factuality score at one for no factual claims', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [], verifyClaims: () => [] });
    const report = await scorer.generateReport(makeInput({ output: '' }));
    expect(report.factualityScore).toBe(1);
  });

  it('keeps hallucination and factuality scores complementary', async () => {
    const scorer = new FactualityScorer({
      extractClaims: () => claims,
      verifyClaims: () => [
        resultFor(claims[0], 'verified'),
        resultFor(claims[1], 'unsupported'),
        resultFor(claims[2], 'contradicted'),
      ],
    });
    const report = await scorer.generateReport(makeInput());
    expect(report.factualityScore).toBeCloseTo(1 - report.hallucinationScore);
  });
});

describe('aggregate factuality reporting', () => {
  it('includes all extracted claims in the report', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => claims, verifyClaims: () => [] });
    const report = await scorer.generateReport(makeInput());
    expect(report.claims).toEqual(claims);
  });

  it('includes all reference facts in the report', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [], verifyClaims: () => [] });
    const report = await scorer.generateReport(makeInput());
    expect(report.referenceFacts).toEqual(facts);
  });

  it('includes claim-level results separately from report-level scores', async () => {
    const claimResults = [resultFor(claims[0], 'verified')];
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]], verifyClaims: () => claimResults });
    const report = await scorer.generateReport(makeInput());
    expect(report.claimResults).toEqual(claimResults);
    expect(report.factualityScore).toBe(1);
  });

  it('retains verified claims when one claim fails', async () => {
    const scorer = new FactualityScorer({
      extractClaims: () => claims,
      verifyClaims: () => [
        resultFor(claims[0], 'verified'),
        resultFor(claims[1], 'verified'),
        resultFor(claims[2], 'unsupported'),
      ],
    });
    const report = await scorer.generateReport(makeInput());
    expect(report.verifiedClaims).toHaveLength(2);
  });

  it('separates unsupported claims from verified claims', async () => {
    const scorer = new FactualityScorer({
      extractClaims: () => claims,
      verifyClaims: () => [resultFor(claims[0], 'verified'), resultFor(claims[2], 'unsupported')],
    });
    const report = await scorer.generateReport(makeInput());
    expect(report.unsupportedClaims.map((result) => result.claim.id)).toEqual(['claim-3']);
  });

  it('separates contradicted claims from unsupported claims', async () => {
    const scorer = new FactualityScorer({
      extractClaims: () => claims,
      verifyClaims: () => [resultFor(claims[1], 'unsupported'), resultFor(claims[2], 'contradicted')],
    });
    const report = await scorer.generateReport(makeInput());
    expect(report.contradictedClaims.map((result) => result.claim.id)).toEqual(['claim-3']);
  });

  it('passes when factuality score equals the threshold', async () => {
    const scorer = new FactualityScorer({
      threshold: 0.5,
      extractClaims: () => [claims[0], claims[2]],
      verifyClaims: () => [resultFor(claims[0], 'verified'), resultFor(claims[2], 'unsupported')],
    });
    const report = await scorer.generateReport(makeInput());
    expect(report.passed).toBe(true);
  });

  it('fails when factuality score is below the threshold', async () => {
    const scorer = new FactualityScorer({
      threshold: 0.75,
      extractClaims: () => [claims[0], claims[2]],
      verifyClaims: () => [resultFor(claims[0], 'verified'), resultFor(claims[2], 'unsupported')],
    });
    const report = await scorer.generateReport(makeInput());
    expect(report.passed).toBe(false);
  });

  it('calls extraction before verification when generating a report', async () => {
    const order: string[] = [];
    const scorer = new FactualityScorer({
      extractClaims: () => {
        order.push('extract');
        return [claims[0]];
      },
      verifyClaims: () => {
        order.push('verify');
        return [resultFor(claims[0], 'verified')];
      },
    });
    await scorer.generateReport(makeInput());
    expect(order).toEqual(['extract', 'verify']);
  });

  it('passes extracted claims into verification', async () => {
    const verifyClaims = vi.fn().mockReturnValue([resultFor(claims[0], 'verified')]);
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]], verifyClaims });
    await scorer.generateReport(makeInput());
    expect(verifyClaims.mock.calls[0]?.[0]).toEqual([claims[0]]);
  });

  it('passes reference facts into verification', async () => {
    const verifyClaims = vi.fn().mockReturnValue([resultFor(claims[0], 'verified')]);
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]], verifyClaims });
    await scorer.generateReport(makeInput());
    expect(verifyClaims.mock.calls[0]?.[1]).toEqual(facts);
  });

  it('passes original input into verification', async () => {
    const verifyClaims = vi.fn().mockReturnValue([resultFor(claims[0], 'verified')]);
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]], verifyClaims });
    const input = makeInput({ output: 'Original answer' });
    await scorer.generateReport(input);
    expect(verifyClaims.mock.calls[0]?.[2]).toBe(input);
  });

  it('reports zero claim results when verification returns none', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]], verifyClaims: () => [] });
    const report = await scorer.generateReport(makeInput());
    expect(report.claimResults).toEqual([]);
  });

  it('does not invent verified claims when verification returns none', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]], verifyClaims: () => [] });
    const report = await scorer.generateReport(makeInput());
    expect(report.verifiedClaims).toEqual([]);
  });

  it('counts one failed claim while preserving several verified claims', async () => {
    const scorer = new FactualityScorer({
      extractClaims: () => claims,
      verifyClaims: () => [
        resultFor(claims[0], 'verified'),
        resultFor(claims[1], 'verified'),
        resultFor(claims[2], 'contradicted'),
      ],
    });
    const report = await scorer.generateReport(makeInput());
    expect([report.verifiedClaims.length, report.contradictedClaims.length]).toEqual([2, 1]);
  });

  it('keeps report arrays independent by status', async () => {
    const scorer = new FactualityScorer({
      extractClaims: () => claims,
      verifyClaims: () => [
        resultFor(claims[0], 'verified'),
        resultFor(claims[1], 'unsupported'),
        resultFor(claims[2], 'contradicted'),
      ],
    });
    const report = await scorer.generateReport(makeInput());
    expect(report.verifiedClaims[0]?.status).toBe('verified');
    expect(report.unsupportedClaims[0]?.status).toBe('unsupported');
    expect(report.contradictedClaims[0]?.status).toBe('contradicted');
  });
});

describe('scorer adapter result', () => {
  it('returns the scorer id in the adapter result', async () => {
    const scorer = new FactualityScorer({ id: 'factuality-prod', extractClaims: () => [], verifyClaims: () => [] });
    const result = await scorer.score(makeInput());
    expect(result.scorerId).toBe('factuality-prod');
  });

  it('returns factuality as the aggregate score', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]], verifyClaims: () => [resultFor(claims[0], 'verified')] });
    const result = await scorer.score(makeInput());
    expect(result.aggregateScore).toBe(1);
  });

  it('sets passed from the aggregate report', async () => {
    const scorer = new FactualityScorer({ threshold: 0.75, extractClaims: () => [claims[2]], verifyClaims: () => [resultFor(claims[2], 'unsupported')] });
    const result = await scorer.score(makeInput());
    expect(result.passed).toBe(false);
  });

  it('includes a factuality criterion score', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [], verifyClaims: () => [] });
    const result = await scorer.score(makeInput());
    expect(result.scores.some((score) => score.criterion === 'factuality')).toBe(true);
  });

  it('includes a hallucination criterion score', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [], verifyClaims: () => [] });
    const result = await scorer.score(makeInput());
    expect(result.scores.some((score) => score.criterion === 'hallucination')).toBe(true);
  });

  it('keeps criterion scores within zero and one', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [claims[2]], verifyClaims: () => [resultFor(claims[2], 'unsupported')] });
    const result = await scorer.score(makeInput());
    expect(result.scores.every((score) => score.score >= 0 && score.score <= 1)).toBe(true);
  });

  it('records a non-negative duration', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [], verifyClaims: () => [] });
    const result = await scorer.score(makeInput());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports one verified claim in factuality reasoning', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [claims[0]], verifyClaims: () => [resultFor(claims[0], 'verified')] });
    const result = await scorer.score(makeInput());
    expect(result.scores[0]?.reasoning).toContain('1/1 claims verified');
  });

  it('reports one unsupported claim in hallucination reasoning', async () => {
    const scorer = new FactualityScorer({ extractClaims: () => [claims[2]], verifyClaims: () => [resultFor(claims[2], 'unsupported')] });
    const result = await scorer.score(makeInput());
    expect(result.scores[1]?.reasoning).toContain('1/1 claims unsupported or contradicted');
  });

  it('does not make model or provider calls while scoring', async () => {
    const provider = { call: vi.fn() };
    const scorer = new FactualityScorer({ extractClaims: () => [], verifyClaims: () => [] });
    await scorer.score(makeInput({ metadata: { provider } }));
    expect(provider.call).not.toHaveBeenCalled();
  });

  it('handles a failure followed by a success without retaining stale state', async () => {
    const scorer = new FactualityScorer({
      threshold: 1,
      extractClaims: (output) => output === 'bad' ? [claims[2]] : [claims[0]],
      verifyClaims: (inputClaims) =>
        inputClaims[0]?.id === 'claim-3'
          ? [resultFor(claims[2], 'unsupported')]
          : [resultFor(claims[0], 'verified')],
    });
    const failed = await scorer.score(makeInput({ output: 'bad' }));
    const succeeded = await scorer.score(makeInput({ output: 'good' }));
    expect([failed.passed, succeeded.passed]).toEqual([false, true]);
  });

  it('handles a success followed by a failure without retaining stale state', async () => {
    const scorer = new FactualityScorer({
      threshold: 1,
      extractClaims: (output) => output === 'good' ? [claims[0]] : [claims[2]],
      verifyClaims: (inputClaims) =>
        inputClaims[0]?.id === 'claim-1'
          ? [resultFor(claims[0], 'verified')]
          : [resultFor(claims[2], 'contradicted')],
    });
    const succeeded = await scorer.score(makeInput({ output: 'good' }));
    const failed = await scorer.score(makeInput({ output: 'bad' }));
    expect([succeeded.passed, failed.passed]).toEqual([true, false]);
  });
});
