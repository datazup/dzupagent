/**
 * Built-in quality dimensions for evaluating generated code.
 *
 * 1. typeStrictness (15 pts) - checks for `any`, `@ts-ignore`, `@ts-nocheck`
 * 2. eslintClean (10 pts) - checks for `console.log`, `debugger`, `alert(`
 * 3. hasTests (10 pts) - checks if test files exist for source files
 * 4. codeCompleteness (10 pts) - checks for empty bodies, FIXME, TODO
 * 5. hasJsDoc (5 pts) - checks exported functions/classes have doc comments
 */

import type { QualityDimension, DimensionResult, QualityContext } from './quality-types.js'

// ---- Helpers ----------------------------------------------------------------

function isTypeScriptFile(path: string): boolean {
  return /\.tsx?$/.test(path) && !path.includes('.d.ts')
}

function isSourceFile(path: string): boolean {
  return isTypeScriptFile(path) && !isTestFile(path)
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[tj]sx?$/.test(path) || path.includes('__tests__')
}

function violationRatio(violations: number, totalFiles: number): number {
  if (totalFiles === 0) return 0
  return Math.min(violations / totalFiles, 1)
}

// ---- Dimensions -------------------------------------------------------------

/**
 * Checks for `any` type, `@ts-ignore`, `@ts-nocheck` in TypeScript files.
 */
export const typeStrictness: QualityDimension = {
  name: 'typeStrictness',
  maxPoints: 15,
  async evaluate(vfs: Record<string, string>, _context?: QualityContext): Promise<DimensionResult> {
    const errors: string[] = []
    const warnings: string[] = []
    let tsFiles = 0

    const anyPattern = /:\s*any\b|<any>|as\s+any\b/g
    const ignorePattern = /@ts-ignore|@ts-nocheck/g

    for (const [path, content] of Object.entries(vfs)) {
      if (!isTypeScriptFile(path)) continue
      tsFiles++

      const anyMatches = content.match(anyPattern)
      if (anyMatches) {
        errors.push(`${path}: ${anyMatches.length} use(s) of 'any' type`)
      }

      const ignoreMatches = content.match(ignorePattern)
      if (ignoreMatches) {
        errors.push(`${path}: ${ignoreMatches.length} ts-ignore/ts-nocheck directive(s)`)
      }
    }

    const ratio = violationRatio(errors.length, tsFiles)
    const score = Math.round(this.maxPoints * (1 - ratio))

    return {
      name: this.name,
      score,
      maxScore: this.maxPoints,
      passed: errors.length === 0,
      errors,
      warnings,
    }
  },
}

/**
 * Checks for `console.log`, `debugger`, `alert(` in non-test source files.
 */
export const eslintClean: QualityDimension = {
  name: 'eslintClean',
  maxPoints: 10,
  async evaluate(vfs: Record<string, string>, _context?: QualityContext): Promise<DimensionResult> {
    const warnings: string[] = []
    let sourceFiles = 0

    const debugPatterns = [
      { pattern: /\bconsole\.log\(/g, label: 'console.log' },
      { pattern: /\bdebugger\b/g, label: 'debugger' },
      { pattern: /\balert\(/g, label: 'alert()' },
    ]

    for (const [path, content] of Object.entries(vfs)) {
      if (!isSourceFile(path)) continue
      sourceFiles++

      for (const { pattern, label } of debugPatterns) {
        // Reset lastIndex for global regex
        pattern.lastIndex = 0
        const matches = content.match(pattern)
        if (matches) {
          warnings.push(`${path}: ${matches.length} ${label} statement(s)`)
        }
      }
    }

    const ratio = violationRatio(warnings.length, sourceFiles)
    const score = Math.round(this.maxPoints * (1 - ratio))

    return {
      name: this.name,
      score,
      maxScore: this.maxPoints,
      passed: warnings.length === 0,
      errors: [],
      warnings,
    }
  },
}

/**
 * Checks if test files exist for source files.
 */
export const hasTests: QualityDimension = {
  name: 'hasTests',
  maxPoints: 10,
  async evaluate(vfs: Record<string, string>, _context?: QualityContext): Promise<DimensionResult> {
    const warnings: string[] = []
    const paths = Object.keys(vfs)
    const testPaths = new Set(paths.filter(isTestFile))

    const sourceFiles = paths.filter(p => isSourceFile(p) && !p.includes('/index.'))
    if (sourceFiles.length === 0) {
      return {
        name: this.name,
        score: this.maxPoints,
        maxScore: this.maxPoints,
        passed: true,
        errors: [],
        warnings: ['No source files found to check for tests'],
      }
    }

    let covered = 0
    for (const srcPath of sourceFiles) {
      // Derive expected test file names
      const base = srcPath.replace(/\.tsx?$/, '')
      const hasTest =
        testPaths.has(`${base}.test.ts`) ||
        testPaths.has(`${base}.test.tsx`) ||
        testPaths.has(`${base}.spec.ts`) ||
        testPaths.has(`${base}.spec.tsx`)

      if (hasTest) {
        covered++
      } else {
        warnings.push(`${srcPath}: no corresponding test file found`)
      }
    }

    const ratio = sourceFiles.length > 0 ? covered / sourceFiles.length : 1
    const score = Math.round(this.maxPoints * ratio)

    return {
      name: this.name,
      score,
      maxScore: this.maxPoints,
      passed: covered === sourceFiles.length,
      errors: [],
      warnings,
    }
  },
}

/**
 * Checks for empty function bodies, FIXME, TODO markers in source files.
 * Only flags non-comment TODO/FIXME occurrences (inside code, not JSDoc/comments).
 */
export const codeCompleteness: QualityDimension = {
  name: 'codeCompleteness',
  maxPoints: 10,
  async evaluate(vfs: Record<string, string>, _context?: QualityContext): Promise<DimensionResult> {
    const errors: string[] = []
    const warnings: string[] = []
    let sourceFiles = 0

    // Empty function body: () => {} or function() {} with nothing inside
    const emptyBodyPattern = /(?:=>|(?:function|async)\s*\([^)]*\))\s*\{\s*\}/g

    for (const [path, content] of Object.entries(vfs)) {
      if (!isSourceFile(path)) continue
      sourceFiles++

      emptyBodyPattern.lastIndex = 0
      const emptyMatches = content.match(emptyBodyPattern)
      if (emptyMatches) {
        errors.push(`${path}: ${emptyMatches.length} empty function body/bodies`)
      }

      // Check for TODO/FIXME in non-comment lines
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trimStart()
        // Skip pure comment lines — only flag code-inline markers
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        if (/\bFIXME\b/.test(line)) {
          warnings.push(`${path}:${i + 1}: FIXME marker in code`)
        }
        if (/\bTODO\b/.test(line)) {
          warnings.push(`${path}:${i + 1}: TODO marker in code`)
        }
      }
    }

    const totalIssues = errors.length + warnings.length
    const ratio = violationRatio(totalIssues, sourceFiles)
    const score = Math.round(this.maxPoints * (1 - ratio))

    return {
      name: this.name,
      score,
      maxScore: this.maxPoints,
      passed: errors.length === 0,
      errors,
      warnings,
    }
  },
}

/**
 * Checks that exported functions and classes have JSDoc comments.
 */
export const hasJsDoc: QualityDimension = {
  name: 'hasJsDoc',
  maxPoints: 5,
  async evaluate(vfs: Record<string, string>, _context?: QualityContext): Promise<DimensionResult> {
    const warnings: string[] = []
    let totalExports = 0
    let documented = 0

    const exportPattern = /^export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/gm

    for (const [path, content] of Object.entries(vfs)) {
      if (!isSourceFile(path)) continue

      const lines = content.split('\n')
      exportPattern.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = exportPattern.exec(content)) !== null) {
        totalExports++
        const exportName = match[1] ?? 'unknown'

        // Find the line number of this export
        const linesBefore = content.substring(0, match.index).split('\n')
        const lineIdx = linesBefore.length - 1

        // Check if preceding lines have a JSDoc comment (/** ... */)
        let hasDoc = false
        for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 5); i--) {
          const prevLine = lines[i]?.trim() ?? ''
          if (prevLine === '') continue
          if (prevLine.endsWith('*/')) {
            hasDoc = true
            break
          }
          // If we hit a non-comment, non-empty line, stop looking
          if (!prevLine.startsWith('*') && !prevLine.startsWith('/**') && !prevLine.startsWith('//')) {
            break
          }
          if (prevLine.startsWith('/**')) {
            hasDoc = true
            break
          }
        }

        if (hasDoc) {
          documented++
        } else {
          warnings.push(`${path}: export '${exportName}' missing JSDoc comment`)
        }
      }
    }

    const ratio = totalExports > 0 ? documented / totalExports : 1
    const score = Math.round(this.maxPoints * ratio)

    return {
      name: this.name,
      score,
      maxScore: this.maxPoints,
      passed: documented === totalExports,
      errors: [],
      warnings,
    }
  },
}

/** All built-in quality dimensions. */
export const builtinDimensions: QualityDimension[] = [
  typeStrictness,
  eslintClean,
  hasTests,
  codeCompleteness,
  hasJsDoc,
]
