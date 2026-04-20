// Mock skill step resolver for skill-chain testing
export { MockSkillStepResolver } from './mock-skill-step-resolver.js';
export type { MockCall } from './mock-skill-step-resolver.js';

// LLM recorder — record/replay RegistryMiddleware for deterministic CI
export { LlmRecorder } from './llm-recorder.js';
export type { LlmRecorderOptions, LlmFixture, RecorderMode } from './llm-recorder.js';

// Vitest setup helper
export { withRecordedRegistry } from './vitest-llm-setup.js';
export type { RecordedRegistry } from './vitest-llm-setup.js';

// Eval framework — scorers + suite runner
export type {
  EvalScore,
  EvalScorer,
  EvalCase,
  EvalSuite,
  EvalCaseResult,
  EvalRunResult,
} from './eval/index.js';

export { ExactMatchScorer } from './eval/index.js';
export type { ExactMatchOptions } from './eval/index.js';

export { RegexScorer } from './eval/index.js';
export type { RegexScorerOptions } from './eval/index.js';

export { LlmJudgeScorer } from './eval/index.js';
export type { AnthropicClient, LlmJudgeOptions } from './eval/index.js';

export { runEvalSuite } from './eval/index.js';
export { createDemoEvalSuite, buildStubAnthropicClient } from './eval/index.js';

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
