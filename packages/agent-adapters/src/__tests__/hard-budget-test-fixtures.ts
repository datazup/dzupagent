import type { TokenMeasurementResult } from '@dzupagent/context'
import {
  AdapterHardBudgetHostProfileRegistry,
  OPENAI_RESPONSES_INPUT_TOKEN_PROOF_ID,
  OPENAI_RESPONSES_INPUT_TOKEN_PROOF_REVISION,
  OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT,
  OPENAI_RESPONSES_REQUEST_FORMAT_ID,
  OPENAI_RESPONSES_REQUEST_FORMAT_REVISION,
  type AdapterHardBudgetCounterBinding,
  type AdapterHardBudgetHostProfileDefinition,
} from '../hard-budget.js'

export const FIXTURE_MODEL = 'provider-free-fixture-model'
export const FIXTURE_ENCODING = 'character-v1'

export function fixtureProfile(
  overrides: Partial<AdapterHardBudgetHostProfileDefinition> = {},
): AdapterHardBudgetHostProfileDefinition {
  return {
    schemaVersion: '1',
    id: 'provider-free-openai-fixture',
    revision: '2026-08-01.1',
    provider: 'openai',
    model: FIXTURE_MODEL,
    contextWindowTokens: 2_000,
    reservedOutputTokens: 200,
    reservedSummaryTokens: 40,
    tokenizer: {
      id: 'character-tokenizer',
      revision: '1',
      allowedMethods: ['exact'],
      encoding: FIXTURE_ENCODING,
    },
    requestFormat: {
      id: 'openai-chat-completions-json-fixture',
      revision: '1',
    },
    ...overrides,
  }
}

export function fixtureProofProfile(
  overrides: Partial<AdapterHardBudgetHostProfileDefinition> = {},
): AdapterHardBudgetHostProfileDefinition {
  return fixtureProfile({
    id: 'provider-free-openai-responses-fixture',
    revision: '2026-08-01.2',
    requestFormat: {
      id: OPENAI_RESPONSES_REQUEST_FORMAT_ID,
      revision: OPENAI_RESPONSES_REQUEST_FORMAT_REVISION,
      fingerprint: OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT,
    },
    modelSnapshot: {
      id: `${FIXTURE_MODEL}-snapshot`,
      revision: '2026-08-01.1',
      capturedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
    },
    requestProof: {
      id: OPENAI_RESPONSES_INPUT_TOKEN_PROOF_ID,
      revision: OPENAI_RESPONSES_INPUT_TOKEN_PROOF_REVISION,
      maxAgeMs: 5_000,
    },
    ...overrides,
  })
}

function exactMeasurement(text: string, model: string): TokenMeasurementResult {
  return {
    tokens: text.length,
    method: 'exact',
    model,
    encoding: FIXTURE_ENCODING,
  }
}

export function fixtureBinding(
  overrides: Partial<AdapterHardBudgetCounterBinding> = {},
): AdapterHardBudgetCounterBinding {
  return {
    tokenizerId: 'character-tokenizer',
    tokenizerRevision: '1',
    requestFormatId: 'openai-chat-completions-json-fixture',
    requestFormatRevision: '1',
    contentCounter: {
      count: (text) => text.length,
      countDetailed: (text, model = FIXTURE_MODEL) =>
        exactMeasurement(text, model),
    },
    countRequest: (request) => exactMeasurement(JSON.stringify({
      messages: request.messages,
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice !== undefined
        ? { tool_choice: request.toolChoice }
        : {}),
    }), request.model),
    ...overrides,
  }
}

export function fixtureRegistry(
  definitions: readonly AdapterHardBudgetHostProfileDefinition[] = [
    fixtureProfile(),
  ],
): AdapterHardBudgetHostProfileRegistry {
  return new AdapterHardBudgetHostProfileRegistry(definitions)
}
