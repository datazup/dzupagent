/**
 * Pure conformance-check routines.
 *
 * `checkWithHeuristics` runs each convention's regex against the input.
 * `checkWithLLM` asks a configured LLM to evaluate the code, falling back
 * to heuristics on failure.
 */
import type { ConventionCheckResult, DetectedConvention } from './types.js'
import { parseLLMJsonObject } from './convention-utils.js'

export function checkWithHeuristics(
  code: string,
  conventions: DetectedConvention[],
): ConventionCheckResult {
  const followed: ConventionCheckResult['followed'] = []
  const violated: ConventionCheckResult['violated'] = []

  for (const conv of conventions) {
    if (!conv.pattern) continue

    try {
      const regex = new RegExp(conv.pattern)
      if (regex.test(code)) {
        followed.push({ convention: conv, evidence: `Pattern "${conv.pattern}" matched` })
      } else {
        violated.push({
          convention: conv,
          evidence: `Pattern "${conv.pattern}" not found in code`,
          suggestion: `Consider following convention: ${conv.description}`,
        })
      }
    } catch {
      // Invalid regex — skip this convention
    }
  }

  const total = followed.length + violated.length
  const conformanceScore = total === 0 ? 1.0 : followed.length / total

  return { conformanceScore, followed, violated }
}

export async function checkWithLLM(
  llm: (prompt: string) => Promise<string>,
  code: string,
  conventions: DetectedConvention[],
): Promise<ConventionCheckResult> {
  const conventionList = conventions
    .map(c => `- ${c.name} (${c.category}): ${c.description}`)
    .join('\n')

  const prompt = `Check if the following code follows these project conventions:

Conventions:
${conventionList}

Code:
${code.slice(0, 5000)}

For each convention, determine if it is followed or violated.
Return a JSON object with:
- followed: array of { conventionId: string, evidence: string }
- violated: array of { conventionId: string, evidence: string, suggestion: string }

Return ONLY valid JSON, no markdown fences.`

  try {
    const response = await llm(prompt)
    const parsed = parseLLMJsonObject(response)
    const conventionMap = new Map(conventions.map(c => [c.id, c]))

    const followedRaw = Array.isArray(parsed['followed']) ? parsed['followed'] as unknown[] : []
    const violatedRaw = Array.isArray(parsed['violated']) ? parsed['violated'] as unknown[] : []

    const followedResults: ConventionCheckResult['followed'] = []
    const violatedResults: ConventionCheckResult['violated'] = []

    for (const item of followedRaw) {
      const obj = item as Record<string, unknown>
      const conv = conventionMap.get(String(obj['conventionId'] ?? ''))
      if (conv) {
        followedResults.push({ convention: conv, evidence: String(obj['evidence'] ?? '') })
      }
    }

    for (const item of violatedRaw) {
      const obj = item as Record<string, unknown>
      const conv = conventionMap.get(String(obj['conventionId'] ?? ''))
      if (conv) {
        violatedResults.push({
          convention: conv,
          evidence: String(obj['evidence'] ?? ''),
          suggestion: String(obj['suggestion'] ?? ''),
        })
      }
    }

    const total = followedResults.length + violatedResults.length
    const conformanceScore = total === 0 ? 1.0 : followedResults.length / total

    return { conformanceScore, followed: followedResults, violated: violatedResults }
  } catch {
    // Fall back to heuristic check on LLM failure
    return checkWithHeuristics(code, conventions)
  }
}
