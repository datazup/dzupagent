/**
 * Types for the Architecture Guardrail Engine.
 *
 * Defines rules, contexts, results, and violations used to validate
 * generated code against architectural constraints.
 */
import type { RepoMap } from '../repomap/repo-map-builder.js'

export type GuardrailCategory =
  | 'layering'
  | 'naming'
  | 'imports'
  | 'patterns'
  | 'security'
  | 'contracts'
  | 'file-structure'

export type GuardrailSeverity = 'error' | 'warning' | 'info'

/**
 * A single generated file with path and content.
 */
export interface GeneratedFile {
  path: string
  content: string
}

/**
 * Describes the project structure for layering/import checks.
 */
export interface ProjectStructure {
  /** Package names mapped to their directory paths */
  packages: Map<string, PackageInfo>
  /** Root directory of the project */
  rootDir: string
}

export interface PackageInfo {
  name: string
  dir: string
  /** Packages this package is allowed to depend on */
  allowedDependencies: string[]
  /** Public entry points (e.g., ['index.ts']) */
  entryPoints: string[]
}

/**
 * Conventions to enforce, typically learned from existing code.
 */
export interface ConventionSet {
  /** File naming pattern (e.g., 'kebab-case', 'camelCase', 'PascalCase') */
  fileNaming: FileNamingPattern
  /** Export naming: classes/interfaces should be PascalCase */
  exportNaming: ExportNamingPattern
  /** Import conventions */
  importStyle: ImportStylePattern
  /** Required patterns in generated code */
  requiredPatterns: RequiredPattern[]
}

export type FileNamingPattern = 'kebab-case' | 'camelCase' | 'PascalCase' | 'snake_case'

export interface ExportNamingPattern {
  classCase: 'PascalCase'
  functionCase: 'camelCase' | 'PascalCase'
  constCase: 'UPPER_SNAKE' | 'camelCase' | 'PascalCase'
}

export interface ImportStylePattern {
  /** Only import from package index, not internal paths */
  indexOnly: boolean
  /** Use 'import type' for type-only imports */
  separateTypeImports: boolean
}

export interface RequiredPattern {
  name: string
  description: string
  /** Regex pattern that must match in certain file types */
  pattern: RegExp
  /** File glob patterns this applies to */
  fileGlobs: string[]
}

/**
 * Context passed to each guardrail rule check.
 */
export interface GuardrailContext {
  files: GeneratedFile[]
  projectStructure: ProjectStructure
  conventions: ConventionSet
  repoMap?: RepoMap
}

/**
 * A single violation found by a guardrail rule.
 */
export interface GuardrailViolation {
  ruleId: string
  file: string
  line?: number
  message: string
  severity: GuardrailSeverity
  suggestion?: string
  autoFixable: boolean
  fix?: () => string
}

/**
 * Result of running a single guardrail rule.
 */
export interface GuardrailResult {
  passed: boolean
  violations: GuardrailViolation[]
}

/**
 * A guardrail rule definition.
 */
export interface GuardrailRule {
  id: string
  name: string
  description: string
  severity: GuardrailSeverity
  category: GuardrailCategory
  check: (context: GuardrailContext) => GuardrailResult
}

/**
 * Aggregate result of running all guardrail rules.
 */
export interface GuardrailReport {
  passed: boolean
  totalViolations: number
  errorCount: number
  warningCount: number
  infoCount: number
  ruleResults: Map<string, GuardrailResult>
  violations: GuardrailViolation[]
}
