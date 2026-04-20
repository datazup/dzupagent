import { describe, it, expect } from 'vitest';
import { RegexScorer } from '../../eval/scorers/regex.js';

describe('RegexScorer', () => {
  describe('string pattern', () => {
    it('passes when output matches string pattern', async () => {
      const sut = new RegexScorer({ pattern: '\\d+' });
      const result = await sut.score('q', 'The answer is 42');
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1.0);
    });

    it('fails when output does not match string pattern', async () => {
      const sut = new RegexScorer({ pattern: '^\\d+$' });
      const result = await sut.score('q', 'not a number');
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0.0);
    });
  });

  describe('RegExp pattern', () => {
    it('passes when output matches RegExp', async () => {
      const sut = new RegexScorer({ pattern: /^Paris$/ });
      const result = await sut.score('q', 'Paris');
      expect(result.pass).toBe(true);
    });

    it('fails when output does not match RegExp', async () => {
      const sut = new RegexScorer({ pattern: /^Paris$/ });
      const result = await sut.score('q', 'Berlin');
      expect(result.pass).toBe(false);
    });
  });

  describe('custom id', () => {
    it('uses default id "regex" when none specified', () => {
      const sut = new RegexScorer({ pattern: /x/ });
      expect(sut.id).toBe('regex');
    });

    it('uses provided id', () => {
      const sut = new RegexScorer({ pattern: /x/, id: 'my-pattern' });
      expect(sut.id).toBe('my-pattern');
    });
  });

  describe('reasoning includes pattern', () => {
    it('mentions the regex in pass reasoning', async () => {
      const sut = new RegexScorer({ pattern: /Paris/ });
      const result = await sut.score('q', 'Paris');
      expect(result.reasoning).toContain('/Paris/');
    });

    it('mentions the regex in fail reasoning', async () => {
      const sut = new RegexScorer({ pattern: /Paris/ });
      const result = await sut.score('q', 'Berlin');
      expect(result.reasoning).toContain('/Paris/');
    });
  });

  describe('flags on RegExp', () => {
    it('respects case-insensitive flag', async () => {
      const sut = new RegexScorer({ pattern: /paris/i });
      const result = await sut.score('q', 'PARIS');
      expect(result.pass).toBe(true);
    });
  });
});
