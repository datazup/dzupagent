/**
 * Tool Schema Registry — versioned registry for tool schemas with
 * backward compatibility checking and documentation generation.
 */

/**
 * A registered tool schema entry with version information.
 */
export interface ToolSchemaEntry {
  /** Tool name. */
  name: string
  /** Semantic version string (e.g., '1.0.0'). */
  version: string
  /** Human-readable description of the tool. */
  description: string
  /** JSON Schema describing the tool's input parameters. */
  inputSchema: Record<string, unknown>
  /** Optional JSON Schema describing the tool's output. */
  outputSchema?: Record<string, unknown>
  /** ISO 8601 timestamp of when the entry was registered. */
  registeredAt: string
}

/**
 * Result of a backward compatibility check between two schema versions.
 */
export interface CompatCheckResult {
  /** Whether the new version is backward compatible with the old. */
  compatible: boolean
  /** List of breaking changes found. */
  breaking: string[]
}

/**
 * Compare two semantic version strings.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  const len = Math.max(pa.length, pb.length)

  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va - vb
  }
  return 0
}

/**
 * Recursively check if a new schema is backward compatible with an old schema.
 *
 * Rules:
 * - Adding optional fields is OK.
 * - Removing required fields is breaking.
 * - Changing a field's type is breaking.
 * - Removing any existing field is breaking.
 */
function checkSchemaCompat(
  oldSchema: Record<string, unknown>,
  newSchema: Record<string, unknown>,
  path: string,
): string[] {
  const breaking: string[] = []

  const oldType = oldSchema['type'] as string | undefined
  const newType = newSchema['type'] as string | undefined

  // Type mismatch
  if (oldType && newType && oldType !== newType) {
    breaking.push(`${path}: type changed from '${oldType}' to '${newType}'`)
    return breaking
  }

  // For object types, check properties
  if (oldType === 'object' || newType === 'object') {
    const oldProps = (oldSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>
    const newProps = (newSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>
    const oldRequired = new Set((oldSchema['required'] ?? []) as string[])
    const newRequired = new Set((newSchema['required'] ?? []) as string[])

    // Check for removed fields
    for (const key of Object.keys(oldProps)) {
      if (!(key in newProps)) {
        breaking.push(`${path}.${key}: field removed`)
      }
    }

    // Check for type changes in existing fields
    for (const key of Object.keys(oldProps)) {
      const oldProp = oldProps[key]
      const newProp = newProps[key]
      if (oldProp && newProp) {
        const nested = checkSchemaCompat(oldProp, newProp, `${path}.${key}`)
        breaking.push(...nested)
      }
    }

    // Check for fields that became required (was optional or didn't exist)
    for (const key of newRequired) {
      if (!oldRequired.has(key) && !(key in oldProps)) {
        // New required field that didn't exist before is breaking
        breaking.push(`${path}.${key}: new required field added`)
      }
    }
  }

  // For arrays, check items schema
  if (oldType === 'array' && newType === 'array') {
    const oldItems = oldSchema['items'] as Record<string, unknown> | undefined
    const newItems = newSchema['items'] as Record<string, unknown> | undefined
    if (oldItems && newItems) {
      const nested = checkSchemaCompat(oldItems, newItems, `${path}[]`)
      breaking.push(...nested)
    }
  }

  return breaking
}

/**
 * Registry for versioned tool schemas.
 *
 * Supports registering multiple versions of a tool, retrieving the latest
 * or a specific version, backward compatibility checking, and
 * automatic documentation generation.
 */
export class ToolSchemaRegistry {
  /** Map of tool name -> sorted array of entries (oldest first). */
  private readonly entries: Map<string, ToolSchemaEntry[]> = new Map()

  /**
   * Register a new tool schema entry.
   *
   * If a tool with the same name and version already exists, it is replaced.
   */
  register(entry: ToolSchemaEntry): void {
    const existing = this.entries.get(entry.name)

    if (!existing) {
      this.entries.set(entry.name, [entry])
      return
    }

    // Replace existing version or add new
    const idx = existing.findIndex((e) => e.version === entry.version)
    if (idx !== -1) {
      existing[idx] = entry
    } else {
      existing.push(entry)
      existing.sort((a, b) => compareSemver(a.version, b.version))
    }
  }

  /**
   * Get a tool schema entry by name and optional version.
   *
   * If no version is specified, returns the latest (highest) version.
   */
  get(name: string, version?: string): ToolSchemaEntry | undefined {
    const entries = this.entries.get(name)
    if (!entries || entries.length === 0) return undefined

    if (version) {
      return entries.find((e) => e.version === version)
    }

    // Return latest (last in sorted array)
    return entries[entries.length - 1]
  }

  /**
   * List all registered entries (all versions of all tools).
   */
  list(): ToolSchemaEntry[] {
    const result: ToolSchemaEntry[] = []
    for (const entries of this.entries.values()) {
      result.push(...entries)
    }
    return result
  }

  /**
   * Check backward compatibility between two versions of a tool.
   *
   * Returns `{ compatible: true, breaking: [] }` if the new version
   * is backward compatible, or `{ compatible: false, breaking: [...] }`
   * with a list of breaking changes.
   */
  checkBackwardCompat(
    name: string,
    oldVersion: string,
    newVersion: string,
  ): CompatCheckResult {
    const oldEntry = this.get(name, oldVersion)
    const newEntry = this.get(name, newVersion)

    if (!oldEntry) {
      return { compatible: false, breaking: [`Version '${oldVersion}' of '${name}' not found`] }
    }
    if (!newEntry) {
      return { compatible: false, breaking: [`Version '${newVersion}' of '${name}' not found`] }
    }

    const breaking = checkSchemaCompat(
      oldEntry.inputSchema,
      newEntry.inputSchema,
      name,
    )

    return {
      compatible: breaking.length === 0,
      breaking,
    }
  }

  /**
   * Generate markdown documentation for all registered tools.
   */
  generateDocs(): string {
    const lines: string[] = ['# Tool Schema Registry', '']

    const toolNames = [...this.entries.keys()].sort()

    for (const name of toolNames) {
      const entries = this.entries.get(name)
      if (!entries || entries.length === 0) continue

      // Use latest version for documentation header
      const latest = entries[entries.length - 1]!
      lines.push(`## ${name}`, '')
      lines.push(`**Description:** ${latest.description}`, '')
      lines.push(`**Latest Version:** ${latest.version}`, '')

      if (entries.length > 1) {
        lines.push(`**All Versions:** ${entries.map((e) => e.version).join(', ')}`, '')
      }

      lines.push('### Input Schema', '')
      lines.push('```json', JSON.stringify(latest.inputSchema, null, 2), '```', '')

      if (latest.outputSchema) {
        lines.push('### Output Schema', '')
        lines.push('```json', JSON.stringify(latest.outputSchema, null, 2), '```', '')
      }

      lines.push('---', '')
    }

    return lines.join('\n')
  }
}
