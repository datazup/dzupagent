/**
 * @dzupagent/test-utils — Testing utilities for DzupAgent.
 *
 * @deprecated
 * This package is a compatibility shim. Canonical shared test infrastructure
 * now lives in `@dzupagent/testing`. Prefer importing from there for:
 *   - LlmRecorder (ModelRegistry RegistryMiddleware)
 *   - withRecordedRegistry (vitest setup helper)
 *   - MockSkillStepResolver
 *   - Eval framework (ExactMatchScorer, RegexScorer, LlmJudgeScorer, runEvalSuite)
 *   - Security suites (INJECTION_SUITE, ESCALATION_SUITE, POISONING_SUITE, ESCAPE_SUITE)
 *
 * Exports that remain canonical in this package (no equivalent in @dzupagent/testing):
 *   - MockChatModel (LangChain BaseChatModel mock)
 *   - LLMRecorder (wraps LangChain BaseChatModel for record/replay)
 *   - createExpressRouteHarness and related types (Express route testing)
 *   - describeMcpPublisherCompatibilitySuite and related types (MCP protocol testing)
 *   - createTestEventBus, createTestRunStore, createTestAgentStore,
 *     createTestAgent, createTestConfig, waitForEvent, waitForCondition
 */

// ---------------------------------------------------------------------------
// Own exports — infrastructure-level utilities (LangChain, Express, MCP)
// ---------------------------------------------------------------------------

export { MockChatModel } from './mock-model.js'
export type { MockResponse } from './mock-model.js'

export { LLMRecorder } from './llm-recorder.js'
export type { RecorderConfig, Fixture } from './llm-recorder.js'
// RecorderMode is also exported from @dzupagent/testing (different type — 'record'|'replay'
// vs 'record'|'replay'|'passthrough'). Aliased here to avoid ambiguity for consumers that
// import both packages.
export type { RecorderMode as LLMRecorderMode } from './llm-recorder.js'

export {
  createTestEventBus,
  createTestRunStore,
  createTestAgentStore,
  createTestAgent,
  createTestConfig,
  waitForEvent,
  waitForCondition,
} from './test-helpers.js'
export {
  createExpressRouteHarness,
} from './express-route-harness.js'
export type {
  ExpressRouteDispatchInput,
  ExpressRouteHarness,
  ExpressRouteHarnessResponse,
  ExpressRouteHarnessState,
} from './express-route-harness.js'
export {
  describeMcpPublisherCompatibilitySuite,
} from './mcp-compatibility.js'
export type {
  McpCompatibilityCaseName,
  McpCompatibilityHarness,
  McpCompatibilityResponse,
  McpCompatibilityToolCallCase,
  McpPublisherCompatibilitySuiteOptions,
} from './mcp-compatibility.js'

// ---------------------------------------------------------------------------
// Re-exports from @dzupagent/testing (canonical shared test infrastructure)
// New code should import directly from @dzupagent/testing.
// ---------------------------------------------------------------------------

export { MockSkillStepResolver } from '@dzupagent/testing'
export type { MockCall } from '@dzupagent/testing'

export { LlmRecorder, withRecordedRegistry } from '@dzupagent/testing'
export type {
  LlmRecorderOptions,
  LlmFixture,
  RecorderMode,
  RecordedRegistry,
} from '@dzupagent/testing'

export type {
  EvalScore,
  EvalScorer,
  EvalCase,
  EvalSuite,
  EvalCaseResult,
  EvalRunResult,
} from '@dzupagent/testing'

export {
  ExactMatchScorer,
  RegexScorer,
  LlmJudgeScorer,
  runEvalSuite,
  createDemoEvalSuite,
  buildStubAnthropicClient,
} from '@dzupagent/testing'
export type {
  ExactMatchOptions,
  RegexScorerOptions,
  AnthropicClient,
  LlmJudgeOptions,
} from '@dzupagent/testing'

export type {
  SecurityCategory,
  SecuritySeverity,
  SecurityExpectedBehavior,
  SecurityTestCase,
  SecurityTestResult,
  SecuritySuiteResult,
  SecurityChecker,
} from '@dzupagent/testing'

export {
  runSecuritySuite,
  INJECTION_SUITE,
  ESCALATION_SUITE,
  POISONING_SUITE,
  ESCAPE_SUITE,
} from '@dzupagent/testing'

export const dzupagent_TEST_UTILS_VERSION = '0.2.0'
