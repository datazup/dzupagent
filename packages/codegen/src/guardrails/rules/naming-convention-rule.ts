/**
 * Naming Convention Rule — enforces file and export naming standards.
 *
 * - Files: kebab-case (configurable)
 * - Classes/interfaces: PascalCase
 * - Functions: camelCase
 * - Constants: UPPER_SNAKE_CASE or camelCase (configurable)
 */

import type {
  GuardrailRule,
  GuardrailContext,
  GuardrailResult,
  GuardrailViolation,
  ConventionSet,
} from '../guardrail-types.js'

const KEBAB_RE = /^[a-z][-a-z0-9]*$/
const CAMEL_RE = /^[a-z][a-zA-Z0-9]*$/
const PASCAL_RE = /^[A-Z][a-zA-Z0-9]*$/
const UPPER_SNAKE_RE = /^[A-Z][A-Z0-9_]*$/

function isKebabCase(name: string): boolean {
  return KEBAB_RE.test(name)
}

function isPascalCase(name: string): boolean {
  return PASCAL_RE.test(name)
}

function isCamelCase(name: string): boolean {
  return CAMEL_RE.test(name)
}

function isUpperSnakeCase(name: string): boolean {
  return UPPER_SNAKE_RE.test(name)
}

/** Extract the file stem (no extension, no directory). */
function fileStem(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath
  // Remove extensions like .ts, .test.ts, .spec.ts, .d.ts
  return basename.replace(/\.(?:test|spec|d)?\.(?:ts|tsx|js|jsx|mjs|cjs)$/, '').replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, '')
}

const CLASS_EXPORT_RE = /^\s*export\s+(?:abstract\s)?class\s+(\w+)/
const INTERFACE_EXPORT_RE = /^\s*export\s+interface\s+(\w+)/
const TYPE_EXPORT_RE = /^\s*export\s+type\s+(\w+)/
const FUNCTION_EXPORT_RE = /^\s*export\s+(?:async\s)?function\s+(\w+)/
const CONST_EXPORT_RE = /^\s*export\s+const\s+(\w+)/
const ENUM_EXPORT_RE = /^\s*export\s+(?:const\s)?enum\s+(\w+)/

export function createNamingConventionRule(): GuardrailRule {
  return {
    id: 'naming-convention',
    name: 'NamingConventionRule',
    description: 'Enforces naming conventions: kebab-case files, PascalCase classes, camelCase functions',
    severity: 'warning',
    category: 'naming',
    check(context: GuardrailContext): GuardrailResult {
      const violations: GuardrailViolation[] = []
      const conventions = context.conventions

      for (const file of context.files) {
        // Check file naming
        checkFileName(file.path, conventions, violations)

        // Check export naming
        const lines = file.content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          checkExportNaming(file.path, line, i + 1, conventions, violations)
        }
      }

      return { passed: violations.filter((v) => v.severity === 'error').length === 0, violations }
    },
  }
}

function checkFileName(
  filePath: string,
  conventions: ConventionSet,
  violations: GuardrailViolation[],
): void {
  const stem = fileStem(filePath)
  // Skip index files and dotfiles
  if (stem === 'index' || stem.startsWith('.')) return

  const expected = conventions.fileNaming
  let valid = true

  switch (expected) {
    case 'kebab-case':
      valid = isKebabCase(stem)
      break
    case 'camelCase':
      valid = isCamelCase(stem)
      break
    case 'PascalCase':
      valid = isPascalCase(stem)
      break
    case 'snake_case':
      valid = /^[a-z][_a-z0-9]*$/.test(stem)
      break
  }

  if (!valid) {
    violations.push({
      ruleId: 'naming-convention',
      file: filePath,
      message: `File name "${stem}" does not match ${expected} convention.`,
      severity: 'warning',
      suggestion: `Rename file to use ${expected} naming.`,
      autoFixable: false,
    })
  }
}

function checkExportNaming(
  filePath: string,
  line: string,
  lineNum: number,
  conventions: ConventionSet,
  violations: GuardrailViolation[],
): void {
  // Classes and interfaces must be PascalCase
  for (const re of [CLASS_EXPORT_RE, INTERFACE_EXPORT_RE, ENUM_EXPORT_RE]) {
    const match = re.exec(line)
    if (match) {
      const name = match[1]!
      if (!isPascalCase(name)) {
        violations.push({
          ruleId: 'naming-convention',
          file: filePath,
          line: lineNum,
          message: `Exported class/interface/enum "${name}" should use PascalCase.`,
          severity: 'warning',
          suggestion: `Rename to "${name.charAt(0).toUpperCase()}${name.slice(1)}".`,
          autoFixable: false,
        })
      }
      return
    }
  }

  // Types should be PascalCase
  const typeMatch = TYPE_EXPORT_RE.exec(line)
  if (typeMatch) {
    const name = typeMatch[1]!
    if (!isPascalCase(name)) {
      violations.push({
        ruleId: 'naming-convention',
        file: filePath,
        line: lineNum,
        message: `Exported type "${name}" should use PascalCase.`,
        severity: 'warning',
        suggestion: `Rename to "${name.charAt(0).toUpperCase()}${name.slice(1)}".`,
        autoFixable: false,
      })
    }
    return
  }

  // Functions should be camelCase
  const funcMatch = FUNCTION_EXPORT_RE.exec(line)
  if (funcMatch) {
    const name = funcMatch[1]!
    const expectedCase = conventions.exportNaming.functionCase
    const valid = expectedCase === 'camelCase' ? isCamelCase(name) : isPascalCase(name)
    if (!valid) {
      violations.push({
        ruleId: 'naming-convention',
        file: filePath,
        line: lineNum,
        message: `Exported function "${name}" should use ${expectedCase}.`,
        severity: 'warning',
        suggestion: `Rename to use ${expectedCase}.`,
        autoFixable: false,
      })
    }
    return
  }

  // Consts
  const constMatch = CONST_EXPORT_RE.exec(line)
  if (constMatch) {
    const name = constMatch[1]!
    const expectedCase = conventions.exportNaming.constCase
    let valid = false
    switch (expectedCase) {
      case 'UPPER_SNAKE':
        valid = isUpperSnakeCase(name) || isCamelCase(name)
        break
      case 'camelCase':
        valid = isCamelCase(name) || isUpperSnakeCase(name)
        break
      case 'PascalCase':
        valid = isPascalCase(name) || isUpperSnakeCase(name) || isCamelCase(name)
        break
    }
    if (!valid) {
      violations.push({
        ruleId: 'naming-convention',
        file: filePath,
        line: lineNum,
        message: `Exported constant "${name}" should use ${expectedCase} or UPPER_SNAKE_CASE.`,
        severity: 'info',
        suggestion: `Rename to use ${expectedCase}.`,
        autoFixable: false,
      })
    }
  }
}
