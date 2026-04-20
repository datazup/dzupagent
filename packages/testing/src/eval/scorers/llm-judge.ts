/**
 * LlmJudgeScorer — evaluates outputs by asking Claude Haiku to score them.
 *
 * The Anthropic client is injected so tests can stub it without a live API key.
 * In production, pass `new Anthropic()` or let the scorer create one from the
 * ANTHROPIC_API_KEY env var.
 */

import type { EvalScore, EvalScorer } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal interface matching @anthropic-ai/sdk — avoids a hard compile dep.
// ---------------------------------------------------------------------------

interface AnthropicMessageContent {
  type: string;
  text?: string;
}

interface AnthropicMessage {
  content: AnthropicMessageContent[];
}

interface AnthropicMessagesAPI {
  create(params: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: 'user'; content: string }>;
    system?: string;
  }): Promise<AnthropicMessage>;
}

/** Minimal Anthropic client surface consumed by this scorer. */
export interface AnthropicClient {
  messages: AnthropicMessagesAPI;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LlmJudgeOptions {
  /**
   * Anthropic client instance.
   * If omitted the scorer will attempt to lazy-import @anthropic-ai/sdk and
   * create a default client (requires ANTHROPIC_API_KEY in env).
   */
  client?: AnthropicClient;
  /** Claude model to use (default: 'claude-haiku-4-5'). */
  model?: string;
  /**
   * Scoring rubric shown to the judge.
   * Describe what a good answer looks like.
   * Default: "Is the output a correct and complete answer to the input?"
   */
  rubric?: string;
  /** Optional custom scorer id (default: 'llm-judge'). */
  id?: string;
  /** Max tokens for the judge response (default: 512). */
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert evaluator assessing the quality of AI-generated outputs.
Score the output on a scale of 0.0 to 1.0 based on the provided rubric.
Respond with ONLY valid JSON — no prose before or after:
{"score": <number 0.0-1.0>, "pass": <boolean>, "reasoning": "<one sentence>"}`;

/**
 * LlmJudgeScorer — model-graded evaluation using Claude Haiku.
 *
 * Score is the numeric value returned by the judge (clamped to [0, 1]).
 * pass reflects the "pass" field returned by the judge.
 */
export class LlmJudgeScorer implements EvalScorer {
  readonly id: string;
  private readonly model: string;
  private readonly rubric: string;
  private readonly maxTokens: number;
  private readonly clientOverride: AnthropicClient | undefined;

  constructor(options: LlmJudgeOptions = {}) {
    this.id = options.id ?? 'llm-judge';
    this.model = options.model ?? 'claude-haiku-4-5';
    this.rubric =
      options.rubric ?? 'Is the output a correct and complete answer to the input?';
    this.maxTokens = options.maxTokens ?? 512;
    this.clientOverride = options.client;
  }

  async score(input: string, output: string, expected?: string): Promise<EvalScore> {
    const client = this.clientOverride ?? (await this.buildDefaultClient());

    const referenceLine =
      expected !== undefined ? `\nReference answer: ${expected}` : '';

    const userMessage =
      `Rubric: ${this.rubric}\n` +
      `\nInput: ${input}` +
      `\nOutput: ${output}` +
      referenceLine;

    let raw: string;
    try {
      const msg = await client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });
      raw = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
    } catch (err) {
      return {
        score: 0,
        pass: false,
        reasoning: `LLM judge call failed: ${String(err)}`,
      };
    }

    return parseJudgeResponse(raw);
  }

  // --------------------------------------------------------------------------
  // Lazy-load the real SDK when no client override is provided.
  // --------------------------------------------------------------------------

  private async buildDefaultClient(): Promise<AnthropicClient> {
    // Dynamic import keeps @anthropic-ai/sdk as a soft dep — import errors
    // surface only when no stub is provided (i.e. in real use, not tests).
    const { default: Anthropic } = (await import('@anthropic-ai/sdk')) as {
      default: new () => AnthropicClient;
    };
    return new Anthropic();
  }
}

// ---------------------------------------------------------------------------
// Parse the JSON response from the judge model.
// ---------------------------------------------------------------------------

function parseJudgeResponse(raw: string): EvalScore {
  // Tolerate models that wrap JSON in markdown code fences.
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return {
      score: 0,
      pass: false,
      reasoning: `Could not parse judge response: ${raw.slice(0, 120)}`,
    };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return { score: 0, pass: false, reasoning: 'Judge returned non-object JSON' };
  }

  const obj = parsed as Record<string, unknown>;
  const score = typeof obj['score'] === 'number' ? Math.max(0, Math.min(1, obj['score'])) : 0;
  const pass = typeof obj['pass'] === 'boolean' ? obj['pass'] : score >= 0.5;
  const reasoning =
    typeof obj['reasoning'] === 'string' ? obj['reasoning'] : 'No reasoning provided';

  return { score, pass, reasoning };
}
