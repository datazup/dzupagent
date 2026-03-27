/**
 * Extended Arrow frame schemas and builders for agentic workflows.
 */

export {
  TOOL_RESULT_SCHEMA,
  ToolResultFrameBuilder,
} from './tool-result-frame.js'
export type { ToolResultEntry } from './tool-result-frame.js'

export {
  CODEGEN_FRAME_SCHEMA,
  CodegenFrameBuilder,
} from './codegen-frame.js'
export type { CodegenFileEntry } from './codegen-frame.js'

export {
  EVAL_FRAME_SCHEMA,
  EvalFrameBuilder,
} from './eval-frame.js'
export type { EvalResultEntry } from './eval-frame.js'

export {
  ENTITY_GRAPH_SCHEMA,
  EntityGraphFrameBuilder,
} from './entity-graph-frame.js'
export type { EntityGraphEntry } from './entity-graph-frame.js'
