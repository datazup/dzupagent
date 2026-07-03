export type FlowConditionValidationResult =
  | { valid: true }
  | { valid: false; reason: string }

type TemplateNormalizationResult =
  | { valid: true; source: string }
  | { valid: false; reason: string }

const COMPARISON_OPERATORS = ["===", "!==", ">=", "<=", "==", "!=", ">", "<"] as const

export function resolveFlowTemplateExpression(
  expr: string,
  state: Record<string, unknown>,
): unknown {
  const wholeTemplate = getWholeTemplatePath(expr)
  if (wholeTemplate !== null) return resolveFlowStatePath(wholeTemplate, state)
  return renderTemplateText(expr, state)
}

export function resolveFlowConditionExpression(
  expr: string,
  state: Record<string, unknown>,
): unknown {
  const wholeTemplate = getWholeTemplatePath(expr)
  if (wholeTemplate !== null) return resolveFlowStatePath(wholeTemplate, state)
  return evaluateConditionSource(renderTemplateText(expr, state), state)
}

export function validateFlowConditionExpression(expr: string): FlowConditionValidationResult {
  const trimmed = expr.trim()
  if (trimmed.length === 0) return { valid: false, reason: "condition expression is empty" }
  if (containsDisallowedConstruct(trimmed)) {
    return { valid: false, reason: "condition expression contains a disallowed construct" }
  }

  const normalized = normalizeTemplatesForValidation(trimmed)
  if (!normalized.valid) return normalized
  return validateConditionSource(normalized.source)
}

function evaluateConditionSource(
  source: string,
  state: Record<string, unknown>,
): unknown {
  const trimmed = stripWrappingParens(source.trim())
  if (trimmed.length === 0) return false

  const orParts = splitTopLevel(trimmed, "||")
  if (orParts.length > 1) return orParts.some((part) => Boolean(evaluateConditionSource(part, state)))

  const andParts = splitTopLevel(trimmed, "&&")
  if (andParts.length > 1) return andParts.every((part) => Boolean(evaluateConditionSource(part, state)))

  if (trimmed.startsWith("!")) return !Boolean(evaluateConditionSource(trimmed.slice(1), state))

  const comparison = findTopLevelComparison(trimmed)
  if (comparison !== null) {
    const left = resolveConditionOperand(comparison.left, state)
    const right = resolveConditionOperand(comparison.right, state)
    switch (comparison.operator) {
      case "===":
      case "==":
        return left === right
      case "!==":
      case "!=":
        return left !== right
      case ">":
        return Number(left) > Number(right)
      case ">=":
        return Number(left) >= Number(right)
      case "<":
        return Number(left) < Number(right)
      case "<=":
        return Number(left) <= Number(right)
    }
  }

  return resolveConditionOperand(trimmed, state)
}

function validateConditionSource(source: string): FlowConditionValidationResult {
  const trimmed = stripWrappingParens(source.trim())
  if (trimmed.length === 0) return { valid: false, reason: "condition expression is empty" }

  const orParts = splitTopLevel(trimmed, "||")
  if (orParts.length > 1) return validateParts(orParts)

  const andParts = splitTopLevel(trimmed, "&&")
  if (andParts.length > 1) return validateParts(andParts)

  if (trimmed.startsWith("!")) return validateConditionSource(trimmed.slice(1))

  const comparison = findTopLevelComparison(trimmed)
  if (comparison !== null) {
    const left = validateConditionOperand(comparison.left)
    if (!left.valid) return left
    return validateConditionOperand(comparison.right)
  }

  return validateConditionOperand(trimmed)
}

function validateParts(parts: string[]): FlowConditionValidationResult {
  for (const part of parts) {
    const result = validateConditionSource(part)
    if (!result.valid) return result
  }
  return { valid: true }
}

function resolveConditionOperand(raw: string, state: Record<string, unknown>): unknown {
  const value = raw.trim()
  if (value.length === 0) return undefined
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null") return null
  if (value === "undefined") return undefined
  if (isQuotedString(value)) return value.slice(1, -1)
  if (isNumberLiteral(value)) return Number(value)
  if (isPathExpression(value)) return resolveFlowStatePath(value, state)
  return undefined
}

function validateConditionOperand(raw: string): FlowConditionValidationResult {
  const value = raw.trim()
  if (value.length === 0) return { valid: false, reason: "condition operand is empty" }
  if (
    value === "true" ||
    value === "false" ||
    value === "null" ||
    value === "undefined" ||
    isQuotedString(value) ||
    isNumberLiteral(value) ||
    isPathExpression(value)
  ) {
    return { valid: true }
  }
  return {
    valid: false,
    reason: `unsupported condition operand "${value}" in runtime-supported expression subset`,
  }
}

function resolveFlowStatePath(path: string, state: Record<string, unknown>): unknown {
  const normalized = normalizePath(path)
  if (normalized.length === 0) return undefined
  let value: unknown = state
  for (const part of normalized) {
    if (value === null || value === undefined || typeof value !== "object") return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

function normalizePath(path: string): string[] {
  const parts = path.trim().split(".").filter((part) => part.length > 0)
  const first = parts[0]
  if (first === "state" || first === "ctx") return parts.slice(1)
  return parts
}

function getWholeTemplatePath(expr: string): string | null {
  const trimmed = expr.trim()
  if (!trimmed.startsWith("{{") || !trimmed.endsWith("}}")) return null
  const inner = trimmed.slice(2, -2).trim()
  if (inner.length === 0) return null
  if (inner.includes("{{") || inner.includes("}}")) return null
  return inner
}

function renderTemplateText(expr: string, state: Record<string, unknown>): string {
  let output = ""
  let cursor = 0
  while (cursor < expr.length) {
    const open = expr.indexOf("{{", cursor)
    if (open === -1) {
      output += expr.slice(cursor)
      break
    }
    const close = expr.indexOf("}}", open + 2)
    if (close === -1) {
      output += expr.slice(cursor)
      break
    }
    output += expr.slice(cursor, open)
    const path = expr.slice(open + 2, close).trim()
    const value = resolveFlowStatePath(path, state)
    output += value == null ? "" : String(value)
    cursor = close + 2
  }
  return output
}

function normalizeTemplatesForValidation(source: string): TemplateNormalizationResult {
  let output = ""
  let cursor = 0
  while (cursor < source.length) {
    const open = source.indexOf("{{", cursor)
    if (open === -1) {
      output += source.slice(cursor)
      break
    }
    const close = source.indexOf("}}", open + 2)
    if (close === -1) return { valid: false, reason: "unterminated template expression" }
    output += source.slice(cursor, open)
    const path = source.slice(open + 2, close).trim()
    if (!isPathExpression(path)) {
      return { valid: false, reason: `unsupported template path "${path}"` }
    }
    output += "__template_value__"
    cursor = close + 2
  }
  return { valid: true, source: output }
}

function findTopLevelComparison(source: string): { left: string; operator: string; right: string } | null {
  for (const operator of COMPARISON_OPERATORS) {
    const index = findTopLevelOperator(source, operator)
    if (index !== -1) {
      return {
        left: source.slice(0, index),
        operator,
        right: source.slice(index + operator.length),
      }
    }
  }
  return null
}

function splitTopLevel(source: string, operator: "&&" | "||"): string[] {
  const parts: string[] = []
  let cursor = 0
  let index = 0
  while (index < source.length) {
    const opIndex = findTopLevelOperator(source.slice(index), operator)
    if (opIndex === -1) break
    const absolute = index + opIndex
    parts.push(source.slice(cursor, absolute))
    cursor = absolute + operator.length
    index = cursor
  }
  if (parts.length === 0) return [source]
  parts.push(source.slice(cursor))
  return parts
}

function findTopLevelOperator(source: string, operator: string): number {
  let quote: string | null = null
  let depth = 0
  for (let index = 0; index <= source.length - operator.length; index += 1) {
    const char = source[index]
    if (quote !== null) {
      if (char === "\\") {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "(") {
      depth += 1
      continue
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && source.slice(index, index + operator.length) === operator) return index
  }
  return -1
}

function stripWrappingParens(source: string): string {
  let current = source
  while (current.startsWith("(") && current.endsWith(")") && wrapsEntireExpression(current)) {
    current = current.slice(1, -1).trim()
  }
  return current
}

function wrapsEntireExpression(source: string): boolean {
  let quote: string | null = null
  let depth = 0
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== null) {
      if (char === "\\") {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (depth === 0 && index < source.length - 1) return false
  }
  return depth === 0
}

function isPathExpression(value: string): boolean {
  const parts = value.trim().split(".")
  if (parts.length === 0) return false
  return parts.every(isIdentifier)
}

function isIdentifier(value: string): boolean {
  if (value.length === 0) return false
  const first = value.charCodeAt(0)
  if (!isIdentifierStart(first)) return false
  for (let index = 1; index < value.length; index += 1) {
    if (!isIdentifierPart(value.charCodeAt(index))) return false
  }
  return true
}

function isIdentifierStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57)
}

function isNumberLiteral(value: string): boolean {
  if (value.length === 0) return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && String(parsed) === value
}

function isQuotedString(value: string): boolean {
  if (value.length < 2) return false
  const first = value[0]
  const last = value[value.length - 1]
  return (first === "'" || first === '"') && first === last
}

function containsDisallowedConstruct(value: string): boolean {
  const compact = value.replaceAll(" ", "").replaceAll("\n", "").replaceAll("\t", "")
  return compact.includes("eval(") || compact.includes("Function(") || compact.includes("import(")
}
