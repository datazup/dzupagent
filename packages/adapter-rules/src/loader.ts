/**
 * RuleLoader — loads canonical AdapterRule definitions from the filesystem.
 *
 * Phase 1 supports JSON only (`*.json`). Each file may contain either a single
 * AdapterRule object or an array of AdapterRule objects. Files that fail to
 * parse or contain objects missing required fields are skipped with a warning
 * so that one bad rule file never blocks an entire run.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { AdapterRule, RuleMatch } from './types.js'

const REQUIRED_FIELDS = ['id', 'name', 'scope', 'appliesToProviders', 'effects'] as const
const RULE_SCOPES = new Set(['global', 'workspace', 'project', 'path'])
const PROVIDER_IDS = new Set([
  '*',
  'claude',
  'codex',
  'gemini',
  'gemini-sdk',
  'qwen',
  'crush',
  'goose',
  'openrouter',
  'openai',
])
const PROMPT_SECTION_PURPOSES = new Set(['persona', 'style', 'safety', 'task', 'output'])
const APPROVAL_TARGETS = new Set(['bash', 'network', 'write', 'tool'])
const ALERT_SEVERITIES = new Set(['info', 'warning', 'error'])

export type RuleLoadDiagnosticCode =
  | 'directory_not_found'
  | 'not_directory'
  | 'read_error'
  | 'parse_error'
  | 'invalid_rule'

export interface RuleLoadDiagnostic {
  code: RuleLoadDiagnosticCode
  source: string
  message: string
  ruleIndex?: number | undefined
  errors?: string[] | undefined
}

export interface RuleLoadResult {
  rules: AdapterRule[]
  diagnostics: RuleLoadDiagnostic[]
}

export class RuleLoader {
  /**
   * Load all `*.json` rule files from a directory.
   * Silently skips files that fail to parse or validate.
   * Returns an empty array if the directory does not exist.
   */
  async loadFromDirectory(dirPath: string): Promise<AdapterRule[]> {
    const result = await this.loadFromDirectoryWithDiagnostics(dirPath)
    warnDiagnostics(
      result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code !== 'directory_not_found' && diagnostic.code !== 'not_directory',
      ),
    )
    return result.rules
  }

  /**
   * Load all `*.json` rule files from a directory and return structured
   * diagnostics for missing directories, read/parse failures, and invalid
   * rule objects. Existing loadFromDirectory() callers keep warning-based
   * compatibility while bridge code can consume this method directly.
   */
  async loadFromDirectoryWithDiagnostics(dirPath: string): Promise<RuleLoadResult> {
    let entries: string[]
    try {
      const st = await stat(dirPath)
      if (!st.isDirectory()) {
        return {
          rules: [],
          diagnostics: [
            {
              code: 'not_directory',
              source: dirPath,
              message: 'rule path is not a directory',
            },
          ],
        }
      }
      entries = await readdir(dirPath)
    } catch (err) {
      return {
        rules: [],
        diagnostics: [
          {
            code: 'directory_not_found',
            source: dirPath,
            message: `failed to read rule directory: ${(err as Error).message}`,
          },
        ],
      }
    }

    const rules: AdapterRule[] = []
    const diagnostics: RuleLoadDiagnostic[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const filePath = join(dirPath, entry)
      const loaded = await this.loadFileWithDiagnostics(filePath)
      rules.push(...loaded.rules)
      diagnostics.push(...loaded.diagnostics)
    }
    return { rules, diagnostics }
  }

  /**
   * Load a single rule file. Returns all valid rules in the file (one or many).
   * Returns an empty array on parse errors, I/O errors, or validation failures.
   */
  async loadFile(filePath: string): Promise<AdapterRule[]> {
    const result = await this.loadFileWithDiagnostics(filePath)
    warnDiagnostics(result.diagnostics)
    return result.rules
  }

  /**
   * Load a single rule file and return valid rules plus structured diagnostics
   * for every skipped candidate.
   */
  async loadFileWithDiagnostics(filePath: string): Promise<RuleLoadResult> {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      return {
        rules: [],
        diagnostics: [
          {
            code: 'read_error',
            source: filePath,
            message: `failed to read rule file: ${(err as Error).message}`,
          },
        ],
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return {
        rules: [],
        diagnostics: [
          {
            code: 'parse_error',
            source: filePath,
            message: `failed to parse rule file: ${(err as Error).message}`,
          },
        ],
      }
    }

    const candidates = Array.isArray(parsed) ? parsed : [parsed]
    const valid: AdapterRule[] = []
    const diagnostics: RuleLoadDiagnostic[] = []
    for (const [index, candidate] of candidates.entries()) {
      const errors = this.validateRule(candidate)
      if (errors.length === 0) {
        valid.push(candidate as AdapterRule)
      } else {
        diagnostics.push({
          code: 'invalid_rule',
          source: filePath,
          ruleIndex: index,
          message: `skipping invalid rule in ${filePath}#${index}: ${errors.join('; ')}`,
          errors,
        })
      }
    }
    return { rules: valid, diagnostics }
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  private validateRule(value: unknown): string[] {
    const errors: string[] = []
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return ['rule must be an object']
    }
    const obj = value as Record<string, unknown>

    for (const field of REQUIRED_FIELDS) {
      if (!(field in obj)) errors.push(`missing required field "${field}"`)
    }

    if (!isNonEmptyString(obj['id'])) errors.push('id must be a non-empty string')
    if (!isNonEmptyString(obj['name'])) errors.push('name must be a non-empty string')
    if (typeof obj['scope'] !== 'string' || !RULE_SCOPES.has(obj['scope'])) {
      errors.push('scope must be one of global, workspace, project, path')
    }

    if (!Array.isArray(obj['appliesToProviders']) || obj['appliesToProviders'].length === 0) {
      errors.push('appliesToProviders must be a non-empty string array')
    } else {
      for (const [index, provider] of obj['appliesToProviders'].entries()) {
        if (typeof provider !== 'string' || !PROVIDER_IDS.has(provider)) {
          errors.push(`appliesToProviders[${index}] must be a supported provider id or "*"`)
        }
      }
    }

    if (obj['match'] !== undefined) {
      errors.push(...this.validateMatch(obj['match']))
    }

    if (!Array.isArray(obj['effects']) || obj['effects'].length === 0) {
      errors.push('effects must be a non-empty array')
    } else {
      for (const [index, effect] of obj['effects'].entries()) {
        errors.push(...this.validateEffect(effect).map((error) => `effects[${index}].${error}`))
      }
    }

    return errors
  }

  private validateMatch(value: unknown): string[] {
    const errors: string[] = []
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return ['match must be an object']
    }

    const match = value as RuleMatch
    for (const field of ['paths', 'requestTags', 'models', 'eventTypes'] as const) {
      const current = match[field]
      if (current !== undefined && !isStringArray(current)) {
        errors.push(`match.${field} must be a string array`)
      }
    }
    return errors
  }

  private validateEffect(value: unknown): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return ['effect must be an object']
    }
    const obj = value as Record<string, unknown>
    const kind = obj['kind']

    switch (kind) {
      case 'prompt_section':
        return [
          ...validateEnumField(obj, 'purpose', PROMPT_SECTION_PURPOSES),
          ...validateNonEmptyStringField(obj, 'content'),
        ]
      case 'require_skill':
        return validateNonEmptyStringField(obj, 'skill')
      case 'prefer_agent':
        return validateNonEmptyStringField(obj, 'agent')
      case 'require_approval':
        return validateEnumField(obj, 'target', APPROVAL_TARGETS)
      case 'deny_path':
        return validateNonEmptyStringField(obj, 'path')
      case 'watch_path':
        return [
          ...validateNonEmptyStringField(obj, 'path'),
          ...validateNonEmptyStringField(obj, 'artifactKind'),
        ]
      case 'emit_alert':
        return [
          ...validateNonEmptyStringField(obj, 'on'),
          ...validateEnumField(obj, 'severity', ALERT_SEVERITIES),
        ]
      default:
        return ['kind must be a known RuleEffect kind']
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function validateNonEmptyStringField(obj: Record<string, unknown>, field: string): string[] {
  return isNonEmptyString(obj[field]) ? [] : [`${field} must be a non-empty string`]
}

function validateEnumField(
  obj: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<string>,
): string[] {
  const value = obj[field]
  return typeof value === 'string' && allowed.has(value)
    ? []
    : [`${field} must be one of ${Array.from(allowed).join(', ')}`]
}

function warnDiagnostics(diagnostics: readonly RuleLoadDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    console.warn(`[adapter-rules] ${diagnostic.message}`)
  }
}
