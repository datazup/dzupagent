/**
 * Generic prompt template engine with {{variable}} substitution,
 * control flow ({{#if}}, {{#unless}}, {{#each}}, {{> partial}}),
 * and automatic camelCase→snake_case mapping.
 */
import type { TemplateVariable, TemplateContext } from './template-types.js'

/**
 * Convert a camelCase string to snake_case.
 */
function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

/**
 * Escape `{{` / `}}` delimiters in a user-supplied value so that a
 * subsequent template resolution pass (e.g., template cache hydration
 * or nested fragment composition) does not treat them as template
 * variables. Prevents reflected prompt-injection of the form
 * `{"instructions": "{{system_secret}}"}`.
 */
function escapeTemplateDelimiters(value: string): string {
  return value.replace(/\{\{/g, '{{_ESC_').replace(/\}\}/g, '_ESC_}}')
}

/**
 * Flatten a TemplateContext (Record<string, unknown>) into a flat
 * string-valued map suitable for template substitution.
 *
 * - String values pass through
 * - Arrays join with ', '
 * - Objects are JSON-stringified
 * - undefined/null → ''
 * - camelCase keys auto-map to snake_case for template matching
 *
 * User-supplied values have their `{{` / `}}` delimiters escaped to
 * prevent reflected template injection. Pass `rawVariables` to opt
 * specific system-controlled variables out of escaping.
 */
export function flattenContext(
  context: TemplateContext,
  rawVariables?: readonly string[],
): Record<string, string> {
  const map: Record<string, string> = {}
  const rawSet = new Set(rawVariables ?? [])

  for (const [key, value] of Object.entries(context)) {
    const snakeKey = camelToSnake(key)
    const raw = valueToString(value)
    const isRaw = rawSet.has(key) || rawSet.has(snakeKey)
    const strValue = isRaw ? raw : escapeTemplateDelimiters(raw)

    // Store under both original and snake_case keys
    map[key] = strValue
    if (snakeKey !== key) {
      map[snakeKey] = strValue
    }
  }

  return map
}

function valueToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(v => valueToString(v)).join(', ')
  return JSON.stringify(value)
}

/**
 * Control flow keywords that appear as identifiers inside `{{...}}` but are
 * NOT template variables.
 */
const CONTROL_FLOW_KEYWORDS = new Set(['if', 'unless', 'each', 'else', 'this'])

/**
 * Process control flow directives (partials, #each, #if, #unless) in a template
 * BEFORE variable substitution takes place.
 */
function processControlFlow(
  template: string,
  variableMap: Record<string, string>,
  partials: Record<string, string>,
): string {
  let result = template

  // 1. Process partials: {{> partial_name}}
  result = result.replace(/\{\{>\s*(\w+)\s*\}\}/g, (_match, partialName: string) => {
    const partial = partials[partialName]
    if (!partial) return `<!-- partial "${partialName}" not found -->`
    return processControlFlow(partial, variableMap, partials)
  })

  // 2. Process #each blocks: {{#each items}}...{{this}}...{{/each}}
  result = result.replace(
    /\{\{#each\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_match, varName: string, block: string) => {
      const value = variableMap[varName] ?? ''
      if (!value.trim()) return ''
      const items = value.split(',').map(s => s.trim()).filter(Boolean)
      return items.map(item => block.replace(/\{\{this\}\}/g, item)).join('')
    },
  )

  // 3. Process #if blocks: {{#if variable}}...{{else}}...{{/if}}
  result = result.replace(
    /\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, varName: string, block: string) => {
      const value = variableMap[varName] ?? ''
      const isTruthy = value.trim().length > 0

      const elseIdx = block.indexOf('{{else}}')
      if (elseIdx !== -1) {
        const ifBlock = block.slice(0, elseIdx)
        const elseBlock = block.slice(elseIdx + '{{else}}'.length)
        return isTruthy ? ifBlock : elseBlock
      }

      return isTruthy ? block : ''
    },
  )

  // 4. Process #unless blocks: {{#unless variable}}...{{/unless}}
  result = result.replace(
    /\{\{#unless\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/unless\}\}/g,
    (_match, varName: string, block: string) => {
      const value = variableMap[varName] ?? ''
      const isFalsy = value.trim().length === 0
      return isFalsy ? block : ''
    },
  )

  return result
}

/**
 * Resolve a template string by substituting {{variable_name}} placeholders.
 *
 * Control flow directives ({{#if}}, {{#unless}}, {{#each}}, {{> partial}})
 * are processed BEFORE variable substitution.
 */
export function resolveTemplate(
  template: string,
  context: TemplateContext,
  options?: {
    variables?: TemplateVariable[]
    partials?: Record<string, string>
    strictMode?: boolean
    /**
     * Variable names whose values should bypass `{{` / `}}` escaping.
     * Use for system-controlled values that intentionally carry
     * template syntax (e.g., nested-prompt composition).
     */
    rawVariables?: readonly string[]
  },
): string {
  const variableMap = flattenContext(context, options?.rawVariables)

  // Apply defaults and enforce required variables
  if (options?.variables) {
    for (const v of options.variables) {
      if (v.required && !variableMap[v.name]) {
        if (v.defaultValue !== undefined) {
          variableMap[v.name] = v.defaultValue
        } else if (options.strictMode) {
          throw new Error(`Required template variable "${v.name}" is not provided`)
        }
      }
      // Apply defaults for optional variables too
      if (!variableMap[v.name] && v.defaultValue !== undefined) {
        variableMap[v.name] = v.defaultValue
      }
    }
  }

  // Process control flow first, then substitute remaining variables
  const processedTemplate = processControlFlow(template, variableMap, options?.partials ?? {})
  return processedTemplate.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
    if (varName in variableMap) {
      return variableMap[varName] ?? ''
    }
    return '' // remove unresolved variables
  })
}

/**
 * Extract all {{variable_name}} placeholder names from a template string.
 * Returns a deduplicated array of variable names.
 * Filters out control flow keywords (if, unless, each, else, this).
 */
export function extractVariables(template: string): string[] {
  const stripped = template
    .replace(/\{\{[#/].*?\}\}/g, '') // remove block tags
    .replace(/\{\{>\s*\w+\s*\}\}/g, '') // remove partial tags
    .replace(/\{\{else\}\}/g, '') // remove {{else}}
    .replace(/\{\{this\}\}/g, '') // remove {{this}}

  const matches = stripped.matchAll(/\{\{(\w+)\}\}/g)
  return [...new Set(
    [...matches]
      .map(m => m[1])
      .filter((v): v is string => v !== undefined && !CONTROL_FLOW_KEYWORDS.has(v)),
  )]
}

/**
 * Validate a template string against its declared variables.
 */
export function validateTemplate(
  template: string,
  declaredVariables: TemplateVariable[],
  standardVariables?: TemplateVariable[],
): { valid: boolean; errors: string[]; usedVariables: string[]; undeclaredVariables: string[] } {
  const usedVariables = extractVariables(template)
  const declaredNames = new Set(declaredVariables.map(v => v.name))
  const standardNames = new Set((standardVariables ?? []).map(v => v.name))
  const errors: string[] = []
  const undeclaredVariables: string[] = []

  for (const v of usedVariables) {
    if (!declaredNames.has(v) && !standardNames.has(v)) {
      undeclaredVariables.push(v)
    }
  }

  for (const v of declaredVariables) {
    if (v.required && !usedVariables.includes(v.name) && !v.defaultValue) {
      errors.push(`Required variable "${v.name}" is declared but not used in template`)
    }
  }

  return { valid: errors.length === 0, errors, usedVariables, undeclaredVariables }
}
