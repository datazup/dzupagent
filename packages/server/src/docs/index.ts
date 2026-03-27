/**
 * Documentation generation barrel.
 *
 * @module docs
 */

export { DocGenerator } from './doc-generator.js'
export type { DocGeneratorConfig, DocGeneratorContext } from './doc-generator.js'
export { renderAgentDoc } from './agent-doc.js'
export type { AgentDocInput } from './agent-doc.js'
export { renderToolDoc } from './tool-doc.js'
export type { ToolDocInput } from './tool-doc.js'
export { renderPipelineDoc } from './pipeline-doc.js'
export type { PipelineDocInput, PipelineDocNode, PipelineDocEdge } from './pipeline-doc.js'
