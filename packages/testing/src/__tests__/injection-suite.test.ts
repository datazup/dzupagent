import { describe, it, expect } from 'vitest';
import { INJECTION_SUITE } from '../security/injection-suite.js';
import type { SecurityTestCase } from '../security/security-test-types.js';

describe('INJECTION_SUITE — test case content validation', () => {
  it('should contain cases for all major injection techniques', () => {
    const techniques = INJECTION_SUITE.map(
      (tc) => (tc.metadata as Record<string, unknown>)?.['technique'],
    );
    expect(techniques).toContain('direct-override');
    expect(techniques).toContain('role-play');
    expect(techniques).toContain('delimiter');
    expect(techniques).toContain('indirect-data');
    expect(techniques).toContain('encoding-evasion');
  });

  it('should have all IDs prefixed with "inj-"', () => {
    for (const tc of INJECTION_SUITE) {
      expect(tc.id).toMatch(/^inj-\d+$/);
    }
  });

  it('should have category set to "injection" for every case', () => {
    for (const tc of INJECTION_SUITE) {
      expect(tc.category).toBe('injection');
    }
  });

  it('should have at least one baseline (safe) test case', () => {
    const baselines = INJECTION_SUITE.filter(
      (tc) => tc.expectedBehavior === 'safe',
    );
    expect(baselines.length).toBeGreaterThanOrEqual(1);
  });

  it('should have at least one critical severity case', () => {
    const criticals = INJECTION_SUITE.filter(
      (tc) => tc.severity === 'critical',
    );
    expect(criticals.length).toBeGreaterThanOrEqual(1);
  });

  it('should have non-empty input strings for every case', () => {
    for (const tc of INJECTION_SUITE) {
      expect(tc.input.length).toBeGreaterThan(10);
    }
  });

  it('direct-override case should use critical severity', () => {
    const directOverride = INJECTION_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] ===
        'direct-override',
    );
    expect(directOverride).toBeDefined();
    expect(directOverride!.severity).toBe('critical');
    expect(directOverride!.expectedBehavior).toBe('block');
  });

  it('baseline case should use low severity and safe behavior', () => {
    const baseline = INJECTION_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] === 'baseline',
    );
    expect(baseline).toBeDefined();
    expect(baseline!.severity).toBe('low');
    expect(baseline!.expectedBehavior).toBe('safe');
  });

  it('encoding evasion case should include encoding type in metadata', () => {
    const encodingCase = INJECTION_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] ===
        'encoding-evasion',
    );
    expect(encodingCase).toBeDefined();
    expect(
      (encodingCase!.metadata as Record<string, unknown>)?.['encoding'],
    ).toBe('base64');
  });

  it('multi-language case should include language in metadata', () => {
    const multiLang = INJECTION_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] ===
        'multi-language',
    );
    expect(multiLang).toBeDefined();
    expect(
      (multiLang!.metadata as Record<string, unknown>)?.['language'],
    ).toBeTruthy();
  });

  it('should not have duplicate names', () => {
    const names = INJECTION_SUITE.map((tc) => tc.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should have descriptions that differ from names', () => {
    for (const tc of INJECTION_SUITE) {
      expect(tc.description).not.toBe(tc.name);
      expect(tc.description.length).toBeGreaterThan(tc.name.length);
    }
  });
});
