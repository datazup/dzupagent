// Mock skill step resolver for skill-chain testing
export { MockSkillStepResolver } from './mock-skill-step-resolver.js';
export type { MockCall } from './mock-skill-step-resolver.js';

// Security testing framework (ECO-183)
export type {
  SecurityCategory,
  SecuritySeverity,
  SecurityExpectedBehavior,
  SecurityTestCase,
  SecurityTestResult,
  SecuritySuiteResult,
  SecurityChecker,
} from './security/security-test-types.js';

export { runSecuritySuite } from './security/security-runner.js';

export { INJECTION_SUITE } from './security/injection-suite.js';
export { ESCALATION_SUITE } from './security/escalation-suite.js';
export { POISONING_SUITE } from './security/poisoning-suite.js';
export { ESCAPE_SUITE } from './security/escape-suite.js';
