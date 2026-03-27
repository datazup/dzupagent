/**
 * Static test coverage analyzer.
 *
 * Determines which source files have corresponding test files
 * by naming convention (not by running tests or measuring line coverage).
 */

export interface CoverageReport {
  /** Files with test coverage */
  coveredFiles: string[]
  /** Files without any tests */
  uncoveredFiles: string[]
  /** Coverage ratio 0-1 */
  ratio: number
}

export interface CoverageConfig {
  /** Source file patterns to consider (default: ['src/**\/*.ts']) */
  sourcePatterns: string[]
  /** Test file patterns (default: ['**\/*.test.ts', '**\/*.spec.ts']) */
  testPatterns: string[]
  /** Files to exclude from coverage analysis */
  excludePatterns: string[]
}

const DEFAULT_COVERAGE_CONFIG: CoverageConfig = {
  sourcePatterns: ['src/**/*.ts'],
  testPatterns: ['**/*.test.ts', '**/*.spec.ts'],
  excludePatterns: ['**/index.ts', '**/*.d.ts', '**/types.ts', '**/*-types.ts'],
}

/** Simple glob-like matching (supports * and **) */
function matchPattern(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
  return new RegExp(`^${escaped}$`).test(filePath)
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some(p => matchPattern(filePath, p))
}

/** Check if a file is a test file by convention */
function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filePath)
}

/** Derive the source file basename from a test file */
function testToSourceBase(testPath: string): string {
  // Remove test/spec suffix: foo.test.ts -> foo
  return testPath.replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, '')
}

/** Derive possible source basenames from a source file path */
function sourceToBase(sourcePath: string): string {
  return sourcePath.replace(/\.(ts|tsx|js|jsx)$/, '')
}

/**
 * Analyze which source files have corresponding test files.
 * This is a static analysis -- it does not run tests or measure line coverage.
 */
export function analyzeCoverage(
  files: Record<string, string>,
  config?: Partial<CoverageConfig>,
): CoverageReport {
  const merged = { ...DEFAULT_COVERAGE_CONFIG, ...config }
  const allPaths = Object.keys(files)

  // Identify source files (not tests, match source patterns, not excluded)
  const sourceFiles = allPaths.filter(
    p =>
      !isTestFile(p) &&
      matchesAny(p, merged.sourcePatterns) &&
      !matchesAny(p, merged.excludePatterns),
  )

  // Collect test file basenames (without path prefix, for flexible matching)
  const testBases = new Set<string>()
  for (const p of allPaths) {
    if (isTestFile(p)) {
      // Store the base without directory for cross-directory matching
      const base = testToSourceBase(p)
      testBases.add(base)
      // Also store just the filename portion
      const parts = base.split('/')
      const last = parts[parts.length - 1]
      if (last) testBases.add(last)
    }
  }

  const coveredFiles: string[] = []
  const uncoveredFiles: string[] = []

  for (const src of sourceFiles) {
    const srcBase = sourceToBase(src)
    const srcFilename = srcBase.split('/').pop() ?? srcBase
    // Check if any test file corresponds (by full base path or filename)
    if (testBases.has(srcBase) || testBases.has(srcFilename)) {
      coveredFiles.push(src)
    } else {
      uncoveredFiles.push(src)
    }
  }

  const total = coveredFiles.length + uncoveredFiles.length
  return {
    coveredFiles,
    uncoveredFiles,
    ratio: total > 0 ? coveredFiles.length / total : 0,
  }
}

/**
 * Count exported symbols in a file using a simple regex.
 */
function countExports(content: string): number {
  const matches = content.match(/export\s+(function|class|const|enum|interface|type)\s+\w+/g)
  return matches ? matches.length : 0
}

/**
 * Find source files that need test coverage.
 * Prioritizes by complexity (longer files, more exports).
 */
export function findUncoveredFiles(
  files: Record<string, string>,
  config?: Partial<CoverageConfig>,
): Array<{ filePath: string; priority: number; reason: string }> {
  const report = analyzeCoverage(files, config)

  return report.uncoveredFiles
    .map(filePath => {
      const content = files[filePath] ?? ''
      const lineCount = content.split('\n').length
      const exportCount = countExports(content)
      const priority = lineCount * Math.max(exportCount, 1)
      const reason =
        exportCount > 0
          ? `${exportCount} export(s), ${lineCount} lines`
          : `${lineCount} lines, no detected exports`
      return { filePath, priority, reason }
    })
    .sort((a, b) => b.priority - a.priority)
}
