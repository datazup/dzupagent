import { describe, it, expect } from 'vitest';
import { ExactMatchScorer } from '../../eval/scorers/exact-match.js';

describe('ExactMatchScorer', () => {
  describe('no expected value', () => {
    it('returns pass=false when expected is omitted', async () => {
      const sut = new ExactMatchScorer();
      const result = await sut.score('input', 'actual');
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reasoning).toMatch(/no expected/i);
    });
  });

  describe('case-sensitive (default)', () => {
    it('passes on exact string match', async () => {
      const sut = new ExactMatchScorer();
      const result = await sut.score('q', 'Paris', 'Paris');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('fails on case difference', async () => {
      const sut = new ExactMatchScorer();
      const result = await sut.score('q', 'paris', 'Paris');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });

    it('fails on partial match', async () => {
      const sut = new ExactMatchScorer();
      const result = await sut.score('q', 'Paris, France', 'Paris');
      expect(result.pass).toBe(false);
    });
  });

  describe('case-insensitive option', () => {
    it('passes when strings differ only in case', async () => {
      const sut = new ExactMatchScorer({ caseInsensitive: true });
      const result = await sut.score('q', 'PARIS', 'Paris');
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1.0);
    });
  });

  describe('trim option (default true)', () => {
    it('passes when output has surrounding whitespace', async () => {
      const sut = new ExactMatchScorer();
      const result = await sut.score('q', '  Paris  ', 'Paris');
      expect(result.pass).toBe(true);
    });

    it('fails when trim=false and whitespace differs', async () => {
      const sut = new ExactMatchScorer({ trim: false });
      const result = await sut.score('q', ' Paris', 'Paris');
      expect(result.pass).toBe(false);
    });
  });

  describe('reasoning', () => {
    it('includes the id "exact-match"', () => {
      const sut = new ExactMatchScorer();
      expect(sut.id).toBe('exact-match');
    });

    it('explains the mismatch in reasoning', async () => {
      const sut = new ExactMatchScorer();
      const result = await sut.score('q', 'Berlin', 'Paris');
      expect(result.reasoning).toMatch(/Berlin/);
      expect(result.reasoning).toMatch(/Paris/);
    });
  });
});
