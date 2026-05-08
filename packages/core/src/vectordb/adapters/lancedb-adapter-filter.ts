/**
 * SQL filter translation for the LanceDB adapter.
 *
 * Converts the framework's normalized {@link MetadataFilter} into a
 * LanceDB-compatible SQL WHERE clause with safe identifier and literal
 * escaping.
 */

import type { MetadataFilter } from '../types.js'

/**
 * Translates a normalized MetadataFilter into a LanceDB SQL WHERE clause.
 *
 * LanceDB uses SQL-like filter expressions on metadata columns.
 */
export function translateFilter(filter: MetadataFilter): string {
  if ('and' in filter) {
    const parts = filter.and.map(translateFilter)
    return `(${parts.join(' AND ')})`
  }
  if ('or' in filter) {
    const parts = filter.or.map(translateFilter)
    return `(${parts.join(' OR ')})`
  }

  const { field, op, value } = filter
  const escaped = escapeIdentifier(field)

  switch (op) {
    case 'eq':
      return `${escaped} = ${escapeLiteral(value)}`
    case 'neq':
      return `${escaped} != ${escapeLiteral(value)}`
    case 'gt':
      return `${escaped} > ${String(value)}`
    case 'gte':
      return `${escaped} >= ${String(value)}`
    case 'lt':
      return `${escaped} < ${String(value)}`
    case 'lte':
      return `${escaped} <= ${String(value)}`
    case 'in': {
      const items = value.map(escapeLiteral).join(', ')
      return `${escaped} IN (${items})`
    }
    case 'not_in': {
      const items = value.map(escapeLiteral).join(', ')
      return `${escaped} NOT IN (${items})`
    }
    case 'contains':
      return `${escaped} LIKE ${escapeLiteral(`%${value}%`)}`
  }
}

/** Escape a SQL identifier (column name) */
function escapeIdentifier(name: string): string {
  // Double-quote identifiers to handle reserved words and special chars
  return `"${name.replace(/"/g, '""')}"`
}

/** Escape a SQL literal value */
function escapeLiteral(value: string | number | boolean): string {
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  // String: single-quote with escaping
  return `'${value.replace(/'/g, "''")}'`
}
