export type ReviewSeverity = 'critical' | 'warning' | 'suggestion'
export type ReviewCategory = 'security' | 'bug' | 'performance' | 'style' | 'best-practice'

export interface ReviewRule {
  id: string
  name: string
  category: ReviewCategory
  severity: ReviewSeverity
  /** Regex pattern to match in code */
  pattern: RegExp
  /** Description shown to the user */
  description: string
  /** Suggested fix */
  suggestion?: string
}

/** Built-in review rules covering security, bugs, performance, style, and best practices. */
export const BUILTIN_RULES: ReviewRule[] = [
  // --- Security ---
  { id: 'SEC-001', name: 'eval-usage', category: 'security', severity: 'critical', pattern: /\beval\s*\(/, description: 'Use of eval() can lead to code injection attacks.', suggestion: 'Use safer alternatives like JSON.parse() or Function constructor with validation.' },
  { id: 'SEC-002', name: 'innerHTML-assignment', category: 'security', severity: 'warning', pattern: /innerHTML\s*=/, description: 'Direct innerHTML assignment risks XSS attacks.', suggestion: 'Use textContent or a sanitization library like DOMPurify.' },
  { id: 'SEC-003', name: 'hardcoded-password', category: 'security', severity: 'critical', pattern: /(?:password|passwd|secret|api_key)\s*[:=]\s*['"][^'"]{4,}['"]/i, description: 'Possible hardcoded secret or password detected.', suggestion: 'Move secrets to environment variables.' },
  { id: 'SEC-004', name: 'dangerouslySetInnerHTML', category: 'security', severity: 'warning', pattern: /dangerouslySetInnerHTML/, description: 'dangerouslySetInnerHTML bypasses React XSS protections.', suggestion: 'Sanitize input with DOMPurify before rendering.' },
  { id: 'SEC-005', name: 'sql-concatenation', category: 'security', severity: 'critical', pattern: /(?:query|execute)\s*\(\s*['"`].*\$\{/, description: 'SQL query built with string interpolation may be vulnerable to injection.', suggestion: 'Use parameterized queries or an ORM.' },

  // --- Bugs ---
  { id: 'BUG-001', name: 'optional-chain-undefined-check', category: 'bug', severity: 'warning', pattern: /\?\.\w+\s*===?\s*undefined/, description: 'Redundant undefined check after optional chaining (already returns undefined).', suggestion: 'Remove the explicit undefined comparison.' },
  { id: 'BUG-002', name: 'empty-catch', category: 'bug', severity: 'warning', pattern: /catch\s*\([^)]*\)\s*\{\s*\}/, description: 'Empty catch block silently swallows errors.', suggestion: 'Log the error or re-throw it.' },
  { id: 'BUG-003', name: 'console-log', category: 'bug', severity: 'suggestion', pattern: /console\.(log|debug)\s*\(/, description: 'console.log/debug should not be in production code.', suggestion: 'Use a structured logger instead.' },
  { id: 'BUG-004', name: 'todo-marker', category: 'bug', severity: 'suggestion', pattern: /\/\/\s*(?:TODO|FIXME|HACK)\b/, description: 'Unresolved TODO/FIXME/HACK marker found.', suggestion: 'Resolve the issue or create a ticket.' },

  // --- Performance ---
  { id: 'PERF-001', name: 'querySelector-in-loop', category: 'performance', severity: 'warning', pattern: /(?:for|while|forEach)\s*\([\s\S]*?document\.querySelector/, description: 'DOM query inside a loop is inefficient.', suggestion: 'Cache the DOM reference outside the loop.' },
  { id: 'PERF-002', name: 'json-clone', category: 'performance', severity: 'suggestion', pattern: /JSON\.parse\s*\(\s*JSON\.stringify/, description: 'JSON.parse(JSON.stringify(...)) is a slow cloning method.', suggestion: 'Use structuredClone() or a dedicated deep-clone utility.' },
  { id: 'PERF-003', name: 'large-array-alloc', category: 'performance', severity: 'suggestion', pattern: /new\s+Array\(\d{4,}\)/, description: 'Large array pre-allocation may cause memory pressure.', suggestion: 'Consider lazy initialization or streaming.' },

  // --- Style ---
  { id: 'STY-001', name: 'long-line', category: 'style', severity: 'suggestion', pattern: /^.{121,}$/, description: 'Line exceeds 120 characters.', suggestion: 'Break the line for better readability.' },
  { id: 'STY-002', name: 'deep-nesting', category: 'style', severity: 'warning', pattern: /^\s{16,}\S/, description: 'Deeply nested code (4+ levels) reduces readability.', suggestion: 'Extract nested logic into helper functions.' },
  { id: 'STY-003', name: 'magic-number', category: 'style', severity: 'suggestion', pattern: /(?<![.\w])(?:return|[=<>!]+|[+\-*/])\s+(?!0\b|1\b|2\b|-1\b)\d{2,}\b/, description: 'Magic number detected; consider using a named constant.', suggestion: 'Extract the number into a descriptively named constant.' },

  // --- Best Practice ---
  { id: 'BP-001', name: 'any-type', category: 'best-practice', severity: 'warning', pattern: /:\s*any\b/, description: 'Usage of `any` type defeats TypeScript type safety.', suggestion: 'Use a specific type or `unknown` with type guards.' },
  { id: 'BP-002', name: 'missing-return-type', category: 'best-practice', severity: 'suggestion', pattern: /export\s+(?:async\s)?function\s+\w+\s*\([^)]*\)\s*\{/, description: 'Exported function is missing an explicit return type.', suggestion: 'Add a return type annotation for better API documentation.' },
]
