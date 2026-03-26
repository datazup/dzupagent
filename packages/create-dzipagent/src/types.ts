/**
 * Supported scaffold template types.
 */
export type TemplateType = 'minimal' | 'full-stack' | 'codegen' | 'multi-agent' | 'server' | 'production-saas-agent' | 'secure-internal-assistant' | 'cost-constrained-worker'

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
}
