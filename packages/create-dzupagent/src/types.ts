/**
 * Supported scaffold template types.
 */
export type TemplateType =
  | 'minimal'
  | 'full-stack'
  | 'codegen'
  | 'multi-agent'
  | 'server'
  | 'production-saas-agent'
  | 'secure-internal-assistant'
  | 'cost-constrained-worker'
  | 'research'

/**
 * Options passed to the scaffold engine.
 */
export interface ScaffoldOptions {
  projectName: string
  template: TemplateType
  features?: string[]
  outputDir: string
}

/**
 * Result returned after scaffolding completes.
 */
export interface ScaffoldResult {
  filesCreated: string[]
  projectDir: string
  template: TemplateType
}

/**
 * Describes a template's file structure and dependencies.
 */
export interface TemplateManifest {
  id: TemplateType
  name: string
  description: string
  files: Array<{ path: string; templateContent: string }>
  dependencies: Record<string, string>
  devDependencies?: Record<string, string>
  /** Available feature slugs for this template */
  availableFeatures?: string[]
}

/**
 * Feature definition for overlay selection.
 */
export interface FeatureDefinition {
  slug: string
  name: string
  description: string
  /** Additional dependencies this feature introduces */
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  /** Files to overlay onto the project */
  files?: Array<{ path: string; templateContent: string }>
  /** Environment variables required by this feature */
  envVars?: Array<{ key: string; defaultValue: string; description: string }>
}

/**
 * Configuration gathered by the wizard or CLI args.
 */
export interface ProjectConfig {
  projectName: string
  template: TemplateType
  features: string[]
  preset?: PresetName
  database: DatabaseProvider
  authProvider: AuthProvider
  packageManager: PackageManagerType
  initGit: boolean
  installDeps: boolean
  /** Marketplace API URL (optional) */
  marketplaceUrl?: string
}

/**
 * Database provider selection.
 */
export type DatabaseProvider = 'postgres' | 'sqlite' | 'none'

/**
 * Auth provider selection.
 */
export type AuthProvider = 'api-key' | 'jwt' | 'none'

/**
 * Supported package managers.
 */
export type PackageManagerType = 'npm' | 'yarn' | 'pnpm'

/**
 * Built-in preset names.
 */
export type PresetName = 'minimal' | 'starter' | 'full' | 'api-only' | 'research'

/**
 * Template metadata from the marketplace API.
 */
export interface MarketplaceTemplate {
  slug: string
  name: string
  description: string
  features: string[]
}

/**
 * Result of the full project generation pipeline.
 */
export interface GenerationResult {
  projectDir: string
  filesCreated: string[]
  template: TemplateType
  features: string[]
  packageManager: PackageManagerType
  gitInitialized: boolean
  depsInstalled: boolean
  /** Whether the project was wired into the agent-adapters runtime. */
  wired: boolean
}
