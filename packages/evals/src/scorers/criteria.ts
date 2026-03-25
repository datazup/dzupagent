/**
 * A single criterion for LLM judge evaluation.
 */
export interface JudgeCriterion {
  name: string;
  description: string;
  weight?: number;
}

/**
 * Standard criteria for general text evaluation.
 */
export const STANDARD_CRITERIA: JudgeCriterion[] = [
  { name: 'relevance', description: 'How relevant is the output to the input?', weight: 0.3 },
  { name: 'accuracy', description: 'How accurate is the output?', weight: 0.4 },
  { name: 'completeness', description: 'How complete is the response?', weight: 0.3 },
];

/**
 * Criteria for evaluating code generation output.
 */
export const CODE_CRITERIA: JudgeCriterion[] = [
  { name: 'correctness', weight: 0.4, description: 'Does the code work correctly?' },
  { name: 'readability', weight: 0.2, description: 'Is the code readable?' },
  { name: 'efficiency', weight: 0.2, description: 'Is the code efficient?' },
  { name: 'best-practices', weight: 0.2, description: 'Does it follow best practices?' },
];

/**
 * Five-point rubric description for LLM judges.
 */
export const FIVE_POINT_RUBRIC = '1=Poor, 2=Below Average, 3=Average, 4=Good, 5=Excellent';

/**
 * Ten-point rubric description for LLM judges.
 */
export const TEN_POINT_RUBRIC = '1-3=Poor, 4-5=Below Average, 6-7=Average, 8-9=Good, 10=Excellent';
