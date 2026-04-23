/**
 * Template resolution for adapter workflow prompts.
 *
 * Resolves `{{prev}}` and `{{state.key.nested}}` template variables
 * in workflow step prompts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateContext {
  prev?: string | undefined
  state: Record<string, unknown>
}

export interface TemplateReference {
  /** The raw matched string, e.g. "{{state.research}}" */
  raw: string
  /** Parsed path segments, e.g. ["state", "research"] */
  path: string[]
  /** Start index in the template string */
  startIndex: number
  /** End index (exclusive) in the template string */
  endIndex: number
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const TEMPLATE_PATTERN = /\{\{([a-zA-Z0-9_.]+)\}\}/g

// ---------------------------------------------------------------------------
// WorkflowStepResolver
// ---------------------------------------------------------------------------

/**
 * Resolves template variables in workflow step prompts.
 * Supports `{{prev}}` for previous step result and `{{state.key.nested}}` for state access.
 */
export class WorkflowStepResolver {
  /**
   * Resolve all `{{...}}` template variables in a string.
   *
   * - `{{prev}}` is replaced with `context.prev` (or empty string).
   * - `{{state.key}}` / `{{state.key.nested}}` is resolved via dotted-path
   *   lookup against `context.state`.
   * - Unresolvable references are replaced with an empty string.
   */
  resolve(template: string, context: TemplateContext): string {
    let resolved = template

    // Replace {{prev}}
    resolved = resolved.replace(/\{\{prev\}\}/g, context.prev ?? '')

    // Replace {{state.x.y.z}} with dotted path resolution
    resolved = resolved.replace(
      /\{\{state\.([a-zA-Z0-9_.]+)\}\}/g,
      (_match: string, key: string) => {
        const value = this.resolveStatePath(context.state, key)
        if (value === undefined) return ''
        return typeof value === 'string' ? value : JSON.stringify(value)
      },
    )

    return resolved
  }

  /**
   * Extract all variable references from a template string.
   */
  extractReferences(template: string): TemplateReference[] {
    const refs: TemplateReference[] = []
    const pattern = new RegExp(TEMPLATE_PATTERN.source, 'g')
    let match: RegExpExecArray | null

    while ((match = pattern.exec(template)) !== null) {
      const raw = match[0]!
      const inner = match[1]!
      refs.push({
        raw,
        path: inner.split('.'),
        startIndex: match.index,
        endIndex: match.index + raw.length,
      })
    }

    return refs
  }

  /**
   * Validate that template references can be resolved against available keys.
   * Returns an array of unresolvable references.
   */
  validate(template: string, availableKeys: string[]): TemplateReference[] {
    const refs = this.extractReferences(template)
    const unresolvable: TemplateReference[] = []

    for (const ref of refs) {
      if (ref.path[0] === 'prev') {
        // {{prev}} is always available
        continue
      }

      if (ref.path[0] === 'state' && ref.path.length >= 2) {
        // Check if the top-level state key is available
        const stateKey = ref.path[1]!
        if (!availableKeys.includes(stateKey)) {
          unresolvable.push(ref)
        }
        continue
      }

      // Unknown pattern
      unresolvable.push(ref)
    }

    return unresolvable
  }

  /**
   * Resolve a dotted path against a state object.
   * E.g. "foo.bar" resolves state.foo.bar.
   */
  private resolveStatePath(state: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.')
    let current: unknown = state

    for (const part of parts) {
      if (current === null || current === undefined) return undefined
      if (typeof current !== 'object') return undefined
      current = (current as Record<string, unknown>)[part]
    }

    return current
  }
}
