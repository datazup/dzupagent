/**
 * create-forgeagent — CLI scaffold engine for ForgeAgent projects.
 *
 * Provides template-based project generation with variable interpolation.
 */

// --- Types ---
export type {
  TemplateType,
  ScaffoldOptions,
  ScaffoldResult,
  TemplateManifest,
} from './types.js'

// --- Engine ---
export { ScaffoldEngine } from './scaffold-engine.js'

// --- Renderer ---
export { renderTemplate } from './template-renderer.js'

// --- Templates ---
export {
  templateRegistry,
  getTemplate,
  listTemplates,
  minimalTemplate,
  fullStackTemplate,
  codegenTemplate,
  multiAgentTemplate,
  serverTemplate,
} from './templates/index.js'
