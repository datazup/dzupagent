/**
 * @dzupagent/test-utils — Testing utilities for DzupAgent.
 *
 * Provides: MockChatModel, LLMRecorder, test helpers.
 * Zero network dependencies — all tests run offline.
 */

export { MockChatModel } from './mock-model.js'
export type { MockResponse } from './mock-model.js'

export { LLMRecorder } from './llm-recorder.js'
export type { RecorderConfig, RecorderMode, Fixture } from './llm-recorder.js'

export {
  createTestEventBus,
  createTestRunStore,
  createTestAgentStore,
  createTestAgent,
  createTestConfig,
  waitForEvent,
  waitForCondition,
} from './test-helpers.js'

export const dzupagent_TEST_UTILS_VERSION = '0.1.0'
