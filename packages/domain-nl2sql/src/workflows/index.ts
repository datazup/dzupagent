/**
 * Pre-built NL2SQL workflow configurations.
 *
 * These define the step sequences for deterministic and supervisor-based
 * NL2SQL pipelines. They are designed to be used with DzipAgent's
 * WorkflowBuilder or AgentOrchestrator.
 *
 * Usage with WorkflowBuilder:
 *   const steps = createDeterministicSteps(config)
 *   const workflow = createWorkflow({ id: 'nl2sql' })
 *     .then(steps.classify)
 *     .branch(state => state.isRelevant ? 'generate' : 'reject', {
 *       generate: [steps.retrieveSchema, steps.generateSQL, steps.validate, steps.execute],
 *       reject: [steps.rejectIrrelevant]
 *     })
 *     .build()
 *
 * Usage with AgentOrchestrator.supervisor:
 *   const agents = createSupervisorAgents(config)
 *   await AgentOrchestrator.supervisor({
 *     manager: agents.manager,
 *     specialists: [agents.schemaExpert, agents.sqlWriter, agents.executor],
 *     task: userQuery
 *   })
 */

import type { NL2SQLToolkitConfig, NL2SQLResult } from '../types/index.js'
import {
  createClassifyRelevanceTool,
  createDetectAmbiguityTool,
  createSchemaRetrievalTool,
  createColumnPruneTool,
  createSQLGenerateTool,
  createValidateSafetyTool,
  createValidateStructureTool,
  createExecuteQueryTool,
  createResponseSynthesizerTool,
  createConfidenceScorerTool,
  createResultValidatorTool,
  createEntityTrackerTool,
} from '../tools/index.js'
import type { DynamicStructuredTool } from '@langchain/core/tools'

/**
 * Step definitions for the deterministic NL2SQL workflow.
 * Each step wraps a tool invocation with state management.
 */
export interface NL2SQLWorkflowSteps {
  /** Track entities in conversation for pronoun resolution */
  trackEntities: DynamicStructuredTool
  /** Classify if query is a data question */
  classify: DynamicStructuredTool
  /** Detect ambiguous terms */
  detectAmbiguity: DynamicStructuredTool
  /** Retrieve relevant schema via vector/keyword search */
  retrieveSchema: DynamicStructuredTool
  /** Prune irrelevant columns */
  pruneColumns: DynamicStructuredTool
  /** Generate SQL from schema + question */
  generateSQL: DynamicStructuredTool
  /** Validate SQL safety (no destructive ops) */
  validateSafety: DynamicStructuredTool
  /** Validate SQL structure (table references) */
  validateStructure: DynamicStructuredTool
  /** Execute SQL on target database */
  executeQuery: DynamicStructuredTool
  /** Validate result plausibility */
  validateResult: DynamicStructuredTool
  /** Score confidence */
  scoreConfidence: DynamicStructuredTool
  /** Synthesize natural language response */
  synthesizeResponse: DynamicStructuredTool
}

/**
 * Creates all tool instances for the deterministic workflow.
 */
export function createWorkflowSteps(config: NL2SQLToolkitConfig): NL2SQLWorkflowSteps {
  return {
    trackEntities: createEntityTrackerTool(config),
    classify: createClassifyRelevanceTool(config),
    detectAmbiguity: createDetectAmbiguityTool(config),
    retrieveSchema: createSchemaRetrievalTool(config),
    pruneColumns: createColumnPruneTool(config),
    generateSQL: createSQLGenerateTool(config),
    validateSafety: createValidateSafetyTool(config),
    validateStructure: createValidateStructureTool(config),
    executeQuery: createExecuteQueryTool(config),
    validateResult: createResultValidatorTool(config),
    scoreConfidence: createConfidenceScorerTool(config),
    synthesizeResponse: createResponseSynthesizerTool(config),
  }
}

/**
 * Deterministic NL2SQL workflow definition.
 *
 * Flow:
 *   trackEntities → classify
 *     → (irrelevant) → return rejection
 *     → (relevant) → retrieveSchema → pruneColumns → detectAmbiguity
 *       → (ambiguous) → return clarification
 *       → (clear) → generateSQL → validateSafety → validateStructure
 *         → (invalid) → retry generation (up to maxRetries)
 *         → (valid) → executeQuery → validateResult → scoreConfidence → synthesizeResponse
 */
export const DETERMINISTIC_WORKFLOW = {
  id: 'nl2sql-deterministic',
  name: 'Deterministic NL2SQL Pipeline',
  description: 'Fixed-topology pipeline: classify → retrieve → generate → validate → execute → respond',
  steps: [
    'trackEntities',
    'classify',
    'retrieveSchema',
    'pruneColumns',
    'detectAmbiguity',
    'generateSQL',
    'validateSafety',
    'validateStructure',
    'executeQuery',
    'validateResult',
    'scoreConfidence',
    'synthesizeResponse',
  ] as const,
  branches: {
    afterClassify: { relevant: 'retrieveSchema', irrelevant: 'REJECT' },
    afterAmbiguity: { clear: 'generateSQL', ambiguous: 'CLARIFY' },
    afterValidation: { valid: 'executeQuery', invalid: 'RETRY_GENERATE' },
  },
} as const

/**
 * Supervisor NL2SQL workflow definition.
 *
 * The manager agent coordinates three specialists:
 * 1. Schema Expert: finds + prunes relevant schema
 * 2. SQL Writer: generates + validates SQL
 * 3. Query Executor: executes + synthesizes response
 */
export const SUPERVISOR_WORKFLOW = {
  id: 'nl2sql-supervisor',
  name: 'Supervisor NL2SQL Pipeline',
  description: 'Dynamic orchestration: manager delegates to schema-expert, sql-writer, query-executor',
  managerInstructions: `You are the NL2SQL Manager. Coordinate these specialists to answer data questions:

1. First, use classify-relevance to check if the question is about data.
   - If NOT relevant: respond with a polite rejection explaining what you can help with.

2. If relevant, call Schema Expert to find the relevant schema.

3. Use detect-ambiguity to check for unclear terms.
   - If ambiguous: return the clarification request. STOP.

4. If clear, call SQL Writer with the schema and question.

5. Call Query Executor with the generated SQL.

6. Return the final results to the user.

Rules:
- Always follow the steps in order.
- Pass schema context between specialists.
- If any specialist reports an error, explain it clearly.
- Keep your own commentary minimal — let the specialists do the work.`,
  specialists: ['schema-expert', 'sql-writer', 'query-executor'] as const,
} as const

/**
 * Creates an empty NL2SQLResult with defaults.
 */
export function createEmptyResult(): NL2SQLResult {
  return {
    sql: null,
    explanation: null,
    result: null,
    chartRecommendation: null,
    isRelevant: true,
    isAmbiguous: false,
    clarificationRequest: null,
    confidenceScore: null,
    confidenceLabel: null,
    confidenceScorecard: null,
    structuredExplanation: null,
    error: null,
    tablesUsed: [],
    reasoningTrace: null,
  }
}
