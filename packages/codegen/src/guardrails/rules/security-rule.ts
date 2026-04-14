/**
 * Security Rule — detects hardcoded secrets, API keys, and passwords
 * in generated code.
 */

import type { GuardrailRule, GuardrailContext, GuardrailResult, GuardrailViolation } from '../guardrail-types.js'

interface SecretPattern {
  name: string
  pattern: RegExp
  message: string
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'aws-access-key',
    pattern: /['"`]AKIA[0-9A-Z]{16,}['"`]/,
    message: 'Hardcoded AWS access key detected',
  },
  {
    name: 'generic-api-key',
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"`][a-zA-Z0-9_\-]{16,}['"`]/i,
    message: 'Hardcoded API key detected',
  },
  {
    name: 'generic-secret',
    pattern: /(?:secret|token|password|passwd|pwd)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,
    message: 'Hardcoded secret or password detected',
  },
  {
    name: 'private-key',
    pattern: /-----BEGIN\s+(?:RSA\s)?PRIVATE\s+KEY-----/,
    message: 'Private key embedded in source code',
  },
  {
    name: 'jwt-token',
    pattern: /['"`]eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_\-+/=]{10,}['"`]/,
    message: 'Hardcoded JWT token detected',
  },
  {
    name: 'connection-string',
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^'"`\s]+:[^'"`\s]+@[^'"`\s]+/i,
    message: 'Database connection string with credentials detected',
  },
  {
    name: 'github-token',
    pattern: /['"`]gh[ps]_[a-zA-Z0-9]{36,}['"`]/,
    message: 'Hardcoded GitHub token detected',
  },
  {
    name: 'slack-token',
    pattern: /['"`]xox[bpras]-[a-zA-Z0-9-]+['"`]/,
    message: 'Hardcoded Slack token detected',
  },
]

/** Lines that look like safe patterns (env var reads, placeholders) */
const SAFE_PATTERNS = [
  /process\.env\./,
  /import\.meta\.env\./,
  /\$\{.*\}/,           // template literal with interpolation
  /['"`]<[A-Z_]+>['"`]/, // placeholder like '<API_KEY>'
  /['"`]\{\{.*\}\}['"`]/, // mustache placeholder
  /\/\/\s*example/i,     // comment indicating example
  /\/\/\s*test/i,        // comment indicating test
]

function isSafeLine(line: string): boolean {
  return SAFE_PATTERNS.some((p) => p.test(line))
}

export function createSecurityRule(): GuardrailRule {
  return {
    id: 'security',
    name: 'SecurityRule',
    description: 'Detects hardcoded API keys, passwords, tokens, and secrets in generated code',
    severity: 'error',
    category: 'security',
    check(context: GuardrailContext): GuardrailResult {
      const violations: GuardrailViolation[] = []

      for (const file of context.files) {
        // Skip test files and fixture files
        if (/\.(?:test|spec)\.[tj]sx?$/.test(file.path)) continue
        if (/\/__tests__\//.test(file.path) || /\/fixtures?\//.test(file.path)) continue

        const lines = file.content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!

          // Skip comment-only lines
          if (/^\s*\/\//.test(line) || /^\s*\*/.test(line) || /^\s*\/\*/.test(line)) continue

          // Skip safe patterns
          if (isSafeLine(line)) continue

          for (const sp of SECRET_PATTERNS) {
            if (sp.pattern.test(line)) {
              violations.push({
                ruleId: 'security',
                file: file.path,
                line: i + 1,
                message: `${sp.message}. Never hardcode secrets — use environment variables.`,
                severity: 'error',
                suggestion: `Replace with process.env.<ENV_VAR> or import.meta.env.<ENV_VAR>.`,
                autoFixable: false,
              })
              // One violation per line is enough
              break
            }
          }
        }
      }

      return { passed: violations.length === 0, violations }
    },
  }
}
