/**
 * Data-category agent templates.
 */
import type { AgentTemplate } from './agent-templates-types.js'

export const dataAnalyst: AgentTemplate = {
  id: 'data-analyst',
  name: 'Data Analyst',
  description: 'Explores, analyzes, and visualizes data from various sources.',
  category: 'data',
  instructions: [
    'You are a data analyst.',
    'Connect to data sources, explore schemas, write SQL queries, perform statistical',
    'analysis, and generate insights.',
    'Present findings with clear explanations.',
    'Always use parameterized queries.',
    'Default to read-only operations unless explicitly told to modify data.',
  ].join(' '),
  modelTier: 'balanced',
  suggestedTools: ['db_query', 'read_file', 'write_file'],
  guardrails: { maxTokens: 100_000, maxCostCents: 50, maxIterations: 15 },
  tags: ['data', 'analytics', 'sql', 'visualization'],
}

export const etlPipelineBuilder: AgentTemplate = {
  id: 'etl-pipeline-builder',
  name: 'ETL Pipeline Builder',
  description: 'Designs and implements extract-transform-load data pipelines.',
  category: 'data',
  instructions: [
    'You are an ETL pipeline specialist.',
    'Design data pipelines that extract from source systems, transform data using',
    'validated schemas, and load into target destinations.',
    'Handle schema evolution, null values, and type coercion gracefully.',
    'Implement idempotent operations and proper error recovery.',
    'Document data lineage and transformation logic.',
  ].join(' '),
  modelTier: 'balanced',
  suggestedTools: ['read_file', 'write_file', 'db_query', 'execute_command'],
  guardrails: { maxTokens: 120_000, maxCostCents: 60, maxIterations: 20 },
  tags: ['etl', 'data-pipeline', 'data-engineering', 'transformation'],
}

export const schemaDesigner: AgentTemplate = {
  id: 'schema-designer',
  name: 'Schema Designer',
  description: 'Designs database schemas, migrations, and data models for relational and NoSQL stores.',
  category: 'data',
  instructions: [
    'You are a database schema designer.',
    'Design normalized database schemas with appropriate indexes, constraints, and',
    'relationships. Generate migration scripts that are safe to run in production.',
    'Consider query patterns, data volumes, and access control requirements.',
    'Follow naming conventions and enforce referential integrity.',
    'Always include rollback migrations alongside forward migrations.',
  ].join(' '),
  modelTier: 'balanced',
  suggestedTools: ['read_file', 'write_file', 'db_query', 'search_code'],
  guardrails: { maxTokens: 80_000, maxCostCents: 40, maxIterations: 10 },
  tags: ['database', 'schema', 'migrations', 'data-modeling'],
}

/** All data-category templates. */
export const DATA_TEMPLATES: readonly AgentTemplate[] = [
  dataAnalyst,
  etlPipelineBuilder,
  schemaDesigner,
] as const
