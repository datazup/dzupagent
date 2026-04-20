/**
 * Demo eval suite — exercises all three scorers without live LLM calls.
 *
 * The LLM-judge slot is wired to a stub client so the suite can run in CI
 * without an API key.  Replace `stubClient` with `new Anthropic()` for a
 * real-model evaluation.
 */

import type { EvalSuite } from './types.js';
import { ExactMatchScorer } from './scorers/exact-match.js';
import { RegexScorer } from './scorers/regex.js';
import { LlmJudgeScorer } from './scorers/llm-judge.js';
import type { AnthropicClient } from './scorers/llm-judge.js';

// ---------------------------------------------------------------------------
// Stub client — returns a passing judge response without a real API call.
// ---------------------------------------------------------------------------

/** Build an Anthropic client stub that always returns a canned judge verdict. */
export function buildStubAnthropicClient(
  override: Partial<{ score: number; pass: boolean; reasoning: string }> = {},
): AnthropicClient {
  const response = {
    score: override.score ?? 0.9,
    pass: override.pass ?? true,
    reasoning: override.reasoning ?? 'The answer is correct and complete.',
  };

  return {
    messages: {
      async create() {
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Demo suite factory
// ---------------------------------------------------------------------------

/**
 * createDemoEvalSuite — builds a self-contained suite that demonstrates each
 * scorer type.  The target function is a simple echo/lookup so the suite
 * is fully deterministic.
 *
 * @param judgeClient Optional Anthropic client.  Defaults to a stub.
 */
export function createDemoEvalSuite(judgeClient?: AnthropicClient): EvalSuite {
  const answers: Record<string, string> = {
    'capital of France': 'Paris',
    'capital of Germany': 'Berlin',
    'add 2 + 2': '4',
    'greet in JSON': '{"greeting": "hello"}',
  };

  const target = async (input: string): Promise<string> => {
    return answers[input] ?? 'unknown';
  };

  return {
    name: 'demo-eval-suite',
    target,
    passThreshold: 0.7,
    scorers: [
      new ExactMatchScorer({ caseInsensitive: true }),
      new RegexScorer({ pattern: /^[A-Za-z0-9 {},":]+$/, id: 'alphanumeric-only' }),
      new LlmJudgeScorer({
        client: judgeClient ?? buildStubAnthropicClient(),
        rubric: 'Is the output a correct, concise answer to the question?',
      }),
    ],
    cases: [
      {
        id: 'capital-france',
        input: 'capital of France',
        expected: 'Paris',
      },
      {
        id: 'capital-germany',
        input: 'capital of Germany',
        expected: 'Berlin',
      },
      {
        id: 'addition',
        input: 'add 2 + 2',
        expected: '4',
      },
      {
        id: 'json-greeting',
        input: 'greet in JSON',
        // expected matches the target's literal output string exactly
        expected: '{"greeting": "hello"}',
      },
    ],
  };
}
