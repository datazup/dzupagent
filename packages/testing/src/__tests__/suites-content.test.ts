import { describe, it, expect } from 'vitest';
import { POISONING_SUITE } from '../security/poisoning-suite.js';
import { ESCALATION_SUITE } from '../security/escalation-suite.js';
import { ESCAPE_SUITE } from '../security/escape-suite.js';
import type { SecurityTestCase } from '../security/security-test-types.js';

// ---------------------------------------------------------------------------
// POISONING_SUITE
// ---------------------------------------------------------------------------

describe('POISONING_SUITE — content validation', () => {
  it('should have all IDs prefixed with "psn-"', () => {
    for (const tc of POISONING_SUITE) {
      expect(tc.id).toMatch(/^psn-\d+$/);
    }
  });

  it('should have category set to "poisoning" for every case', () => {
    for (const tc of POISONING_SUITE) {
      expect(tc.category).toBe('poisoning');
    }
  });

  it('should include a false fact injection case', () => {
    const falseFact = POISONING_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] === 'false-fact',
    );
    expect(falseFact).toBeDefined();
    expect(falseFact!.expectedBehavior).toBe('block');
  });

  it('should include an instruction planting case with critical severity', () => {
    const planting = POISONING_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] ===
        'instruction-planting',
    );
    expect(planting).toBeDefined();
    expect(planting!.severity).toBe('critical');
    expect(planting!.expectedBehavior).toBe('block');
  });

  it('should include a memory overflow case with payload metadata', () => {
    const overflow = POISONING_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] ===
        'memory-overflow',
    );
    expect(overflow).toBeDefined();
    expect(
      (overflow!.metadata as Record<string, unknown>)?.['payloadSize'],
    ).toBe('large');
    expect(overflow!.input.length).toBeGreaterThan(200);
  });

  it('should have a baseline case that expects safe behavior', () => {
    const baseline = POISONING_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] === 'baseline',
    );
    expect(baseline).toBeDefined();
    expect(baseline!.expectedBehavior).toBe('safe');
    expect(baseline!.severity).toBe('low');
  });

  it('should not have duplicate IDs', () => {
    const ids = POISONING_SUITE.map((tc) => tc.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// ESCALATION_SUITE
// ---------------------------------------------------------------------------

describe('ESCALATION_SUITE — content validation', () => {
  it('should have all IDs prefixed with "esc-"', () => {
    for (const tc of ESCALATION_SUITE) {
      expect(tc.id).toMatch(/^esc-\d+$/);
    }
  });

  it('should have category set to "escalation" for every case', () => {
    for (const tc of ESCALATION_SUITE) {
      expect(tc.category).toBe('escalation');
    }
  });

  it('should include a role claim case', () => {
    const roleClaim = ESCALATION_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] === 'role-claim',
    );
    expect(roleClaim).toBeDefined();
    expect(roleClaim!.severity).toBe('critical');
    expect(roleClaim!.expectedBehavior).toBe('block');
  });

  it('should include a cross-tenant access case with critical severity', () => {
    const crossTenant = ESCALATION_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] ===
        'cross-tenant',
    );
    expect(crossTenant).toBeDefined();
    expect(crossTenant!.severity).toBe('critical');
  });

  it('should include a tool abuse case referencing shell', () => {
    const toolAbuse = ESCALATION_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] === 'tool-abuse',
    );
    expect(toolAbuse).toBeDefined();
    expect(
      (toolAbuse!.metadata as Record<string, unknown>)?.['targetTool'],
    ).toBe('shell');
  });

  it('should include an environment variable extraction case', () => {
    const envExtraction = ESCALATION_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] ===
        'env-extraction',
    );
    expect(envExtraction).toBeDefined();
    expect(envExtraction!.severity).toBe('high');
    expect(envExtraction!.expectedBehavior).toBe('block');
  });

  it('should have a baseline safe case', () => {
    const baseline = ESCALATION_SUITE.find(
      (tc) => tc.expectedBehavior === 'safe',
    );
    expect(baseline).toBeDefined();
    expect(baseline!.severity).toBe('low');
  });

  it('should not have duplicate IDs', () => {
    const ids = ESCALATION_SUITE.map((tc) => tc.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// ESCAPE_SUITE
// ---------------------------------------------------------------------------

describe('ESCAPE_SUITE — content validation', () => {
  it('should have all IDs prefixed with "esc-s-"', () => {
    for (const tc of ESCAPE_SUITE) {
      expect(tc.id).toMatch(/^esc-s-\d+$/);
    }
  });

  it('should have category set to "escape" for every case', () => {
    for (const tc of ESCAPE_SUITE) {
      expect(tc.category).toBe('escape');
    }
  });

  it('should include a path traversal case targeting /etc/passwd', () => {
    const pathTraversal = ESCAPE_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] ===
        'path-traversal',
    );
    expect(pathTraversal).toBeDefined();
    expect(pathTraversal!.severity).toBe('critical');
    expect(
      (pathTraversal!.metadata as Record<string, unknown>)?.['target'],
    ).toBe('/etc/passwd');
  });

  it('should include a command injection case', () => {
    const cmdInjection = ESCAPE_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] ===
        'command-injection',
    );
    expect(cmdInjection).toBeDefined();
    expect(cmdInjection!.severity).toBe('critical');
    expect(cmdInjection!.expectedBehavior).toBe('block');
  });

  it('should include a network exfiltration case', () => {
    const netExfil = ESCAPE_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] ===
        'network-exfiltration',
    );
    expect(netExfil).toBeDefined();
    expect(netExfil!.expectedBehavior).toBe('block');
  });

  it('should include a symlink exploitation case', () => {
    const symlink = ESCAPE_SUITE.find(
      (tc) =>
        (tc.metadata as Record<string, unknown>)?.['technique'] === 'symlink',
    );
    expect(symlink).toBeDefined();
    expect(symlink!.severity).toBe('high');
  });

  it('should have a baseline safe case', () => {
    const baseline = ESCAPE_SUITE.find(
      (tc) => tc.expectedBehavior === 'safe',
    );
    expect(baseline).toBeDefined();
    expect(baseline!.severity).toBe('low');
  });

  it('should not have duplicate IDs', () => {
    const ids = ESCAPE_SUITE.map((tc) => tc.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should not have duplicate names', () => {
    const names = ESCAPE_SUITE.map((tc) => tc.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// Cross-suite validation
// ---------------------------------------------------------------------------

describe('Cross-suite validation', () => {
  const allSuites: SecurityTestCase[] = [
    ...POISONING_SUITE,
    ...ESCALATION_SUITE,
    ...ESCAPE_SUITE,
  ];

  it('should have globally unique IDs across all three suites', () => {
    const ids = allSuites.map((tc) => tc.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every suite should include at least one baseline/safe case', () => {
    const poisoningSafe = POISONING_SUITE.filter(
      (tc) => tc.expectedBehavior === 'safe',
    );
    const escalationSafe = ESCALATION_SUITE.filter(
      (tc) => tc.expectedBehavior === 'safe',
    );
    const escapeSafe = ESCAPE_SUITE.filter(
      (tc) => tc.expectedBehavior === 'safe',
    );
    expect(poisoningSafe.length).toBeGreaterThanOrEqual(1);
    expect(escalationSafe.length).toBeGreaterThanOrEqual(1);
    expect(escapeSafe.length).toBeGreaterThanOrEqual(1);
  });

  it('every suite should include at least one critical or high severity case', () => {
    const hasCriticalOrHigh = (suite: SecurityTestCase[]) =>
      suite.some(
        (tc) => tc.severity === 'critical' || tc.severity === 'high',
      );

    expect(hasCriticalOrHigh(POISONING_SUITE)).toBe(true);
    expect(hasCriticalOrHigh(ESCALATION_SUITE)).toBe(true);
    expect(hasCriticalOrHigh(ESCAPE_SUITE)).toBe(true);
  });

  it('all cases should have metadata defined', () => {
    for (const tc of allSuites) {
      expect(tc.metadata).toBeDefined();
      expect(typeof tc.metadata).toBe('object');
    }
  });

  it('all cases should have a technique in metadata', () => {
    for (const tc of allSuites) {
      expect(
        (tc.metadata as Record<string, unknown>)?.['technique'],
      ).toBeTruthy();
    }
  });
});
