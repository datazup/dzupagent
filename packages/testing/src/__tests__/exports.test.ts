import { describe, it, expect } from 'vitest';
import * as testingPkg from '../index.js';
import * as securityPkg from '../security/index.js';

// ---------------------------------------------------------------------------
// Top-level package exports
// ---------------------------------------------------------------------------

describe('Package exports — @dzupagent/testing', () => {
  it('should export MockSkillStepResolver class', () => {
    expect(testingPkg.MockSkillStepResolver).toBeDefined();
    expect(typeof testingPkg.MockSkillStepResolver).toBe('function');
  });

  it('should export runSecuritySuite function', () => {
    expect(testingPkg.runSecuritySuite).toBeDefined();
    expect(typeof testingPkg.runSecuritySuite).toBe('function');
  });

  it('should export INJECTION_SUITE array', () => {
    expect(testingPkg.INJECTION_SUITE).toBeDefined();
    expect(Array.isArray(testingPkg.INJECTION_SUITE)).toBe(true);
    expect(testingPkg.INJECTION_SUITE.length).toBeGreaterThan(0);
  });

  it('should export ESCALATION_SUITE array', () => {
    expect(testingPkg.ESCALATION_SUITE).toBeDefined();
    expect(Array.isArray(testingPkg.ESCALATION_SUITE)).toBe(true);
    expect(testingPkg.ESCALATION_SUITE.length).toBeGreaterThan(0);
  });

  it('should export POISONING_SUITE array', () => {
    expect(testingPkg.POISONING_SUITE).toBeDefined();
    expect(Array.isArray(testingPkg.POISONING_SUITE)).toBe(true);
    expect(testingPkg.POISONING_SUITE.length).toBeGreaterThan(0);
  });

  it('should export ESCAPE_SUITE array', () => {
    expect(testingPkg.ESCAPE_SUITE).toBeDefined();
    expect(Array.isArray(testingPkg.ESCAPE_SUITE)).toBe(true);
    expect(testingPkg.ESCAPE_SUITE.length).toBeGreaterThan(0);
  });

  it('should export exactly the expected named exports', () => {
    const exportNames = Object.keys(testingPkg).sort();
    expect(exportNames).toEqual([
      'ESCALATION_SUITE',
      'ESCAPE_SUITE',
      'INJECTION_SUITE',
      'MockSkillStepResolver',
      'POISONING_SUITE',
      'runSecuritySuite',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Security sub-package exports
// ---------------------------------------------------------------------------

describe('Package exports — security/index', () => {
  it('should export runSecuritySuite', () => {
    expect(securityPkg.runSecuritySuite).toBeDefined();
    expect(typeof securityPkg.runSecuritySuite).toBe('function');
  });

  it('should export all four suites', () => {
    expect(securityPkg.INJECTION_SUITE).toBeDefined();
    expect(securityPkg.ESCALATION_SUITE).toBeDefined();
    expect(securityPkg.POISONING_SUITE).toBeDefined();
    expect(securityPkg.ESCAPE_SUITE).toBeDefined();
  });

  it('security suites should be the same references as top-level exports', () => {
    expect(securityPkg.INJECTION_SUITE).toBe(testingPkg.INJECTION_SUITE);
    expect(securityPkg.ESCALATION_SUITE).toBe(testingPkg.ESCALATION_SUITE);
    expect(securityPkg.POISONING_SUITE).toBe(testingPkg.POISONING_SUITE);
    expect(securityPkg.ESCAPE_SUITE).toBe(testingPkg.ESCAPE_SUITE);
  });

  it('runSecuritySuite should be the same reference', () => {
    expect(securityPkg.runSecuritySuite).toBe(testingPkg.runSecuritySuite);
  });
});

// ---------------------------------------------------------------------------
// MockSkillStepResolver instantiation via export
// ---------------------------------------------------------------------------

describe('MockSkillStepResolver — instantiation via export', () => {
  it('should create a new instance with empty calls', () => {
    const resolver = new testingPkg.MockSkillStepResolver();
    expect(resolver.calls).toEqual([]);
  });

  it('should support registerText and resolve through the exported class', async () => {
    const resolver = new testingPkg.MockSkillStepResolver();
    resolver.registerText('hello', 'world');
    const step = await resolver.resolve('hello');
    const result = await step.execute({});
    expect(result).toEqual({ hello: 'world' });
  });
});
