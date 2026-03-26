/**
 * ConventionGate — enforces learned conventions on generated code.
 *
 * Pure regex-based checking. No external dependencies, no LLM calls.
 * Integrates with ConventionLearner output to gate code generation
 * pipelines on convention compliance.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConventionViolation {
  file: string
  line?: number
  convention: string
  description: string
  severity: 'error' | 'warning'
  suggestion?: string
}

export type ConventionCategory =
  | 'naming'
  | 'imports'
  | 'exports'
  | 'structure'
  | 'style'
  | 'security'
  | 'other'

export interface LearnedConvention {
  id: string
  name: string
  description: string
  pattern?: string | RegExp
  category: ConventionCategory
  confidence: number
  /** Custom test function. Return true if the file complies. */
  test?: (content: string, filePath: string) => boolean
}

export interface ConventionGateConfig {
  /** Learned conventions to check against */
  conventions: LearnedConvention[]
  /** Minimum confidence to enforce (0-1, default: 0.7) */
  minConfidence?: number
  /** Treat all violations as warnings (default: false) */
  warningsOnly?: boolean
}

export interface ConventionGateResult {
  passed: boolean
  violations: ConventionViolation[]
  conventionsChecked: number
  errorsCount: number
  warningsCount: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRegExp(pattern: string | RegExp): RegExp {
  if (pattern instanceof RegExp) return pattern
  return new RegExp(pattern)
}

function isTestFile(filePath: string): boolean {
  return /\.(?:test|spec)\.[tj]sx?$/.test(filePath)
    || /\/__tests__\//.test(filePath)
    || /\/test\//.test(filePath)
}

function isTypeScriptFile(filePath: string): boolean {
  return /\.[tj]sx?$/.test(filePath) && !filePath.endsWith('.d.ts')
}

/** Extract the file stem (without extension or directory). */
function fileStem(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath
  return basename
    .replace(/\.(?:test|spec|d)?\.(?:ts|tsx|js|jsx|mjs|cjs)$/, '')
    .replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, '')
}

// ---------------------------------------------------------------------------
// Built-in conventions
// ---------------------------------------------------------------------------

function createBuiltinConventions(): LearnedConvention[] {
  return [
    {
      id: 'file-naming-kebab',
      name: 'File naming: kebab-case',
      description: 'TypeScript/JavaScript files should use kebab-case naming (e.g., my-service.ts)',
      category: 'naming',
      confidence: 0.9,
      test: (_content: string, filePath: string): boolean => {
        if (!isTypeScriptFile(filePath)) return true
        const stem = fileStem(filePath)
        // Allow index, single lowercase word, or kebab-case
        if (stem === 'index' || stem.startsWith('.')) return true
        return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(stem)
      },
    },
    {
      id: 'esm-import-extensions',
      name: 'ESM imports: .js extension',
      description: 'Relative imports must include .js extension for ESM compliance',
      category: 'imports',
      confidence: 0.85,
      test: (content: string, filePath: string): boolean => {
        if (!isTypeScriptFile(filePath)) return true
        const lines = content.split('\n')
        for (const line of lines) {
          // Match: from './foo' or from '../foo' without .js/.json/.css etc extension
          const match = /from\s+['"](\.[^'"]+)['"]/g.exec(line)
          if (match) {
            const importPath = match[1] as string
            // Skip non-js imports (css, json, etc.)
            if (/\.\w+$/.test(importPath)) continue
            // Relative path without extension -> violation
            return false
          }
        }
        return true
      },
    },
    {
      id: 'no-any-type',
      name: 'No `any` type',
      description: 'Avoid using `: any` or `as any` in TypeScript code',
      category: 'security',
      confidence: 0.9,
      pattern: /(?::\s*any\b|as\s+any\b)/,
    },
    {
      id: 'no-ts-ignore',
      name: 'No @ts-ignore',
      description: 'Do not use @ts-ignore or @ts-nocheck directives',
      category: 'style',
      confidence: 0.95,
      pattern: /@ts-(?:ignore|nocheck)/,
    },
    {
      id: 'no-console-log',
      name: 'No console.log in production code',
      description: 'Avoid console.log in production code (allowed in test files)',
      category: 'style',
      confidence: 0.8,
      test: (content: string, filePath: string): boolean => {
        if (isTestFile(filePath)) return true
        if (!isTypeScriptFile(filePath)) return true
        return !/\bconsole\.log\b/.test(content)
      },
    },
    {
      id: 'no-var',
      name: 'Prefer const/let over var',
      description: 'Use const or let instead of var declarations',
      category: 'style',
      confidence: 0.95,
      pattern: /\bvar\s+\w/,
    },
    {
      id: 'export-naming-class-pascal',
      name: 'Exported classes: PascalCase',
      description: 'Exported class names should use PascalCase',
      category: 'exports',
      confidence: 0.9,
      test: (content: string): boolean => {
        const classRe = /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/gm
        let match: RegExpExecArray | null
        while ((match = classRe.exec(content)) !== null) {
          const name = match[1] as string
          if (!/^[A-Z]/.test(name)) return false
        }
        return true
      },
    },
    {
      id: 'export-naming-function-camel',
      name: 'Exported functions: camelCase',
      description: 'Exported function names should use camelCase',
      category: 'exports',
      confidence: 0.85,
      test: (content: string): boolean => {
        const funcRe = /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm
        let match: RegExpExecArray | null
        while ((match = funcRe.exec(content)) !== null) {
          const name = match[1] as string
          if (!/^[a-z]/.test(name)) return false
        }
        return true
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// ConventionGate
// ---------------------------------------------------------------------------

export class ConventionGate {
  private readonly conventions: LearnedConvention[]
  private readonly minConfidence: number
  private readonly warningsOnly: boolean

  constructor(config: ConventionGateConfig) {
    this.conventions = config.conventions
    this.minConfidence = config.minConfidence ?? 0.7
    this.warningsOnly = config.warningsOnly ?? false
  }

  /**
   * Evaluate generated files against conventions.
   */
  evaluate(files: Array<{ path: string; content: string }>): ConventionGateResult {
    const violations: ConventionViolation[] = []
    const activeConventions = this.conventions.filter(
      (c) => c.confidence >= this.minConfidence,
    )

    for (const file of files) {
      for (const convention of activeConventions) {
        const fileViolations = this.checkConvention(file, convention)
        violations.push(...fileViolations)
      }
    }

    const errorsCount = violations.filter((v) => v.severity === 'error').length
    const warningsCount = violations.filter((v) => v.severity === 'warning').length

    return {
      passed: errorsCount === 0,
      violations,
      conventionsChecked: activeConventions.length,
      errorsCount,
      warningsCount,
    }
  }

  /**
   * Create a ConventionGate from common conventions (built-in defaults).
   * These cover: file naming, import style, TypeScript strict patterns, ESM compliance.
   */
  static withDefaults(overrides?: Partial<ConventionGateConfig>): ConventionGate {
    const builtins = createBuiltinConventions()
    const extra = overrides?.conventions ?? []
    return new ConventionGate({
      conventions: [...builtins, ...extra],
      minConfidence: overrides?.minConfidence,
      warningsOnly: overrides?.warningsOnly,
    })
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private checkConvention(
    file: { path: string; content: string },
    convention: LearnedConvention,
  ): ConventionViolation[] {
    const violations: ConventionViolation[] = []
    const severity: 'error' | 'warning' = this.warningsOnly ? 'warning' : 'error'

    // Check with custom test function
    if (convention.test) {
      const passes = convention.test(file.content, file.path)
      if (!passes) {
        violations.push({
          file: file.path,
          convention: convention.name,
          description: `${convention.description} [${file.path}]`,
          severity,
          suggestion: `Review ${file.path} to comply with "${convention.name}"`,
        })
      }
    }

    // Check with regex pattern
    if (convention.pattern) {
      const regex = toRegExp(convention.pattern)
      // Only apply pattern checks to TypeScript/JavaScript files
      if (!isTypeScriptFile(file.path)) return violations

      const lines = file.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string
        if (regex.test(line)) {
          violations.push({
            file: file.path,
            line: i + 1,
            convention: convention.name,
            description: `${convention.description} (line ${i + 1})`,
            severity,
            suggestion: `Fix line ${i + 1} in ${file.path}`,
          })
        }
      }
    }

    return violations
  }
}
