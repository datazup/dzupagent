interface YamlLine {
  indent: number
  content: string
  lineNo: number
}

export interface YamlParseError {
  code: 'INVALID_YAML_SUBSET'
  message: string
  line: number
  column: number
}

export type YamlParseResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: YamlParseError[] }

type TokenizeResult =
  | { ok: true; value: YamlLine[] }
  | { ok: false; errors: YamlParseError[] }

export function parseYamlSubset(source: string): YamlParseResult {
  const lines = tokenize(source)
  if (!lines.ok) return lines
  const normalizedLines = lines.value
  if (normalizedLines.length === 0) {
    return { ok: true, value: {} }
  }

  const parsed = parseBlock(normalizedLines, 0, normalizedLines[0]!.indent)
  if (!parsed.ok) return parsed
  if (parsed.nextIndex !== normalizedLines.length) {
    const next = normalizedLines[parsed.nextIndex]!
    return {
      ok: false,
      errors: [{
        code: 'INVALID_YAML_SUBSET',
        message: `Unexpected trailing content at line ${next.lineNo}`,
        line: next.lineNo,
        column: next.indent + 1,
      }],
    }
  }
  return { ok: true, value: parsed.value }
}

function tokenize(source: string): TokenizeResult {
  const errors: YamlParseError[] = []
  const lines: YamlLine[] = []
  const rawLines = source.replace(/\r\n/g, '\n').split('\n')

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? ''
    if (raw.includes('\t')) {
      errors.push({
        code: 'INVALID_YAML_SUBSET',
        message: 'Tabs are not supported in dzupflow YAML',
        line: index + 1,
        column: raw.indexOf('\t') + 1,
      })
      continue
    }
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const indent = raw.match(/^ */)?.[0].length ?? 0
    lines.push({ indent, content: raw.slice(indent), lineNo: index + 1 })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: lines }
}

type BlockParseResult =
  | { ok: true; value: unknown; nextIndex: number }
  | { ok: false; errors: YamlParseError[] }

function parseBlock(lines: YamlLine[], startIndex: number, indent: number): BlockParseResult {
  const current = lines[startIndex]
  if (!current) return { ok: true, value: {}, nextIndex: startIndex }
  if (current.indent !== indent) {
    return {
      ok: false,
      errors: [{
        code: 'INVALID_YAML_SUBSET',
        message: `Unexpected indentation at line ${current.lineNo}`,
        line: current.lineNo,
        column: current.indent + 1,
      }],
    }
  }
  if (current.content.startsWith('- ')) {
    return parseSequence(lines, startIndex, indent)
  }
  return parseMapping(lines, startIndex, indent)
}

function parseSequence(lines: YamlLine[], startIndex: number, indent: number): BlockParseResult {
  const items: unknown[] = []
  let index = startIndex

  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent < indent) break
    if (line.indent !== indent) {
      return unexpectedIndent(line)
    }
    if (!line.content.startsWith('- ')) break

    const rest = line.content.slice(2).trimEnd()
    if (rest.length === 0) {
      const nested = parseNested(lines, index + 1, indent + 2)
      if (!nested.ok) return nested
      items.push(nested.value)
      index = nested.nextIndex
      continue
    }

    const keyOnly = /^([A-Za-z_][\w-]*):\s*$/.exec(rest)
    if (keyOnly) {
      const nested = parseNested(lines, index + 1, indent + 4)
      if (!nested.ok) return nested
      items.push({ [keyOnly[1]!]: nested.value })
      index = nested.nextIndex
      continue
    }

    const keyValue = /^([A-Za-z_][\w-]*):\s+(.+)$/.exec(rest)
    if (keyValue) {
      items.push({ [keyValue[1]!]: parseScalar(keyValue[2]!) })
      index += 1
      continue
    }

    items.push(parseScalar(rest))
    index += 1
  }

  return { ok: true, value: items, nextIndex: index }
}

function parseMapping(lines: YamlLine[], startIndex: number, indent: number): BlockParseResult {
  const obj: Record<string, unknown> = {}
  let index = startIndex

  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent < indent) break
    if (line.indent !== indent) {
      return unexpectedIndent(line)
    }
    if (line.content.startsWith('- ')) break

    const match = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line.content)
    if (!match) {
      return {
        ok: false,
        errors: [{
          code: 'INVALID_YAML_SUBSET',
          message: `Invalid mapping entry at line ${line.lineNo}`,
          line: line.lineNo,
          column: line.indent + 1,
        }],
      }
    }

    const key = match[1]!
    const rawValue = match[2]
    if (rawValue === undefined || rawValue.length === 0) {
      const nested = parseNested(lines, index + 1, indent + 2)
      if (!nested.ok) return nested
      obj[key] = nested.value
      index = nested.nextIndex
      continue
    }

    if (rawValue === '|') {
      const block = parseLiteralBlock(lines, index + 1, indent + 2)
      obj[key] = block.value
      index = block.nextIndex
      continue
    }

    obj[key] = parseScalar(rawValue)
    index += 1
  }

  return { ok: true, value: obj, nextIndex: index }
}

function parseNested(lines: YamlLine[], startIndex: number, indent: number): BlockParseResult {
  const next = lines[startIndex]
  if (!next || next.indent < indent) return { ok: true, value: {}, nextIndex: startIndex }
  return parseBlock(lines, startIndex, indent)
}

function parseLiteralBlock(
  lines: YamlLine[],
  startIndex: number,
  indent: number,
): { value: string; nextIndex: number } {
  const chunks: string[] = []
  let index = startIndex
  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent < indent) break
    if (line.indent !== indent) break
    chunks.push(line.content)
    index += 1
  }
  return { value: chunks.join('\n'), nextIndex: index }
}

function parseScalar(raw: string): unknown {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner.length === 0) return []
    return inner.split(',').map((part) => parseScalar(part.trim()))
  }
  return value
}

function unexpectedIndent(line: YamlLine): BlockParseResult {
  return {
    ok: false,
    errors: [{
      code: 'INVALID_YAML_SUBSET',
      message: `Unexpected indentation at line ${line.lineNo}`,
      line: line.lineNo,
      column: line.indent + 1,
    }],
  }
}
