import type { StructuredToolInterface } from '@langchain/core/tools'
import type { CustomToolResolver, ToolResolverContext, ToolSource } from './tool-resolver.js'

export async function applyCustomToolResolver(params: {
  context: ToolResolverContext
  customResolver: CustomToolResolver
  tools: StructuredToolInterface[]
  activated: Array<{ name: string; source: ToolSource }>
  unresolved: Set<string>
}): Promise<void> {
  const custom = await params.customResolver(params.context)
  for (const t of custom) {
    const existingIdx = params.tools.findIndex((existing) => existing.name === t.name)
    if (existingIdx >= 0) {
      params.tools[existingIdx] = t
      const activatedIdx = params.activated.findIndex((a) => a.name === t.name)
      if (activatedIdx >= 0) params.activated[activatedIdx] = { name: t.name, source: 'custom' }
    } else {
      params.tools.push(t)
      params.activated.push({ name: t.name, source: 'custom' })
    }
    params.unresolved.delete(t.name)
  }
}
