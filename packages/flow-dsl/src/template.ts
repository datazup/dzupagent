/**
 * Versioned-template parser & validator (Stage 1.5 follow-up).
 *
 * Reads a markdown template authored with YAML frontmatter and verifies
 * that the body contains every section the frontmatter declares as
 * required. The parser is intentionally synchronous and depends only on
 * the existing `parseYamlSubset` helper — no new dependencies.
 *
 * Input format:
 *
 *   ---
 *   id: planning-pipeline
 *   version: 1
 *   profile: planning-fast        # optional ProfileRef
 *   schema: plan.v1               # optional output-schema ref
 *   requiredSections: [Goal, Constraints, Output Format]
 *   ---
 *   ## Goal
 *   ...
 *   ## Constraints
 *   ...
 *
 * Section extraction is intentionally limited to level-2 headings
 * (`##`) for now. Level-1 headings are treated as document titles and
 * ignored; deeper headings (`###`+) are part of the parent section's
 * body. This keeps the contract small and matches the
 * instruction-files convention used elsewhere in the workspace.
 *
 * Note: this module is the static-asset parser for `.md` /
 * `.dzupflow.md` templates the compiler will eventually lower into a
 * FlowDocumentV1. It is NOT the codev-app DB-backed `templateService`
 * (which manages template entities with version snapshots) — that one
 * lives in `apps/codev-app`.
 */

import { parseYamlSubset } from './mini-yaml.js'

/**
 * Error codes surfaced by template parsing. These mirror the codes
 * added to `flow-ast`'s `ValidationErrorCode` union so downstream
 * compiler stages can reuse them when surfacing diagnostics.
 */
export const TEMPLATE_ERROR = {
  INVALID_TEMPLATE_FRONTMATTER: 'INVALID_TEMPLATE_FRONTMATTER',
  MISSING_REQUIRED_SECTION: 'MISSING_REQUIRED_SECTION',
  UNKNOWN_FRONTMATTER_KEY: 'UNKNOWN_FRONTMATTER_KEY',
} as const

export type TemplateErrorCode = (typeof TEMPLATE_ERROR)[keyof typeof TEMPLATE_ERROR]

export interface TemplateDiagnostic {
  code: TemplateErrorCode
  message: string
  /** Best-effort line number in the source, 1-based. 0 if unknown. */
  line: number
  /**
   * Severity:
   *   - `error`   → parse fails, returned in `errors`
   *   - `warning` → parse succeeds, returned in `warnings`
   */
  severity: 'error' | 'warning'
}

/**
 * Parsed shape returned on success. `sections` is keyed by the
 * heading text exactly as authored (trimmed). `body` is the raw
 * markdown beneath the frontmatter — useful for downstream lowering
 * passes that prefer to re-tokenize.
 */
export interface ParsedTemplate {
  id: string
  version: number
  profile?: string
  schema?: string
  requiredSections: string[]
  body: string
  sections: Record<string, string>
}

export type ParseTemplateResult =
  | { ok: true; template: ParsedTemplate; warnings: TemplateDiagnostic[] }
  | { ok: false; errors: TemplateDiagnostic[]; warnings: TemplateDiagnostic[] }

/**
 * Kebab-case validator. Implemented as an imperative scan rather than
 * a regex so the ESLint `security/detect-unsafe-regex` plugin stays
 * quiet about quantifier nesting on the `(?:-[a-z0-9]+)*` alternative.
 */
function isKebabCase(value: string): boolean {
  if (value.length === 0) return false
  const first = value.charCodeAt(0)
  // Must start with a-z.
  if (first < 97 || first > 122) return false
  let prevIsHyphen = false
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const isLower = code >= 97 && code <= 122
    const isDigit = code >= 48 && code <= 57
    const isHyphen = code === 45
    if (!isLower && !isDigit && !isHyphen) return false
    if (isHyphen && prevIsHyphen) return false
    prevIsHyphen = isHyphen
  }
  // Cannot end with a trailing hyphen.
  return !prevIsHyphen
}
const KNOWN_FRONTMATTER_KEYS = new Set([
  'id',
  'version',
  'profile',
  'schema',
  'requiredSections',
])

/**
 * Parse a versioned-template markdown source. Returns a structured
 * result; never throws on invalid input.
 */
export function parseTemplate(source: string): ParseTemplateResult {
  const errors: TemplateDiagnostic[] = []
  const warnings: TemplateDiagnostic[] = []

  const split = splitFrontmatter(source)
  if (!split.ok) {
    errors.push({
      code: 'INVALID_TEMPLATE_FRONTMATTER',
      message: split.message,
      line: split.line,
      severity: 'error',
    })
    return { ok: false, errors, warnings }
  }

  const yaml = parseYamlSubset(split.frontmatter)
  if (!yaml.ok) {
    const first = yaml.errors[0]
    errors.push({
      code: 'INVALID_TEMPLATE_FRONTMATTER',
      message: first
        ? `Malformed YAML frontmatter: ${first.message}`
        : 'Malformed YAML frontmatter',
      // YAML lines are 1-based within the frontmatter block; offset by
      // the opening `---` (line 1) so the reported line matches the
      // source file.
      line: first ? first.line + 1 : 0,
      severity: 'error',
    })
    return { ok: false, errors, warnings }
  }

  const raw = yaml.value
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({
      code: 'INVALID_TEMPLATE_FRONTMATTER',
      message: 'Frontmatter must be a YAML mapping',
      line: 2,
      severity: 'error',
    })
    return { ok: false, errors, warnings }
  }

  const fm = raw as Record<string, unknown>

  // Required: id (kebab-case)
  const id = fm.id
  if (typeof id !== 'string' || !isKebabCase(id)) {
    errors.push({
      code: 'INVALID_TEMPLATE_FRONTMATTER',
      message:
        typeof id === 'string'
          ? `Field "id" must be kebab-case (got "${id}")`
          : 'Field "id" is required and must be a kebab-case string',
      line: 2,
      severity: 'error',
    })
  }

  // Required: version (positive integer)
  const version = fm.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    errors.push({
      code: 'INVALID_TEMPLATE_FRONTMATTER',
      message: 'Field "version" is required and must be a positive integer',
      line: 2,
      severity: 'error',
    })
  }

  // Optional: profile (kebab-case ref)
  let profile: string | undefined
  if (fm.profile !== undefined) {
    if (typeof fm.profile !== 'string' || !isKebabCase(fm.profile)) {
      errors.push({
        code: 'INVALID_TEMPLATE_FRONTMATTER',
        message: `Field "profile" must be a kebab-case profile ref (got ${JSON.stringify(fm.profile)})`,
        line: 2,
        severity: 'error',
      })
    } else {
      profile = fm.profile
    }
  }

  // Optional: schema (string)
  let schema: string | undefined
  if (fm.schema !== undefined) {
    if (typeof fm.schema !== 'string' || fm.schema.length === 0) {
      errors.push({
        code: 'INVALID_TEMPLATE_FRONTMATTER',
        message: 'Field "schema" must be a non-empty string',
        line: 2,
        severity: 'error',
      })
    } else {
      schema = fm.schema
    }
  }

  // Required: requiredSections (string[])
  let requiredSections: string[] = []
  if (fm.requiredSections === undefined) {
    requiredSections = []
  } else if (!Array.isArray(fm.requiredSections)) {
    errors.push({
      code: 'INVALID_TEMPLATE_FRONTMATTER',
      message: 'Field "requiredSections" must be an array of strings',
      line: 2,
      severity: 'error',
    })
  } else {
    const all = fm.requiredSections as unknown[]
    const bad = all.findIndex((entry) => typeof entry !== 'string' || entry.length === 0)
    if (bad >= 0) {
      errors.push({
        code: 'INVALID_TEMPLATE_FRONTMATTER',
        message: `Field "requiredSections[${bad}]" must be a non-empty string`,
        line: 2,
        severity: 'error',
      })
    } else {
      requiredSections = all as string[]
    }
  }

  // Warn-only: forward-compatible unknown keys.
  for (const key of Object.keys(fm)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
      warnings.push({
        code: 'UNKNOWN_FRONTMATTER_KEY',
        message: `Unknown frontmatter key "${key}" (kept for forward compatibility)`,
        line: 2,
        severity: 'warning',
      })
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings }
  }

  const sections = extractSections(split.body)

  // Required-section presence check.
  const missing = requiredSections.filter((name) => sections[name] === undefined)
  if (missing.length > 0) {
    errors.push({
      code: 'MISSING_REQUIRED_SECTION',
      message: `Template is missing required ## section(s): ${missing.map((m) => `"${m}"`).join(', ')}`,
      line: split.bodyStartLine,
      severity: 'error',
    })
    return { ok: false, errors, warnings }
  }

  return {
    ok: true,
    template: {
      id: id as string,
      version: version as number,
      ...(profile !== undefined ? { profile } : {}),
      ...(schema !== undefined ? { schema } : {}),
      requiredSections,
      body: split.body,
      sections,
    },
    warnings,
  }
}

interface SplitOk {
  ok: true
  frontmatter: string
  body: string
  /** 1-based line where the body begins in the original source. */
  bodyStartLine: number
}

interface SplitFail {
  ok: false
  message: string
  line: number
}

/**
 * Split a source string into a frontmatter block and a body block.
 *
 * Frontmatter must:
 *   - start on line 1 with `---`
 *   - terminate with a line that is exactly `---`
 *
 * Anything else is `INVALID_TEMPLATE_FRONTMATTER`. A source with no
 * leading `---` is also rejected — the contract is that every
 * versioned template MUST declare frontmatter.
 */
function splitFrontmatter(source: string): SplitOk | SplitFail {
  const normalized = source.replace(/^﻿/, '')
  const lines = normalized.split('\n')

  if (lines.length === 0 || lines[0]?.trim() !== '---') {
    return {
      ok: false,
      message: 'Template must begin with a `---` frontmatter delimiter',
      line: 1,
    }
  }

  let closeIndex = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      closeIndex = index
      break
    }
  }

  if (closeIndex < 0) {
    return {
      ok: false,
      message: 'Template frontmatter is not terminated by a closing `---`',
      line: 1,
    }
  }

  const frontmatter = lines.slice(1, closeIndex).join('\n')
  const body = lines.slice(closeIndex + 1).join('\n')
  return {
    ok: true,
    frontmatter,
    body,
    bodyStartLine: closeIndex + 2,
  }
}

/**
 * Extract level-2 sections from a markdown body. The returned record
 * maps the heading text (trimmed) to the body lines beneath that
 * heading up to (but not including) the next `##` heading or EOF.
 *
 * Body lines are joined with `\n` and `trim()`-ed at the boundaries.
 * If the same heading appears twice, the later occurrence overwrites
 * the earlier one — we accept this as a small price for not having to
 * surface a `DUPLICATE_SECTION` error in Stage 1.5.
 */
function extractSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {}
  const lines = body.split('\n')

  let currentHeading: string | null = null
  let currentChunk: string[] = []

  const flush = (): void => {
    if (currentHeading !== null) {
      sections[currentHeading] = currentChunk.join('\n').trim()
    }
  }

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match && !line.startsWith('###')) {
      flush()
      currentHeading = match[1]!.trim()
      currentChunk = []
      continue
    }
    if (currentHeading !== null) {
      currentChunk.push(line)
    }
  }
  flush()

  return sections
}
