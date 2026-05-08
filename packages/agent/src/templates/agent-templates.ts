/**
 * Pre-built agent templates for common use cases.
 *
 * Templates define the configuration shape for an agent but do NOT instantiate
 * one — the consumer is responsible for resolving model instances and tool
 * implementations based on the `modelTier` and `suggestedTools` hints.
 *
 * This file is a thin re-export barrel. Implementations live in:
 *  - agent-templates-types.ts  (AgentTemplate, AgentTemplateCategory)
 *  - agent-templates-code.ts   (code-category templates)
 *  - agent-templates-data.ts   (data-category templates)
 *  - agent-templates-ops.ts    (infrastructure / content / research / automation)
 */

import type { AgentTemplate } from './agent-templates-types.js'
import { CODE_TEMPLATES } from './agent-templates-code.js'
import { DATA_TEMPLATES } from './agent-templates-data.js'
import { OPS_TEMPLATES } from './agent-templates-ops.js'

// Re-export types
export type { AgentTemplate, AgentTemplateCategory } from './agent-templates-types.js'

// Re-export individual templates for convenient direct imports
export {
  bugFixer,
  codeGenerator,
  codeReviewer,
  CODE_TEMPLATES,
  migrationAgent,
  refactoringSpecialist,
  securityAuditor,
  testWriter,
} from './agent-templates-code.js'
export {
  dataAnalyst,
  DATA_TEMPLATES,
  etlPipelineBuilder,
  schemaDesigner,
} from './agent-templates-data.js'
export {
  apiDocGenerator,
  AUTOMATION_TEMPLATES,
  changelogWriter,
  ciCdBuilder,
  competitiveAnalyst,
  CONTENT_TEMPLATES,
  devopsEngineer,
  INFRASTRUCTURE_TEMPLATES,
  literatureReviewer,
  monitoringSpecialist,
  notificationManager,
  OPS_TEMPLATES,
  reportGenerator,
  RESEARCH_TEMPLATES,
  technicalWriter,
  technologyScout,
  workflowAutomator,
} from './agent-templates-ops.js'

// ---------------------------------------------------------------------------
// All templates list (preserves original ordering)
// ---------------------------------------------------------------------------

/** All built-in agent templates in a flat array. */
export const ALL_AGENT_TEMPLATES: readonly AgentTemplate[] = [
  ...CODE_TEMPLATES,
  ...DATA_TEMPLATES,
  ...OPS_TEMPLATES,
] as const

// ---------------------------------------------------------------------------
// Legacy record-based registry (backward compat)
// ---------------------------------------------------------------------------

/** All built-in agent templates, keyed by template ID. */
export const AGENT_TEMPLATES: Readonly<Record<string, AgentTemplate>> = Object.fromEntries(
  ALL_AGENT_TEMPLATES.map(t => [t.id, t]),
)

/**
 * Get a template by ID.
 *
 * @param id - The template identifier (e.g. `'code-reviewer'`).
 * @returns The matching `AgentTemplate`, or `undefined` if not found.
 */
export function getAgentTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES[id]
}

/**
 * List all available template IDs.
 *
 * @returns An array of template identifier strings.
 */
export function listAgentTemplates(): string[] {
  return Object.keys(AGENT_TEMPLATES)
}
