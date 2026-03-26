/**
 * Convention Learner — scans existing project files to infer
 * naming patterns, import styles, and file organization conventions.
 *
 * Caches learned conventions for reuse across multiple guardrail runs.
 */

import type {
  ConventionSet,
  FileNamingPattern,
  ExportNamingPattern,
  ImportStylePattern,
  RequiredPattern,
  GeneratedFile,
} from './guardrail-types.js'

export interface ConventionLearnerConfig {
  /** Minimum number of files to analyze before concluding (default: 3) */
  minFiles?: number
  /** File extensions to analyze (default: ['.ts', '.tsx', '.js', '.jsx']) */
  extensions?: string[]
}

interface NamingCount {
  kebab: number
  camel: number
  pascal: number
  snake: number
}

const DEFAULT_CONVENTIONS: ConventionSet = {
  fileNaming: 'kebab-case',
  exportNaming: {
    classCase: 'PascalCase',
    functionCase: 'camelCase',
    constCase: 'camelCase',
  },
  importStyle: {
    indexOnly: true,
    separateTypeImports: true,
  },
  requiredPatterns: [],
}

/** Extract the file stem (no extension, no directory). */
function fileStem(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath
  return basename
    .replace(/\.(?:test|spec|d)?\.(?:ts|tsx|js|jsx|mjs|cjs)$/, '')
    .replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, '')
}

function classifyFileNaming(stem: string): keyof NamingCount | undefined {
  if (stem === 'index' || stem.startsWith('.')) return undefined
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(stem)) return 'kebab'
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(stem)) return 'snake'
  if (/^[A-Z][a-zA-Z0-9]*$/.test(stem)) return 'pascal'
  if (/^[a-z][a-zA-Z0-9]*$/.test(stem)) return 'camel'
  // Single-word lowercase could be kebab or camel — favor kebab
  if (/^[a-z][a-z0-9]*$/.test(stem)) return 'kebab'
  return undefined
}

function majorityPattern(counts: NamingCount): FileNamingPattern {
  const entries: Array<[FileNamingPattern, number]> = [
    ['kebab-case', counts.kebab],
    ['camelCase', counts.camel],
    ['PascalCase', counts.pascal],
    ['snake_case', counts.snake],
  ]
  entries.sort((a, b) => b[1] - a[1])
  return entries[0]![0]
}

export class ConventionLearner {
  private readonly config: Required<ConventionLearnerConfig>
  private cachedConventions: ConventionSet | undefined

  constructor(config?: ConventionLearnerConfig) {
    this.config = {
      minFiles: config?.minFiles ?? 3,
      extensions: config?.extensions ?? ['.ts', '.tsx', '.js', '.jsx'],
    }
  }

  /**
   * Clear cached conventions, forcing a re-learn on next call.
   */
  clearCache(): void {
    this.cachedConventions = undefined
  }

  /**
   * Return cached conventions or learn from the provided files.
   */
  getConventions(files: GeneratedFile[]): ConventionSet {
    if (this.cachedConventions) return this.cachedConventions
    const learned = this.learn(files)
    this.cachedConventions = learned
    return learned
  }

  /**
   * Analyze files to learn project conventions.
   */
  learn(files: GeneratedFile[]): ConventionSet {
    const relevantFiles = files.filter((f) =>
      this.config.extensions.some((ext) => f.path.endsWith(ext)),
    )

    if (relevantFiles.length < this.config.minFiles) {
      return { ...DEFAULT_CONVENTIONS }
    }

    const fileNaming = this.learnFileNaming(relevantFiles)
    const exportNaming = this.learnExportNaming(relevantFiles)
    const importStyle = this.learnImportStyle(relevantFiles)
    const requiredPatterns = this.learnRequiredPatterns(relevantFiles)

    const result: ConventionSet = {
      fileNaming,
      exportNaming,
      importStyle,
      requiredPatterns,
    }

    this.cachedConventions = result
    return result
  }

  private learnFileNaming(files: GeneratedFile[]): FileNamingPattern {
    const counts: NamingCount = { kebab: 0, camel: 0, pascal: 0, snake: 0 }

    for (const file of files) {
      const stem = fileStem(file.path)
      const classification = classifyFileNaming(stem)
      if (classification) {
        counts[classification]++
      }
    }

    return majorityPattern(counts)
  }

  private learnExportNaming(files: GeneratedFile[]): ExportNamingPattern {
    let camelFuncs = 0
    let pascalFuncs = 0
    let upperConsts = 0
    let camelConsts = 0

    const FUNC_RE = /^\s*export\s+(?:async\s+)?function\s+(\w+)/
    const CONST_RE = /^\s*export\s+const\s+(\w+)/

    for (const file of files) {
      const lines = file.content.split('\n')
      for (const line of lines) {
        const funcMatch = FUNC_RE.exec(line)
        if (funcMatch) {
          const name = funcMatch[1]!
          if (/^[a-z]/.test(name)) camelFuncs++
          else if (/^[A-Z]/.test(name)) pascalFuncs++
        }

        const constMatch = CONST_RE.exec(line)
        if (constMatch) {
          const name = constMatch[1]!
          if (/^[A-Z][A-Z0-9_]*$/.test(name)) upperConsts++
          else camelConsts++
        }
      }
    }

    return {
      classCase: 'PascalCase',
      functionCase: pascalFuncs > camelFuncs ? 'PascalCase' : 'camelCase',
      constCase: upperConsts > camelConsts ? 'UPPER_SNAKE' : 'camelCase',
    }
  }

  private learnImportStyle(files: GeneratedFile[]): ImportStylePattern {
    let typeImports = 0
    let regularImports = 0
    let deepImports = 0
    let indexImports = 0

    for (const file of files) {
      const lines = file.content.split('\n')
      for (const line of lines) {
        if (!/^\s*import\s/.test(line)) continue

        if (/import\s+type\s/.test(line)) typeImports++
        else regularImports++

        // Check for deep imports of scoped packages
        const fromMatch = /from\s+['"](@[^/]+\/[^/'"]+)(?:\/[^'"]+)?['"]/.exec(line)
        if (fromMatch) {
          const full = /from\s+['"]([^'"]+)['"]/.exec(line)?.[1] ?? ''
          const pkg = fromMatch[1]!
          if (full.length > pkg.length + 1) deepImports++
          else indexImports++
        }
      }
    }

    return {
      indexOnly: indexImports > deepImports,
      separateTypeImports: typeImports > 0 && typeImports >= regularImports * 0.2,
    }
  }

  private learnRequiredPatterns(_files: GeneratedFile[]): RequiredPattern[] {
    // Required patterns are project-specific and typically configured
    // rather than learned. Return empty by default.
    return []
  }
}
