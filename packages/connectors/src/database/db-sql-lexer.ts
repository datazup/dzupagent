/**
 * Database connector — SQL lexical scanning primitives.
 *
 * Low-level, dialect-aware scanners that understand PostgreSQL string
 * literals, identifier quoting, dollar-quoting, and comments. Used by the
 * read-only safety policy in {@link ./db-sql-safety.js} to reason about
 * statement shape without being fooled by quoted/commented content.
 */

function readDollarQuoteTagAt(sql: string, index: number): string | null {
  if (sql[index] !== '$') return null
  const end = sql.indexOf('$', index + 1)
  if (end === -1) return null
  const inner = sql.slice(index + 1, end)
  if (inner.length === 0) return '$$'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return null
  return `$${inner}$`
}

/**
 * Split SQL into top-level (`;`-delimited, paren-depth-0) statements,
 * ignoring separators that appear inside string literals, quoted
 * identifiers, comments, or dollar-quoted blocks.
 */
export function splitTopLevelStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0
  let parenDepth = 0
  let inSingleQuote = false
  let inDoubleQuote = false
  let inLineComment = false
  let blockCommentDepth = 0
  let dollarTag: string | null = null

  while (i < sql.length) {
    const ch = sql[i]!
    const next = i + 1 < sql.length ? sql[i + 1]! : ''

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag
        i += dollarTag.length
        dollarTag = null
        continue
      }
      current += ch
      i += 1
      continue
    }

    if (inSingleQuote) {
      current += ch
      if (ch === "'" && next === "'") {
        current += next
        i += 2
        continue
      }
      if (ch === "'") inSingleQuote = false
      i += 1
      continue
    }

    if (inDoubleQuote) {
      current += ch
      if (ch === '"' && next === '"') {
        current += next
        i += 2
        continue
      }
      if (ch === '"') inDoubleQuote = false
      i += 1
      continue
    }

    if (inLineComment) {
      current += ch
      if (ch === '\n') inLineComment = false
      i += 1
      continue
    }

    if (blockCommentDepth > 0) {
      current += ch
      if (ch === '/' && next === '*') {
        blockCommentDepth += 1
        current += next
        i += 2
        continue
      }
      if (ch === '*' && next === '/') {
        blockCommentDepth -= 1
        current += next
        i += 2
        continue
      }
      i += 1
      continue
    }

    if (ch === '-' && next === '-') {
      current += ch + next
      inLineComment = true
      i += 2
      continue
    }

    if (ch === '/' && next === '*') {
      current += ch + next
      blockCommentDepth = 1
      i += 2
      continue
    }

    const tag = readDollarQuoteTagAt(sql, i)
    if (tag) {
      dollarTag = tag
      current += tag
      i += tag.length
      continue
    }

    if (ch === "'") {
      inSingleQuote = true
      current += ch
      i += 1
      continue
    }

    if (ch === '"') {
      inDoubleQuote = true
      current += ch
      i += 1
      continue
    }

    if (ch === '(') parenDepth += 1
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)

    if (ch === ';' && parenDepth === 0) {
      const trimmed = current.trim()
      if (trimmed.length > 0) statements.push(trimmed)
      current = ''
      i += 1
      continue
    }

    current += ch
    i += 1
  }

  const trailing = current.trim()
  if (trailing.length > 0) statements.push(trailing)
  return statements
}

/**
 * Replace string literals, quoted identifiers, comments, and dollar-quoted
 * blocks with whitespace of equal length (preserving newlines), so keyword
 * scanning cannot be tricked by characters embedded in quoted/commented text.
 */
export function maskSqlLiteralsAndComments(sql: string): string {
  let out = ''
  let i = 0
  let inSingleQuote = false
  let inDoubleQuote = false
  let inLineComment = false
  let blockCommentDepth = 0
  let dollarTag: string | null = null

  while (i < sql.length) {
    const ch = sql[i]!
    const next = i + 1 < sql.length ? sql[i + 1]! : ''

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        out += ' '.repeat(dollarTag.length)
        i += dollarTag.length
        dollarTag = null
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }

    if (inSingleQuote) {
      if (ch === "'" && next === "'") {
        out += '  '
        i += 2
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      if (ch === "'") inSingleQuote = false
      i += 1
      continue
    }

    if (inDoubleQuote) {
      if (ch === '"' && next === '"') {
        out += '  '
        i += 2
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      if (ch === '"') inDoubleQuote = false
      i += 1
      continue
    }

    if (inLineComment) {
      out += ch === '\n' ? '\n' : ' '
      if (ch === '\n') inLineComment = false
      i += 1
      continue
    }

    if (blockCommentDepth > 0) {
      if (ch === '/' && next === '*') {
        blockCommentDepth += 1
        out += '  '
        i += 2
        continue
      }
      if (ch === '*' && next === '/') {
        blockCommentDepth -= 1
        out += '  '
        i += 2
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }

    if (ch === '-' && next === '-') {
      inLineComment = true
      out += '  '
      i += 2
      continue
    }

    if (ch === '/' && next === '*') {
      blockCommentDepth = 1
      out += '  '
      i += 2
      continue
    }

    const tag = readDollarQuoteTagAt(sql, i)
    if (tag) {
      dollarTag = tag
      out += ' '.repeat(tag.length)
      i += tag.length
      continue
    }

    if (ch === "'") {
      inSingleQuote = true
      out += ' '
      i += 1
      continue
    }

    if (ch === '"') {
      inDoubleQuote = true
      out += ' '
      i += 1
      continue
    }

    out += ch
    i += 1
  }

  return out
}

/** Return the uppercased leading SQL keyword, or null if none. */
export function leadingKeyword(sql: string): string | null {
  const match = sql.match(/^\s*([A-Za-z]+)/)
  return match ? match[1]!.toUpperCase() : null
}
