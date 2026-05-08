/**
 * PromptOptimizer generator — builds the meta-prompt, parses candidate
 * rewrites out of the LLM response, and provides shared truncation utility.
 */

import type { EvalOutcome } from './prompt-optimizer-types.js';

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Build the meta-prompt sent to the rewriting LLM. Includes the current
 * prompt, scorer averages, and the worst-scoring failures (top 5) so the
 * meta-model can target the actual failure modes.
 */
export function buildMetaPrompt(
  currentPrompt: string,
  outcome: EvalOutcome,
  failures: EvalOutcome['failures'],
  maxCandidates: number,
): string {
  // Format scorer averages
  const scorerLines = Object.entries(outcome.scorerAverages)
    .map(([name, avg]) => `- ${name}: ${avg.toFixed(3)}`)
    .join('\n');

  // Sort failures by score ascending (worst first), take top 5
  const worstFailures = [...failures]
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);

  const failureLines = worstFailures
    .map(
      (f, i) =>
        `### Failure ${i + 1} (score: ${f.score.toFixed(3)})\n` +
        `**Input:** ${truncate(f.input, 500)}\n` +
        `**Output:** ${truncate(f.output, 500)}\n` +
        `**Feedback:** ${truncate(f.feedback, 300)}`,
    )
    .join('\n\n');

  return (
    `You are a prompt engineering expert. Your task is to improve a system prompt based on evaluation results.\n\n` +
    `## Current System Prompt\n${currentPrompt}\n\n` +
    `## Evaluation Scores\n` +
    `- Overall: ${outcome.avgScore.toFixed(3)}/1.0 (${(outcome.passRate * 100).toFixed(0)}% pass rate)\n` +
    `${scorerLines}\n\n` +
    `## Sample Failures (worst scoring)\n${failureLines}\n\n` +
    `## Instructions\n` +
    `Generate ${maxCandidates} improved versions of the system prompt. For each:\n` +
    `1. Identify what went wrong in the failures\n` +
    `2. Add specific instructions to prevent those failure modes\n` +
    `3. Keep what already works well\n` +
    `4. Be concise - don't bloat the prompt unnecessarily\n\n` +
    `Return each candidate as:\n` +
    `### Candidate 1\n` +
    `[reasoning for changes]\n` +
    '```prompt\n' +
    `[the full improved system prompt]\n` +
    '```\n\n' +
    `### Candidate 2\n` +
    `...`
  );
}

/**
 * Parse `### Candidate N` sections out of the meta-model response. Each
 * candidate must contain a fenced code block (optionally tagged `prompt`)
 * with the rewritten prompt.
 */
export function parseCandidates(
  response: string,
  maxCandidates: number,
): Array<{ content: string; reasoning: string }> {
  const candidates: Array<{ content: string; reasoning: string }> = [];

  // Split by "### Candidate N" headers
  const candidatePattern = /###\s*Candidate\s*\d+/gi;
  const sections = response.split(candidatePattern).slice(1); // Skip preamble

  for (const section of sections) {
    if (candidates.length >= maxCandidates) break;

    // Extract prompt from code block
    const promptMatch = /```(?:prompt)?\s*\n([\s\S]*?)```/i.exec(section);
    if (!promptMatch?.[1]) continue;

    const content = promptMatch[1].trim();
    if (content.length === 0) continue;

    // Everything before the code block is reasoning
    const codeBlockStart = section.indexOf('```');
    const reasoning = codeBlockStart > 0
      ? section.slice(0, codeBlockStart).trim()
      : '';

    candidates.push({ content, reasoning });
  }

  return candidates;
}

/**
 * Extract message text from a langchain `BaseMessage.content`, which can be
 * a string or a heterogeneous array of content blocks.
 */
export function extractMessageText(
  content: string | Array<unknown>,
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && 'type' in block && (block as { type: unknown }).type === 'text',
    )
    .map((block) => block.text)
    .join('\n');
}
