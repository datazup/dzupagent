/**
 * @dzupagent/adapter-rules
 *
 * Canonical rule schema, rule compiler, and rule loader for DzupAgent.
 * Projects one rule model into multiple runtime targets (prompt sections,
 * provider config, watchers, audit flags).
 *
 * See docs/agent-adapters/05-rules-runtime-and-configuration.md for
 * design background.
 */

export * from './types.js'
export { RuleCompiler } from './compiler.js'
export { RuleLoader } from './loader.js'
export {
  projectProviderConfig,
  projectClaudeConfig,
  projectCodexConfig,
  projectCrushConfig,
  projectGeminiConfig,
  projectGooseConfig,
  projectQwenConfig,
  type ProjectorFn,
} from './projectors/index.js'
