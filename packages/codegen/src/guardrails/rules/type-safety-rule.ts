/**
 * Type Safety Rule — forbids `any` types and `@ts-ignore` comments
 * in generated code.
 */

import type { GuardrailRule, GuardrailContext, GuardrailResult, GuardrailViolation } from '../guardrail-types.js'

/**
 * Patterns that indicate use of `any` as a type.
 * We check for `: any`, `as any`, `<any>`, and generic positions.
 */
const ANY_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /:\s*any\b(?!\w)/,
    message: 'Type annotation uses "any" — use a specific type or "unknown"',
  },
  {
    pattern: /\bas\s+any\b/,
    message: 'Type assertion "as any" — use a specific type or "as unknown"',
  },
  {
    pattern: /<any\s*>/,
    message: 'Generic parameter "any" — use a specific type',
  },
]

const TS_IGNORE_RE = /\/\/\s*@ts-ignore\b/
const TS_EXPECT_ERROR_RE = /\/\/\s*@ts-expect-error\b/
const TS_NOCHECK_RE = /\/\/\s*@ts-nocheck\b/

export function createTypeSafetyRule(): GuardrailRule {
  return {
    id: 'type-safety',
    name: 'TypeSafetyRule',
    description: 'Forbids "any" types, @ts-ignore, and @ts-nocheck in generated code',
    severity: 'error',
    category: 'patterns',
    check(context: GuardrailContext): GuardrailResult {
      const violations: GuardrailViolation[] = []

      for (const file of context.files) {
        // Only check TypeScript files
        if (!/\.[cm]?tsx?$/.test(file.path)) continue

        const lines = file.content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!

          // Skip pure comment lines for `any` checks (they might be documenting the rule)
          const isComment = /^\s*\/\//.test(line) || /^\s*\*/.test(line) || /^\s*\/\*/.test(line)

          if (!isComment) {
            for (const { pattern, message } of ANY_PATTERNS) {
              if (pattern.test(line)) {
                violations.push({
                  ruleId: 'type-safety',
                  file: file.path,
                  line: i + 1,
                  message,
                  severity: 'error',
                  suggestion: 'Replace "any" with a specific type, "unknown", or a generic type parameter.',
                  autoFixable: false,
                })
                break
              }
            }
          }

          // @ts-ignore is always a violation
          if (TS_IGNORE_RE.test(line)) {
            violations.push({
              ruleId: 'type-safety',
              file: file.path,
              line: i + 1,
              message: '@ts-ignore suppresses type errors without explanation. Use @ts-expect-error with a reason comment instead.',
              severity: 'error',
              suggestion: 'Fix the type error, or use // @ts-expect-error — <reason> if unavoidable.',
              autoFixable: false,
            })
          }

          // ts-expect-error directive is a warning (at least it documents intent)
          if (TS_EXPECT_ERROR_RE.test(line)) {
            violations.push({
              ruleId: 'type-safety',
              file: file.path,
              line: i + 1,
              message: '@ts-expect-error used — verify the type error is truly unavoidable.',
              severity: 'warning',
              suggestion: 'Fix the underlying type error if possible.',
              autoFixable: false,
            })
          }

          // @ts-nocheck disables all checking
          if (TS_NOCHECK_RE.test(line)) {
            violations.push({
              ruleId: 'type-safety',
              file: file.path,
              line: i + 1,
              message: '@ts-nocheck disables all type checking for this file.',
              severity: 'error',
              suggestion: 'Remove @ts-nocheck and fix type errors individually.',
              autoFixable: false,
            })
          }
        }
      }

      return { passed: violations.filter((v) => v.severity === 'error').length === 0, violations }
    },
  }
}
