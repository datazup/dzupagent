/**
 * Pure analysis routines for convention detection.
 *
 * `analyzeWithHeuristics` runs the static rule set in `convention-heuristics.ts`.
 * `analyzeWithLLM` prompts a configured LLM and parses the response, falling
 * back to heuristics on failure.
 */
import type { DetectedConvention } from './types.js'
import { HEURISTIC_RULES } from './convention-heuristics.js'
import { validateCategory } from './convention-codec.js'
import { clamp, parseLLMJsonArray } from './convention-utils.js'

export function analyzeWithHeuristics(content: string): DetectedConvention[] {
  const detected: DetectedConvention[] = []
  for (const rule of HEURISTIC_RULES) {
    if (rule.test(content)) {
      // Extract a short example from the content
      const regex = new RegExp(rule.pattern)
      const match = regex.exec(content)
      const example = match ? match[0] : ''

      detected.push({
        id: rule.id,
        name: rule.name,
        category: rule.category,
        description: rule.description,
        pattern: rule.pattern,
        examples: example ? [example] : [],
        confidence: 0.6,
        occurrences: 1,
      })
    }
  }
  return detected
}

export async function analyzeWithLLM(
  llm: (prompt: string) => Promise<string>,
  files: Array<{ path: string; content: string }>,
): Promise<DetectedConvention[]> {
  const fileSummaries = files
    .map(f => `--- ${f.path} ---\n${f.content.slice(0, 3000)}`)
    .join('\n\n')

  const prompt = `Analyze the following code files and identify coding conventions used in this project.

For each convention, return a JSON array of objects with these fields:
- id: a kebab-case identifier (e.g., "naming-camelcase-vars")
- name: short human-readable name
- category: one of "naming", "structure", "imports", "error-handling", "typing", "testing", "api", "database", "styling", "general"
- description: one-sentence description
- pattern: optional regex pattern that identifies this convention
- examples: array of 1-3 short code snippets demonstrating it
- confidence: number 0.0-1.0 (how certain you are this is an intentional convention)
- occurrences: estimated count in the provided files

Return ONLY valid JSON array, no markdown fences, no explanation.

Files:
${fileSummaries}`

  try {
    const response = await llm(prompt)
    const parsed = parseLLMJsonArray(response)
    return parsed.map(item => ({
      id: String(item['id'] ?? `convention-${Date.now()}`),
      name: String(item['name'] ?? 'Unknown convention'),
      category: validateCategory(String(item['category'] ?? 'general')),
      description: String(item['description'] ?? ''),
      pattern: item['pattern'] != null ? String(item['pattern']) : undefined,
      examples: Array.isArray(item['examples'])
        ? (item['examples'] as unknown[]).map(e => String(e))
        : [],
      confidence: clamp(Number(item['confidence'] ?? 0.7), 0, 1),
      occurrences: Math.max(1, Math.floor(Number(item['occurrences'] ?? 1))),
    }))
  } catch {
    // Fall back to heuristics on LLM failure
    const allContent = files.map(f => f.content).join('\n')
    return analyzeWithHeuristics(allContent)
  }
}
