import type { TemplateManifest, TemplateType } from '../types.js'
import { minimalTemplate } from './minimal.js'
import { fullStackTemplate } from './full-stack.js'
import { codegenTemplate } from './codegen.js'
import { multiAgentTemplate } from './multi-agent.js'
import { serverTemplate } from './server.js'

export const templateRegistry: Record<TemplateType, TemplateManifest> = {
  'minimal': minimalTemplate,
  'full-stack': fullStackTemplate,
  'codegen': codegenTemplate,
  'multi-agent': multiAgentTemplate,
  'server': serverTemplate,
}

export function getTemplate(id: TemplateType): TemplateManifest {
  const manifest = templateRegistry[id]
  if (!manifest) {
    throw new Error(`Unknown template: ${id}`)
  }
  return manifest
}

export function listTemplates(): TemplateManifest[] {
  return Object.values(templateRegistry)
}

export {
  minimalTemplate,
  fullStackTemplate,
  codegenTemplate,
  multiAgentTemplate,
  serverTemplate,
}
