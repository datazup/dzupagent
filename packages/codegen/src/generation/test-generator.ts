/**
 * Test generation module — analyzes source files and produces test specifications
 * that can be fed to an LLM to generate actual test code.
 *
 * Pure functions, no external dependencies beyond TypeScript built-ins.
 */

export type TestStrategy = 'unit' | 'integration' | 'component' | 'e2e'
export type TestFramework = 'vitest' | 'jest' | 'mocha'

export interface TestGenConfig {
  /** Test framework (default: 'vitest') */
  framework: TestFramework
  /** Root directory for test files (default: 'src/__tests__') */
  testDir: string
  /** Test file naming pattern (default: '*.test.ts') */
  testPattern: string
  /** Enable TDD mode — generate tests before implementation (default: false) */
  tddMode?: boolean
}

export interface TestTarget {
  /** Source file path being tested */
  filePath: string
  /** Source file content */
  content: string
  /** Extracted exports from the source file */
  exports: ExportInfo[]
}

export interface ExportInfo {
  name: string
  kind: 'function' | 'class' | 'interface' | 'type' | 'const'
  signature?: string
}

export interface TestSpec {
  /** Path for the generated test file */
  testFilePath: string
  /** The source file this tests */
  sourceFilePath: string
  /** Strategy used for this test */
  strategy: TestStrategy
  /** Generated test prompt for the LLM (not the test itself) */
  prompt: string
  /** Suggested test cases */
  testCases: TestCase[]
}

export interface TestCase {
  description: string
  category: 'happy-path' | 'edge-case' | 'error-handling' | 'integration'
}

const DEFAULT_CONFIG: TestGenConfig = {
  framework: 'vitest',
  testDir: 'src/__tests__',
  testPattern: '*.test.ts',
  tddMode: false,
}

/**
 * Analyze a source file and determine the appropriate test strategy.
 */
export function determineTestStrategy(filePath: string, _content: string): TestStrategy {
  const lower = filePath.toLowerCase()
  if (/\.e2e\.ts$/.test(lower) || /[/\\]e2e[/\\]/.test(lower)) return 'e2e'
  if (/\.(vue|tsx|jsx)$/.test(lower)) return 'component'
  if (
    /\.controller\.ts$/.test(lower) ||
    /\.routes\.ts$/.test(lower) ||
    /[/\\]routes[/\\]/.test(lower)
  ) return 'integration'
  return 'unit'
}

/**
 * Extract exported symbols from a TypeScript file for test targeting.
 * Uses regex-based extraction (no AST dependency).
 */
export function extractExports(content: string): ExportInfo[] {
  const results: ExportInfo[] = []
  const kindMap: Record<string, ExportInfo['kind']> = {
    function: 'function',
    class: 'class',
    interface: 'interface',
    type: 'type',
    const: 'const',
    enum: 'const', // treat enum as const for test purposes
  }

  // Match: export (async)? function|class|interface|type|const|enum Name
  const exportRe = /export\s+(?:async\s)?(function|class|interface|type|const|enum)\s+(\w+)/g
  let match: RegExpExecArray | null
  while ((match = exportRe.exec(content)) !== null) {
    const rawKind = match[1] ?? 'const'
    const name = match[2] ?? 'unknown'
    const kind = kindMap[rawKind] ?? 'const'

    let signature: string | undefined
    if (rawKind === 'function') {
      // Capture from the function name to the closing paren of the parameter list
      const fromName = content.substring(match.index)
      const sigMatch = fromName.match(/function\s+\w+\s*(\([^)]*\))/)
      if (sigMatch) {
        signature = `${name}${sigMatch[1]}`
      }
    }

    const info: ExportInfo = { name, kind }
    if (signature !== undefined) info.signature = signature
    results.push(info)
  }

  return results
}

/**
 * Build the test file path from a source file path.
 */
export function buildTestPath(
  sourceFilePath: string,
  config?: Partial<TestGenConfig>,
): string {
  const merged = { ...DEFAULT_CONFIG, ...config }
  // src/auth/service.ts -> auth/service
  const srcPrefix = 'src/'
  let relative = sourceFilePath
  if (relative.startsWith(srcPrefix)) {
    relative = relative.slice(srcPrefix.length)
  }
  // Remove extension and add .test.ts
  const withoutExt = relative.replace(/\.[^.]+$/, '')
  const ext = merged.testPattern.replace('*', '')
  return `${merged.testDir}/${withoutExt}${ext}`
}

/**
 * Generate test cases for a single target based on its exports.
 */
function generateTestCases(target: TestTarget, strategy: TestStrategy): TestCase[] {
  const cases: TestCase[] = []

  for (const exp of target.exports) {
    if (exp.kind === 'function') {
      cases.push({
        description: `${exp.name} returns expected result for valid input`,
        category: 'happy-path',
      })
      cases.push({
        description: `${exp.name} handles invalid or missing arguments`,
        category: 'error-handling',
      })
      // Check for optional params in signature
      if (exp.signature && exp.signature.includes('?')) {
        cases.push({
          description: `${exp.name} works correctly when optional params are omitted`,
          category: 'edge-case',
        })
      }
    } else if (exp.kind === 'class') {
      cases.push({
        description: `${exp.name} can be constructed with valid config`,
        category: 'happy-path',
      })
      cases.push({
        description: `${exp.name} methods behave correctly`,
        category: 'happy-path',
      })
      cases.push({
        description: `${exp.name} handles invalid constructor args`,
        category: 'error-handling',
      })
    } else if (exp.kind === 'const') {
      cases.push({
        description: `${exp.name} has the expected shape and values`,
        category: 'happy-path',
      })
    }
    // interfaces and types don't need runtime tests
  }

  if (strategy === 'integration') {
    cases.push({
      description: 'endpoint returns correct status for authenticated request',
      category: 'integration',
    })
    cases.push({
      description: 'endpoint returns 401 for unauthenticated request',
      category: 'error-handling',
    })
  }

  return cases
}

/**
 * Build an LLM prompt for generating tests for a given spec.
 */
function buildTestPrompt(
  target: TestTarget,
  strategy: TestStrategy,
  testCases: TestCase[],
  config: TestGenConfig,
): string {
  const exportList = target.exports
    .map(e => `- ${e.kind} ${e.name}${e.signature ? `: ${e.signature}` : ''}`)
    .join('\n')

  const caseList = testCases
    .map(tc => `- [${tc.category}] ${tc.description}`)
    .join('\n')

  return [
    `Generate ${strategy} tests using ${config.framework} for the file: ${target.filePath}`,
    '',
    '## Exports to test:',
    exportList || '(no exports detected)',
    '',
    '## Suggested test cases:',
    caseList || '(no cases)',
    '',
    '## Source code:',
    '```typescript',
    target.content,
    '```',
    '',
    `Use describe/it blocks. Import from '${target.filePath.replace(/\.ts$/, '.js')}'.`,
    config.tddMode ? 'TDD mode: tests should define expected behavior for code not yet written.' : '',
  ].filter(Boolean).join('\n')
}

/**
 * Generate test specifications for a set of source files.
 * Returns test specs with prompts that can be fed to an LLM to generate actual tests.
 */
export function generateTestSpecs(
  targets: TestTarget[],
  config?: Partial<TestGenConfig>,
): TestSpec[] {
  const merged: TestGenConfig = { ...DEFAULT_CONFIG, ...config }

  return targets.map(target => {
    const strategy = determineTestStrategy(target.filePath, target.content)
    const testCases = generateTestCases(target, strategy)
    const prompt = buildTestPrompt(target, strategy, testCases, merged)
    const testFilePath = buildTestPath(target.filePath, merged)

    return {
      testFilePath,
      sourceFilePath: target.filePath,
      strategy,
      prompt,
      testCases,
    }
  })
}
