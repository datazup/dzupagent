/**
 * LLM Provider Contract Suite — conformance tests for LLM provider adapters.
 *
 * Tests verify the BaseChatModel-like interface contract used by DzipAgent.
 * These tests use lightweight operations to avoid expensive LLM calls in CI.
 */

import { ContractSuiteBuilder, timedTest } from '../contract-test-generator.js';
import type { ContractSuite } from '../contract-types.js';

// ---------------------------------------------------------------------------
// Minimal interface shape
// ---------------------------------------------------------------------------

interface LLMMessage {
  role?: string;
  content: string;
  _getType?: () => string;
}

interface LLMResponse {
  content: string;
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  tool_calls?: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
}

interface LLMProviderShape {
  invoke(messages: LLMMessage[]): Promise<LLMResponse>;
  stream?(messages: LLMMessage[]): AsyncIterable<{ content: string }>;
  bindTools?(tools: Array<{ name: string; description: string; schema: unknown }>): LLMProviderShape;
}

function asLLMProvider(adapter: unknown): LLMProviderShape {
  return adapter as LLMProviderShape;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export function createLLMProviderContract(): ContractSuite {
  const builder = new ContractSuiteBuilder('llm-provider', 'LLM Provider Contract')
    .description('Conformance tests for LLM provider adapter implementations');

  // --- Required ---

  builder.required(
    'invoke-returns-response',
    'Invoke returns response',
    'invoke() accepts messages and returns a response with content',
    async (adapter) =>
      timedTest(async () => {
        const llm = asLLMProvider(adapter);

        const response = await llm.invoke([
          { content: 'Reply with exactly the word: OK', role: 'user' },
        ]);

        if (response === null || response === undefined) {
          return { passed: false, error: 'invoke() returned null/undefined' };
        }

        if (typeof response.content !== 'string') {
          return { passed: false, error: 'response.content must be a string' };
        }

        if (response.content.length === 0) {
          return { passed: false, error: 'response.content is empty' };
        }

        return { passed: true, details: { contentLength: response.content.length } };
      }),
  );

  builder.required(
    'invoke-handles-system-message',
    'System message handling',
    'invoke() correctly processes system messages alongside user messages',
    async (adapter) =>
      timedTest(async () => {
        const llm = asLLMProvider(adapter);

        const response = await llm.invoke([
          { content: 'You are a helpful assistant.', role: 'system' },
          { content: 'Reply with exactly: HELLO', role: 'user' },
        ]);

        if (typeof response.content !== 'string' || response.content.length === 0) {
          return { passed: false, error: 'Response content must be a non-empty string' };
        }

        return { passed: true };
      }),
  );

  builder.required(
    'invoke-error-handling',
    'Error handling',
    'invoke() throws or returns an error for invalid input rather than hanging',
    async (adapter) =>
      timedTest(async () => {
        const llm = asLLMProvider(adapter);

        // Empty messages array — should either throw or return a response
        try {
          const response = await llm.invoke([]);
          // If it does not throw, response should still be valid
          if (response !== null && response !== undefined) {
            return { passed: true, details: { behavior: 'returned-response-for-empty-input' } };
          }
          return { passed: true, details: { behavior: 'returned-null-for-empty-input' } };
        } catch {
          // Throwing is acceptable behavior for invalid input
          return { passed: true, details: { behavior: 'threw-for-empty-input' } };
        }
      }),
  );

  // --- Recommended ---

  builder.recommended(
    'token-usage-metadata',
    'Token usage metadata',
    'Response includes token usage information',
    async (adapter) =>
      timedTest(async () => {
        const llm = asLLMProvider(adapter);

        const response = await llm.invoke([
          { content: 'Say hello', role: 'user' },
        ]);

        const usage = response.usage_metadata;
        if (!usage) {
          return { passed: false, error: 'response.usage_metadata is missing' };
        }

        if (typeof usage.input_tokens !== 'number') {
          return { passed: false, error: 'usage_metadata.input_tokens must be a number' };
        }

        if (typeof usage.output_tokens !== 'number') {
          return { passed: false, error: 'usage_metadata.output_tokens must be a number' };
        }

        return {
          passed: true,
          details: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
          },
        };
      }),
  );

  builder.recommended(
    'streaming-support',
    'Streaming support',
    'stream() returns an async iterable of content chunks',
    async (adapter) =>
      timedTest(async () => {
        const llm = asLLMProvider(adapter);

        if (typeof llm.stream !== 'function') {
          return { passed: false, error: 'stream() method is not implemented' };
        }

        const chunks: string[] = [];
        const stream = llm.stream([
          { content: 'Say the word hello', role: 'user' },
        ]);

        for await (const chunk of stream) {
          if (typeof chunk.content === 'string') {
            chunks.push(chunk.content);
          }
        }

        if (chunks.length === 0) {
          return { passed: false, error: 'stream() produced no chunks' };
        }

        return { passed: true, details: { chunkCount: chunks.length } };
      }),
  );

  builder.recommended(
    'tool-binding',
    'Tool binding',
    'bindTools() returns a model that can invoke tools',
    async (adapter) =>
      timedTest(async () => {
        const llm = asLLMProvider(adapter);

        if (typeof llm.bindTools !== 'function') {
          return { passed: false, error: 'bindTools() method is not implemented' };
        }

        const toolDef = {
          name: 'get_weather',
          description: 'Get the current weather for a location',
          schema: {
            type: 'object' as const,
            properties: {
              location: { type: 'string', description: 'City name' },
            },
            required: ['location'],
          },
        };

        const bound = llm.bindTools([toolDef]);
        if (!bound) {
          return { passed: false, error: 'bindTools() returned null/undefined' };
        }

        // Verify the bound model is still invocable
        if (typeof bound.invoke !== 'function') {
          return { passed: false, error: 'bindTools() result must have invoke()' };
        }

        return { passed: true };
      }),
  );

  // --- Optional ---

  builder.optional(
    'multi-turn-context',
    'Multi-turn context',
    'invoke() maintains context across multiple messages in a single call',
    async (adapter) =>
      timedTest(async () => {
        const llm = asLLMProvider(adapter);

        const response = await llm.invoke([
          { content: 'My name is ContractTestBot.', role: 'user' },
          { content: 'Nice to meet you, ContractTestBot!', role: 'assistant' },
          { content: 'What is my name?', role: 'user' },
        ]);

        const hasName = response.content.toLowerCase().includes('contracttestbot');
        if (!hasName) {
          return {
            passed: false,
            error: 'Model did not recall the name from context',
            details: { response: response.content },
          };
        }

        return { passed: true };
      }),
  );

  builder.optional(
    'tool-call-format',
    'Tool call format',
    'When tool-bound, model returns properly formatted tool_calls',
    async (adapter) =>
      timedTest(async () => {
        const llm = asLLMProvider(adapter);

        if (typeof llm.bindTools !== 'function') {
          return { passed: false, error: 'bindTools() not implemented — skipping' };
        }

        const bound = llm.bindTools([
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            schema: {
              type: 'object' as const,
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
            },
          },
        ]);

        const response = await bound.invoke([
          { content: 'What is the weather in Paris?', role: 'user' },
        ]);

        if (!response.tool_calls || response.tool_calls.length === 0) {
          return {
            passed: false,
            error: 'Expected tool_calls in response',
            details: { response: response.content },
          };
        }

        const call = response.tool_calls[0]!;
        if (typeof call.name !== 'string') {
          return { passed: false, error: 'tool_call.name must be a string' };
        }

        return { passed: true, details: { toolName: call.name } };
      }),
  );

  return builder.build();
}

/** Pre-built LLM Provider contract suite */
export const LLM_PROVIDER_CONTRACT = createLLMProviderContract();
