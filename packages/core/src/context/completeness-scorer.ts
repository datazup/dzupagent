/**
 * Scores the completeness of a feature/task description.
 * Used to determine whether clarification questions are needed.
 *
 * Score 0.0-1.0:
 *   > 0.8 = skip clarification, proceed to planning
 *   0.5-0.8 = ask 2-3 targeted questions
 *   < 0.5 = full clarification (5-7 questions)
 */

export interface DescriptionInput {
  name: string
  description: string
  category?: string
  tags?: string[]
  techStack?: Record<string, string>
  scope?: string[]
}

export interface CompletenessResult {
  score: number
  maxQuestions: number
  reasoning: string[]
}

export function scoreCompleteness(input: DescriptionInput): CompletenessResult {
  let score = 0
  const reasoning: string[] = []

  // Name quality (0-0.05)
  if (input.name && input.name.length > 3) {
    score += 0.05
    reasoning.push('Name provided')
  }

  // Description length (0-0.25)
  const descLen = input.description?.length ?? 0
  if (descLen > 200) {
    score += 0.25
    reasoning.push('Detailed description (200+ chars)')
  } else if (descLen > 100) {
    score += 0.15
    reasoning.push('Moderate description (100+ chars)')
  } else if (descLen > 30) {
    score += 0.05
    reasoning.push('Brief description')
  }

  // Entity mentions -- look for specific nouns that indicate clear requirements
  const entityPatterns = [
    /\b(?:user|admin|role|permission|team|member)\b/i,
    /\b(?:create|read|update|delete|list|search|filter|paginate)\b/i,
    /\b(?:api|endpoint|route|webhook|controller|service)\b/i,
    /\b(?:table|model|schema|field|column|relation)\b/i,
    /\b(?:component|page|view|form|modal|dialog)\b/i,
    /\b(?:auth|login|register|password|token|session)\b/i,
    /\b(?:email|notification|message|alert)\b/i,
    /\b(?:upload|file|image|attachment|storage)\b/i,
  ]
  const entityCount = entityPatterns.filter(p => p.test(input.description)).length
  const entityScore = Math.min(entityCount * 0.05, 0.2)
  score += entityScore
  if (entityCount > 0) reasoning.push(`${entityCount} entity types mentioned`)

  // Tech stack specified (0-0.15)
  if (input.techStack && Object.keys(input.techStack).length >= 3) {
    score += 0.15
    reasoning.push('Tech stack specified')
  } else if (input.techStack && Object.keys(input.techStack).length > 0) {
    score += 0.05
    reasoning.push('Partial tech stack')
  }

  // Category specified (0-0.05)
  if (input.category) {
    score += 0.05
    reasoning.push('Category specified')
  }

  // Scope specified (0-0.1)
  if (input.scope && input.scope.length > 0) {
    score += 0.1
    reasoning.push(`Scope: ${input.scope.join(', ')}`)
  }

  // Tags provided (0-0.05)
  if (input.tags && input.tags.length >= 2) {
    score += 0.05
    reasoning.push('Tags provided')
  }

  // Constraint language -- specific requirements mentioned (0-0.1)
  const constraintPatterns = [
    /\b(?:must|should|require|need|support)\b/i,
    /\b(?:max|min|limit|at least|at most|up to)\b/i,
    /\b(?:only|never|always|forbidden|prohibited)\b/i,
  ]
  const constraintCount = constraintPatterns.filter(p => p.test(input.description)).length
  if (constraintCount >= 2) {
    score += 0.1
    reasoning.push('Specific constraints mentioned')
  } else if (constraintCount === 1) {
    score += 0.05
    reasoning.push('Some constraints mentioned')
  }

  // Clamp to 0-1
  score = Math.min(Math.max(score, 0), 1)

  // Determine max questions
  let maxQuestions: number
  if (score > 0.8) {
    maxQuestions = 0 // Skip clarification
  } else if (score > 0.5) {
    maxQuestions = 3 // Targeted questions only
  } else {
    maxQuestions = 7 // Full clarification
  }

  return { score, maxQuestions, reasoning }
}
