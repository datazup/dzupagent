/**
 * Hierarchical prompt template resolver with pluggable storage.
 *
 * The PromptStore interface is implemented by consumers (e.g., PrismaPromptStore).
 * The resolver handles the priority chain and variable substitution.
 */
import type {
  StoredTemplate,
  TemplateContext,
  TemplateVariable,
  ResolvedPrompt,
  PromptResolveQuery,
  BulkPromptQuery,
} from './template-types.js'
import { resolveTemplate } from './template-engine.js'
import type { PromptCache } from './template-cache.js'

/** Abstract prompt storage interface — implemented by consumers */
export interface PromptStore {
  findTemplate(query: PromptResolveQuery): Promise<StoredTemplate | null>
  findAllTemplates(query: BulkPromptQuery): Promise<StoredTemplate[]>
}

/** Resolution hierarchy level */
export type ResolutionLevel =
  | 'override'
  | 'user+category'
  | 'user'
  | 'tenant+category'
  | 'tenant'
  | 'builtin+category'
  | 'builtin'

const DEFAULT_HIERARCHY: ResolutionLevel[] = [
  'override', 'user+category', 'user', 'tenant+category', 'tenant', 'builtin+category', 'builtin',
]

/**
 * Hierarchical prompt resolver. Queries a PromptStore through a configurable
 * priority chain, then applies variable substitution.
 */
export class PromptResolver {
  constructor(
    private store: PromptStore,
    private hierarchy: ResolutionLevel[] = DEFAULT_HIERARCHY,
  ) {}

  /**
   * Resolve a prompt template for a given type, applying the hierarchy chain
   * and variable substitution.
   */
  async resolve(
    query: PromptResolveQuery,
    context: TemplateContext,
    cache?: PromptCache | null,
  ): Promise<ResolvedPrompt> {
    let template: StoredTemplate | null = null

    // 1. Check explicit override
    if (query.templateId && this.hierarchy.includes('override')) {
      template = await this.store.findTemplate({ ...query, templateId: query.templateId })
    }

    // 2. Check cache before DB queries
    if (!template && cache) {
      const cached = cache.get(query.type, query.category)
      if (cached) {
        return this.applyTemplate(cached, context)
      }
    }

    // 3. Walk the hierarchy
    if (!template) {
      template = await this.store.findTemplate(query)
    }

    if (template) {
      return this.applyTemplate(template, context)
    }

    // 4. No template found — return empty
    return { content: '', config: {} }
  }

  /** Apply variable substitution to a stored template */
  private applyTemplate(template: StoredTemplate, context: TemplateContext): ResolvedPrompt {
    const declaredVars: TemplateVariable[] = Array.isArray(template.variables)
      ? template.variables
      : []

    const content = resolveTemplate(template.content, context, {
      variables: declaredVars,
    })

    const config = template.config && typeof template.config === 'object'
      ? template.config
      : {}

    return { content, config }
  }
}
