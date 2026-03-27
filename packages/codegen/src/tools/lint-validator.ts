/**
 * Lint validator — checks if edited content introduces new errors.
 *
 * Uses basic TypeScript/JavaScript syntax checks (regex-based) and optional
 * sandbox-based full linting. The lightweight validator runs without any
 * external dependencies; the sandbox validator requires a SandboxProtocol.
 */
import type { SandboxProtocol } from '../sandbox/sandbox-protocol.js'

export interface LintError {
  line: number
  column?: number
  message: string
  severity: 'error' | 'warning'
}

export interface LintResult {
  valid: boolean
  errors: LintError[]
}

/**
 * Lightweight syntax checker — catches common issues without running a full linter.
 * Runs synchronously, no external dependencies.
 */
export function quickSyntaxCheck(filePath: string, content: string): LintResult {
  const errors: LintError[] = []
  const ext = filePath.split('.').pop() ?? ''
  const lines = content.split('\n')

  // Only check TS/JS/Vue files
  if (!['ts', 'tsx', 'js', 'jsx', 'vue'].includes(ext)) {
    return { valid: true, errors: [] }
  }

  // Check for unmatched braces/brackets/parens
  let braces = 0
  let brackets = 0
  let parens = 0
  let inString = false
  let stringChar = ''
  let inTemplate = false
  let inComment = false
  let inBlockComment = false

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]!
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      const next = line[i + 1]

      // Track string/comment state
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; i++ }
        continue
      }
      if (inComment) continue // line comment — handled by newline
      if (ch === '/' && next === '/') { inComment = true; continue }
      if (ch === '/' && next === '*') { inBlockComment = true; i++; continue }

      if (inString) {
        if (ch === stringChar && line[i - 1] !== '\\') inString = false
        continue
      }
      if (inTemplate) {
        if (ch === '`' && line[i - 1] !== '\\') inTemplate = false
        continue
      }

      if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue }
      if (ch === '`') { inTemplate = true; continue }

      if (ch === '{') braces++
      if (ch === '}') braces--
      if (ch === '[') brackets++
      if (ch === ']') brackets--
      if (ch === '(') parens++
      if (ch === ')') parens--

      // Negative count means extra closing delimiter
      if (braces < 0) errors.push({ line: lineNum + 1, message: 'Unexpected closing brace "}"', severity: 'error' })
      if (brackets < 0) errors.push({ line: lineNum + 1, message: 'Unexpected closing bracket "]"', severity: 'error' })
      if (parens < 0) errors.push({ line: lineNum + 1, message: 'Unexpected closing paren ")"', severity: 'error' })
    }
    inComment = false // reset line comment at newline
  }

  if (braces > 0) errors.push({ line: lines.length, message: `${braces} unclosed brace(s) "{"`, severity: 'error' })
  if (brackets > 0) errors.push({ line: lines.length, message: `${brackets} unclosed bracket(s) "["`, severity: 'error' })
  if (parens > 0) errors.push({ line: lines.length, message: `${parens} unclosed paren(s) "("`, severity: 'error' })

  if (inBlockComment) {
    errors.push({ line: lines.length, message: 'Unterminated block comment', severity: 'error' })
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Full lint validation using a sandbox.
 * Writes the file to the sandbox, runs ESLint, and parses the JSON output.
 * Falls back to quickSyntaxCheck if sandbox execution fails.
 */
export async function sandboxLintCheck(
  filePath: string,
  content: string,
  sandbox: SandboxProtocol,
): Promise<LintResult> {
  try {
    const cmd = `echo ${JSON.stringify(content)} | npx eslint --stdin --stdin-filename ${filePath} --format json 2>/dev/null || true`
    const result = await sandbox.execute(cmd, { timeoutMs: 15_000 })

    if (result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout) as Array<{ messages?: Array<{ line: number; column: number; message: string; severity: number }> }>
        const file = parsed[0]
        if (file?.messages) {
          const errors: LintError[] = file.messages
            .filter(m => m.severity >= 2)
            .map(m => ({
              line: m.line,
              column: m.column,
              message: m.message,
              severity: 'error' as const,
            }))
          return { valid: errors.length === 0, errors }
        }
      } catch {
        // JSON parse failed — fall through to quick check
      }
    }
  } catch {
    // Sandbox execution failed — fall through
  }

  return quickSyntaxCheck(filePath, content)
}
