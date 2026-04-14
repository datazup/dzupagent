/**
 * Incremental code generation — generates only changed sections instead of full files.
 * Splits files into logical sections (imports, functions, classes, etc.) and applies
 * targeted changes to minimize token usage and preserve surrounding code.
 */

export interface CodeSection {
  /** Section identifier (function name, class name, etc.) */
  name: string
  /** Start line in original file (1-based) */
  startLine: number
  /** End line in original file (1-based) */
  endLine: number
  /** The section content */
  content: string
  /** Section type */
  type: 'import' | 'function' | 'class' | 'interface' | 'type' | 'const' | 'other'
}

export interface IncrementalChange {
  section: string
  operation: 'add' | 'replace' | 'delete'
  /** New content (for add/replace) */
  newContent?: string
  /** Line position to insert after (for add) */
  insertAfterLine?: number
}

export interface IncrementalResult {
  /** Full file content after applying changes */
  content: string
  /** Changes that were applied */
  changes: IncrementalChange[]
  /** Lines preserved from original */
  preservedLines: number
  /** Lines changed */
  changedLines: number
}

type SectionType = CodeSection['type']

interface SectionPattern {
  regex: RegExp
  type: SectionType
  nameGroup: number
}

const SECTION_PATTERNS: SectionPattern[] = [
  { regex: /^import\s+/, type: 'import', nameGroup: 0 },
  { regex: /^(?:export\s)?(?:async\s)?function\s+(\w+)/, type: 'function', nameGroup: 1 },
  { regex: /^(?:export\s)?class\s+(\w+)/, type: 'class', nameGroup: 1 },
  { regex: /^(?:export\s)?interface\s+(\w+)/, type: 'interface', nameGroup: 1 },
  { regex: /^(?:export\s)?type\s+(\w+)/, type: 'type', nameGroup: 1 },
  { regex: /^(?:export\s)?(?:const|let|var)\s+(\w+)/, type: 'const', nameGroup: 1 },
  { regex: /^(?:export\s)?enum\s+(\w+)/, type: 'const', nameGroup: 1 },
]

function classifyLine(trimmed: string): { type: SectionType; name: string } | undefined {
  for (const pattern of SECTION_PATTERNS) {
    const match = pattern.regex.exec(trimmed)
    if (match) {
      const name = pattern.nameGroup === 0 ? 'imports' : (match[pattern.nameGroup] ?? 'unknown')
      return { type: pattern.type, name }
    }
  }
  return undefined
}

/**
 * Track brace depth to find where a top-level declaration ends.
 */
function findSectionEnd(lines: string[], startIdx: number): number {
  let depth = 0
  let foundOpen = false
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? ''
    for (const ch of line) {
      if (ch === '{') { depth++; foundOpen = true }
      else if (ch === '}') { depth-- }
    }
    if (foundOpen && depth <= 0) return i
    // Single-line declarations (type aliases, simple const, imports without braces)
    if (!foundOpen && i > startIdx) return i - 1
    if (!foundOpen && i === startIdx && (line.includes(';') || (!line.includes('{') && !line.trimEnd().endsWith(',')))) {
      // Merge consecutive import lines into one block
      const startLine = lines[startIdx] ?? ''
      if (startLine.trimStart().startsWith('import')) {
        let j = i + 1
        while (j < lines.length && (lines[j] ?? '').trimStart().startsWith('import')) { j++ }
        return j - 1
      }
      return i
    }
  }
  return lines.length - 1
}

/**
 * Split a file into logical sections (imports, functions, classes, etc.).
 */
export function splitIntoSections(content: string, _filePath?: string): CodeSection[] {
  const lines = content.split('\n')
  const sections: CodeSection[] = []
  let i = 0

  while (i < lines.length) {
    const trimmed = (lines[i] ?? '').trimStart()
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      i++
      continue
    }

    const classification = classifyLine(trimmed)
    if (classification) {
      // Merge consecutive imports into a single section
      const existingImport = classification.type === 'import'
        ? sections.find((s) => s.type === 'import' && s.name === 'imports')
        : undefined

      const endIdx = findSectionEnd(lines, i)
      const sectionContent = lines.slice(i, endIdx + 1).join('\n')

      if (existingImport) {
        existingImport.endLine = endIdx + 1
        existingImport.content += '\n' + sectionContent
      } else {
        sections.push({
          name: classification.name,
          startLine: i + 1,
          endLine: endIdx + 1,
          content: sectionContent,
          type: classification.type,
        })
      }
      i = endIdx + 1
    } else {
      i++
    }
  }

  return sections
}

/**
 * Detect which sections need updating based on a change description.
 */
export function detectAffectedSections(
  sections: CodeSection[],
  changeDescription: string,
): CodeSection[] {
  const lower = changeDescription.toLowerCase()
  const tokens = lower.split(/[\s,;.(){}[\]]+/).filter((t) => t.length > 2)

  const affected = sections.filter((section) => {
    if (section.type === 'import') return false
    const nameLower = section.name.toLowerCase()
    return tokens.some((token) => nameLower.includes(token) || token.includes(nameLower))
  })

  // Include import section if any non-import section is affected
  if (affected.length > 0) {
    const importSection = sections.find((s) => s.type === 'import')
    if (importSection && !affected.includes(importSection)) {
      affected.unshift(importSection)
    }
  }

  return affected
}

/**
 * Apply incremental changes to file content.
 * Preserves surrounding code structure.
 */
export function applyIncrementalChanges(
  originalContent: string,
  changes: IncrementalChange[],
): IncrementalResult {
  const lines = originalContent.split('\n')
  const sections = splitIntoSections(originalContent)
  const applied: IncrementalChange[] = []
  let changedLines = 0

  // Sort by line position descending so splicing does not shift later indices
  const sorted = [...changes].sort((a, b) => {
    const secA = sections.find((s) => s.name === a.section)
    const secB = sections.find((s) => s.name === b.section)
    const lineA = a.insertAfterLine ?? secA?.startLine ?? 0
    const lineB = b.insertAfterLine ?? secB?.startLine ?? 0
    return lineB - lineA
  })

  for (const change of sorted) {
    const section = sections.find((s) => s.name === change.section)

    if (change.operation === 'replace' && section && change.newContent !== undefined) {
      const newLines = change.newContent.split('\n')
      const count = section.endLine - section.startLine + 1
      lines.splice(section.startLine - 1, count, ...newLines)
      changedLines += Math.max(count, newLines.length)
      applied.push(change)
    } else if (change.operation === 'delete' && section) {
      const count = section.endLine - section.startLine + 1
      lines.splice(section.startLine - 1, count)
      changedLines += count
      applied.push(change)
    } else if (change.operation === 'add' && change.newContent !== undefined) {
      const insertAt = change.insertAfterLine ?? (section ? section.endLine : lines.length)
      const newLines = change.newContent.split('\n')
      lines.splice(insertAt, 0, ...newLines)
      changedLines += newLines.length
      applied.push(change)
    }
  }

  const totalLines = originalContent.split('\n').length
  return {
    content: lines.join('\n'),
    changes: applied,
    preservedLines: Math.max(0, totalLines - changedLines),
    changedLines,
  }
}

/**
 * Build a focused prompt for incremental generation.
 * Only includes affected sections + imports (not full file).
 */
export function buildIncrementalPrompt(
  filePath: string,
  sections: CodeSection[],
  affectedSections: CodeSection[],
  changeDescription: string,
): string {
  const unaffected = sections
    .filter((s) => !affectedSections.includes(s))
    .map((s) => `  - ${s.type} "${s.name}" (lines ${s.startLine}-${s.endLine})`)
    .join('\n')

  const affected = affectedSections
    .map((s) => `### ${s.type}: ${s.name} (lines ${s.startLine}-${s.endLine})\n\`\`\`\n${s.content}\n\`\`\``)
    .join('\n\n')

  return [
    `## Incremental Edit: ${filePath}`,
    '',
    `### Change Required`,
    changeDescription,
    '',
    `### Sections to Modify`,
    affected,
    '',
    `### Unchanged Sections (do NOT regenerate)`,
    unaffected || '  (none)',
    '',
    'Return ONLY the modified sections. Preserve function signatures unless the change requires altering them.',
  ].join('\n')
}
