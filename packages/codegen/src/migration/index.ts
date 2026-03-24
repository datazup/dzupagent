/**
 * Migration module — cross-framework migration planning and prompt generation.
 */
export {
  getMigrationPlan,
  analyzeMigrationScope,
  buildMigrationPrompt,
} from './migration-planner.js'
export type {
  MigrationTarget,
  MigrationStep,
  MigrationPlan,
} from './migration-planner.js'
