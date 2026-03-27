/**
 * create-forgeagent — CLI scaffold engine for ForgeAgent projects.
 *
 * Provides template-based project generation with variable interpolation,
 * interactive wizard, presets, and feature overlays.
 */

// --- Types ---
export type {
  TemplateType,
  ScaffoldOptions,
  ScaffoldResult,
  TemplateManifest,
  FeatureDefinition,
  ProjectConfig,
  GenerationResult,
  DatabaseProvider,
  AuthProvider,
  PackageManagerType,
  PresetName,
  MarketplaceTemplate,
} from './types.js'

// --- Engine (legacy) ---
export { ScaffoldEngine } from './scaffold-engine.js'

// --- Generator (new) ---
export { generateProject } from './generator.js'
export type { GenerateCallbacks } from './generator.js'

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

// --- Presets ---
export { presets, getPreset, listPresets, PRESET_NAMES } from './presets.js'
export type { PresetConfig } from './presets.js'

// --- Features ---
export { getFeatureOverlay, listFeatures, getFeatureSlugs } from './features.js'

// --- Utils ---
export {
  validateProjectName,
  detectPackageManager,
  runCommand,
  installDependencies,
  initGitRepo,
  applyOverlay,
  fetchMarketplaceTemplates,
  getInstallCommand,
  getDevCommand,
} from './utils.js'

// --- Template generators ---
export { generateEnvExample } from './templates/env-example.js'
export { generateDockerCompose } from './templates/docker-compose.js'
export { generateReadme } from './templates/readme.js'
export { generatePackageJson } from './templates/package-json.js'

// --- Wizard ---
export { runWizard } from './wizard.js'
