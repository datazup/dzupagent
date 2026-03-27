/**
 * NL2SQL toolkit — factory functions for creating all NL2SQL tools.
 *
 * Tools are organized into tiers:
 * - Core (6): The essential NL2SQL pipeline tools
 * - Extended (10): Core + classification, ambiguity, chart, decomposition
 * - Full (15): All tools including entity tracking, model routing, multi-agent, etc.
 */

import type { DynamicStructuredTool } from '@langchain/core/tools'
import type { NL2SQLToolkitConfig } from '../types/index.js'

// --- Individual tool factory re-exports ---
export { createSchemaRetrievalTool } from './tool-schema-retrieval.js'
export { createColumnPruneTool } from './tool-column-prune.js'
export { createSQLGenerateTool } from './tool-sql-generate.js'
export { createValidateSafetyTool } from './tool-validate-safety.js'
export { createValidateStructureTool } from './tool-validate-structure.js'
export { createExecuteQueryTool } from './tool-execute-query.js'
export { createClassifyRelevanceTool } from './tool-classify-relevance.js'
export { createDetectAmbiguityTool } from './tool-detect-ambiguity.js'
export { createEntityTrackerTool } from './tool-entity-tracker.js'
export { createModelRouterTool } from './tool-model-router.js'
export { createMultiAgentGenerateTool } from './tool-multi-agent-generate.js'
export { createResponseSynthesizerTool } from './tool-response-synthesizer.js'
export { createResultValidatorTool } from './tool-result-validator.js'
export { createConfidenceScorerTool } from './tool-confidence-scorer.js'

// --- Toolkit factory: core 6 tools ---
import { createSchemaRetrievalTool } from './tool-schema-retrieval.js'
import { createColumnPruneTool } from './tool-column-prune.js'
import { createSQLGenerateTool } from './tool-sql-generate.js'
import { createValidateSafetyTool } from './tool-validate-safety.js'
import { createValidateStructureTool } from './tool-validate-structure.js'
import { createExecuteQueryTool } from './tool-execute-query.js'

// --- Extended tools ---
import { createClassifyRelevanceTool } from './tool-classify-relevance.js'
import { createDetectAmbiguityTool } from './tool-detect-ambiguity.js'

// --- Full tools ---
import { createEntityTrackerTool } from './tool-entity-tracker.js'
import { createModelRouterTool } from './tool-model-router.js'
import { createMultiAgentGenerateTool } from './tool-multi-agent-generate.js'
import { createResponseSynthesizerTool } from './tool-response-synthesizer.js'
import { createResultValidatorTool } from './tool-result-validator.js'
import { createConfidenceScorerTool } from './tool-confidence-scorer.js'

/**
 * Core 6-tool NL2SQL toolkit: retrieve → prune → generate → validate → execute.
 */
export function createCoreToolkit(config: NL2SQLToolkitConfig): DynamicStructuredTool[] {
  return [
    createSchemaRetrievalTool(config),
    createColumnPruneTool(config),
    createSQLGenerateTool(config),
    createValidateSafetyTool(config),
    createValidateStructureTool(config),
    createExecuteQueryTool(config),
  ]
}

/**
 * Extended 10-tool toolkit: core + classification, ambiguity, response, confidence.
 */
export function createExtendedToolkit(config: NL2SQLToolkitConfig): DynamicStructuredTool[] {
  return [
    ...createCoreToolkit(config),
    createClassifyRelevanceTool(config),
    createDetectAmbiguityTool(config),
    createResponseSynthesizerTool(config),
    createConfidenceScorerTool(config),
  ]
}

/**
 * Full 14-tool toolkit: all NL2SQL tools including entity tracking,
 * model routing, multi-agent generation, and result validation.
 */
export function createFullToolkit(config: NL2SQLToolkitConfig): DynamicStructuredTool[] {
  return [
    ...createExtendedToolkit(config),
    createEntityTrackerTool(config),
    createModelRouterTool(config),
    createMultiAgentGenerateTool(config),
    createResultValidatorTool(config),
  ]
}
