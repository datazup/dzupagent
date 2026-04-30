import type {
  FlowNode,
  SequenceNode,
  ActionNode,
  ForEachNode,
  BranchNode,
  ApprovalNode,
  ClarificationNode,
  PersonaNode,
  RouteNode,
  ParallelNode,
  CompleteNode,
  SpawnNode,
  ClassifyNode,
  EmitNode,
  MemoryNode,
  CheckpointNode,
  RestoreNode,
} from './types.js'
import { FLOW_NODE_KINDS } from './types.js'

export type ParseInput = string | object

export type ParseErrorCode =
  | 'INVALID_JSON'
  | 'NOT_AN_OBJECT'
  | 'MISSING_TYPE'
  | 'UNKNOWN_NODE_TYPE'
  | 'WRONG_FIELD_TYPE'
  | 'EXPECTED_ARRAY'
  | 'EXPECTED_OBJECT'

export interface ParseError {
  code: ParseErrorCode
  message: string
  /** Line/column when input was a string; undefined when input was a pre-parsed object. */
  position?: { line: number; column: number }
  /** JSON pointer path (RFC 6901-style, "/nodes/0/body/2") — always populated. */
  pointer: string
}

export interface ParseResult {
  /** Parsed AST. Present even when errors are non-empty IF the parser could recover; otherwise null. */
  ast: FlowNode | null
  errors: ParseError[]
}

const KNOWN_NODE_TYPES = new Set<string>(FLOW_NODE_KINDS)

interface ParseContext {
  errors: ParseError[]
  /** Line/column tracking is available only when the original input was a string. */
  hasPositions: boolean
}

/**
 * Parse a flow definition into a FlowNode AST.
 *
 * Accepts JSON (string) or a pre-parsed plain object. Errors are aggregated, not thrown —
 * the parser walks the entire structure and reports every issue it can recognise in one pass.
 *
 * If `ast` is non-null and `errors` is non-empty, the AST is partial: shape-recoverable
 * subtrees were preserved, unrecoverable nodes were dropped (and reported).
 */
export function parseFlow(input: ParseInput): ParseResult {
  const ctx: ParseContext = { errors: [], hasPositions: typeof input === 'string' }

  let raw: unknown
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const position = extractJsonErrorPosition(message, input)
      const error: ParseError = {
        code: 'INVALID_JSON',
        message,
        pointer: '',
      }
      if (position) error.position = position
      return { ast: null, errors: [error] }
    }
  } else {
    raw = input
  }

  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: 'NOT_AN_OBJECT',
      message: `Expected top-level value to be an object, received ${describeJsType(raw)}`,
      pointer: '',
    })
    return { ast: null, errors: ctx.errors }
  }

  const ast = parseNode(raw, '', ctx)
  return { ast, errors: ctx.errors }
}

// ------------------------------------------------------------------
// Core walker
// ------------------------------------------------------------------

function parseNode(value: unknown, pointer: string, ctx: ParseContext): FlowNode | null {
  if (!isPlainObject(value)) {
    ctx.errors.push({
      code: 'EXPECTED_OBJECT',
      message: `Expected node object, received ${describeJsType(value)}`,
      pointer,
    })
    return null
  }

  if (!('type' in value)) {
    ctx.errors.push({
      code: 'MISSING_TYPE',
      message: 'Node is missing required "type" discriminator',
      pointer,
    })
    return null
  }

  const typeValue = value.type
  if (typeof typeValue !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `Field "type" must be a string, received ${describeJsType(typeValue)}`,
      pointer: joinPointer(pointer, 'type'),
    })
    return null
  }

  if (!KNOWN_NODE_TYPES.has(typeValue)) {
    ctx.errors.push({
      code: 'UNKNOWN_NODE_TYPE',
      message: `Unknown node type "${typeValue}"`,
      pointer,
    })
    return null
  }

  switch (typeValue) {
    case 'sequence':
      return parseSequence(value, pointer, ctx)
    case 'action':
      return parseAction(value, pointer, ctx)
    case 'for_each':
      return parseForEach(value, pointer, ctx)
    case 'branch':
      return parseBranch(value, pointer, ctx)
    case 'approval':
      return parseApproval(value, pointer, ctx)
    case 'clarification':
      return parseClarification(value, pointer, ctx)
    case 'persona':
      return parsePersona(value, pointer, ctx)
    case 'route':
      return parseRoute(value, pointer, ctx)
    case 'parallel':
      return parseParallel(value, pointer, ctx)
    case 'complete':
      return parseComplete(value, pointer, ctx)
    case 'spawn':
      return parseSpawn(value, pointer, ctx)
    case 'classify':
      return parseClassify(value, pointer, ctx)
    case 'emit':
      return parseEmit(value, pointer, ctx)
    case 'memory':
      return parseMemory(value, pointer, ctx)
    case 'checkpoint':
      return parseCheckpoint(value, pointer, ctx)
    case 'restore':
      return parseRestore(value, pointer, ctx)
    default:
      // Defensive — KNOWN_NODE_TYPES is the source of truth above.
      ctx.errors.push({
        code: 'UNKNOWN_NODE_TYPE',
        message: `Unknown node type "${typeValue}"`,
        pointer,
      })
      return null
  }
}

// ------------------------------------------------------------------
// Per-node parsers
// ------------------------------------------------------------------

function parseSequence(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): SequenceNode | null {
  const nodesRaw = obj.nodes
  if (!Array.isArray(nodesRaw)) {
    ctx.errors.push({
      code: nodesRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `sequence.nodes must be an array, received ${describeJsType(nodesRaw)}`,
      pointer: joinPointer(pointer, 'nodes'),
    })
    return null
  }
  const nodes = parseNodeArray(nodesRaw, joinPointer(pointer, 'nodes'), ctx)
  return {
    type: 'sequence',
    ...parseCommonNodeFields(obj, pointer, ctx),
    nodes,
  }
}

function parseAction(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): ActionNode | null {
  const toolRefRaw = obj.toolRef
  const inputRaw = obj.input
  let failed = false

  if (typeof toolRefRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `action.toolRef must be a string, received ${describeJsType(toolRefRaw)}`,
      pointer: joinPointer(pointer, 'toolRef'),
    })
    failed = true
  }

  if (!isPlainObject(inputRaw)) {
    ctx.errors.push({
      code: inputRaw === undefined || inputRaw === null
        ? 'WRONG_FIELD_TYPE'
        : 'EXPECTED_OBJECT',
      message: `action.input must be an object, received ${describeJsType(inputRaw)}`,
      pointer: joinPointer(pointer, 'input'),
    })
    failed = true
  }

  let personaRef: string | undefined
  if ('personaRef' in obj) {
    const personaRaw = obj.personaRef
    if (typeof personaRaw === 'string') {
      personaRef = personaRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `action.personaRef must be a string when present, received ${describeJsType(personaRaw)}`,
        pointer: joinPointer(pointer, 'personaRef'),
      })
      // optional → drop the field, keep the node
    }
  }

  if (failed) return null
  // toolRefRaw and inputRaw are validated above — narrow with type assertions through helpers:
  const node: ActionNode = {
    type: 'action',
    ...parseCommonNodeFields(obj, pointer, ctx),
    toolRef: toolRefRaw as string,
    input: inputRaw as Record<string, unknown>,
  }
  if (personaRef !== undefined) node.personaRef = personaRef
  return node
}

function parseForEach(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): ForEachNode | null {
  const sourceRaw = obj.source
  const asRaw = obj.as
  const bodyRaw = obj.body
  let failed = false

  if (typeof sourceRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `for_each.source must be a string, received ${describeJsType(sourceRaw)}`,
      pointer: joinPointer(pointer, 'source'),
    })
    failed = true
  }
  if (typeof asRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `for_each.as must be a string, received ${describeJsType(asRaw)}`,
      pointer: joinPointer(pointer, 'as'),
    })
    failed = true
  }
  if (!Array.isArray(bodyRaw)) {
    ctx.errors.push({
      code: bodyRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `for_each.body must be an array, received ${describeJsType(bodyRaw)}`,
      pointer: joinPointer(pointer, 'body'),
    })
    failed = true
  }

  if (failed) {
    // Walk body anyway if it's an array, to surface nested errors in document order
    if (Array.isArray(bodyRaw)) {
      parseNodeArray(bodyRaw, joinPointer(pointer, 'body'), ctx)
    }
    return null
  }

  const body = parseNodeArray(bodyRaw as unknown[], joinPointer(pointer, 'body'), ctx)
  return {
    type: 'for_each',
    ...parseCommonNodeFields(obj, pointer, ctx),
    source: sourceRaw as string,
    as: asRaw as string,
    body,
  }
}

function parseBranch(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): BranchNode | null {
  const conditionRaw = obj.condition
  const thenRaw = obj.then
  let failed = false

  if (typeof conditionRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `branch.condition must be a string, received ${describeJsType(conditionRaw)}`,
      pointer: joinPointer(pointer, 'condition'),
    })
    failed = true
  }
  if (!Array.isArray(thenRaw)) {
    ctx.errors.push({
      code: thenRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `branch.then must be an array, received ${describeJsType(thenRaw)}`,
      pointer: joinPointer(pointer, 'then'),
    })
    failed = true
  }

  let elseBranch: FlowNode[] | undefined
  let elseDropped = false
  if ('else' in obj) {
    const elseRaw = obj.else
    if (Array.isArray(elseRaw)) {
      // We'll walk it after we know whether the node will survive.
    } else {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `branch.else must be an array when present, received ${describeJsType(elseRaw)}`,
        pointer: joinPointer(pointer, 'else'),
      })
      elseDropped = true
    }
  }

  if (failed) {
    if (Array.isArray(thenRaw)) parseNodeArray(thenRaw, joinPointer(pointer, 'then'), ctx)
    if ('else' in obj && Array.isArray(obj.else)) parseNodeArray(obj.else, joinPointer(pointer, 'else'), ctx)
    return null
  }

  const thenNodes = parseNodeArray(thenRaw as unknown[], joinPointer(pointer, 'then'), ctx)
  if ('else' in obj && Array.isArray(obj.else)) {
    elseBranch = parseNodeArray(obj.else, joinPointer(pointer, 'else'), ctx)
  }

  const node: BranchNode = {
    type: 'branch',
    ...parseCommonNodeFields(obj, pointer, ctx),
    condition: conditionRaw as string,
    then: thenNodes,
  }
  if (elseBranch !== undefined && !elseDropped) node.else = elseBranch
  return node
}

function parseApproval(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): ApprovalNode | null {
  const questionRaw = obj.question
  const onApproveRaw = obj.onApprove
  let failed = false

  if (typeof questionRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `approval.question must be a string, received ${describeJsType(questionRaw)}`,
      pointer: joinPointer(pointer, 'question'),
    })
    failed = true
  }
  if (!Array.isArray(onApproveRaw)) {
    ctx.errors.push({
      code: onApproveRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `approval.onApprove must be an array, received ${describeJsType(onApproveRaw)}`,
      pointer: joinPointer(pointer, 'onApprove'),
    })
    failed = true
  }

  let options: string[] | undefined
  if ('options' in obj) {
    const optionsRaw = obj.options
    if (Array.isArray(optionsRaw) && optionsRaw.every((v) => typeof v === 'string')) {
      options = optionsRaw as string[]
    } else if (Array.isArray(optionsRaw)) {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `approval.options must be an array of strings`,
        pointer: joinPointer(pointer, 'options'),
      })
    } else {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `approval.options must be an array when present, received ${describeJsType(optionsRaw)}`,
        pointer: joinPointer(pointer, 'options'),
      })
    }
  }

  if (failed) {
    if (Array.isArray(onApproveRaw)) parseNodeArray(onApproveRaw, joinPointer(pointer, 'onApprove'), ctx)
    if ('onReject' in obj && Array.isArray(obj.onReject)) {
      parseNodeArray(obj.onReject, joinPointer(pointer, 'onReject'), ctx)
    }
    return null
  }

  const onApprove = parseNodeArray(onApproveRaw as unknown[], joinPointer(pointer, 'onApprove'), ctx)

  let onReject: FlowNode[] | undefined
  if ('onReject' in obj) {
    const onRejectRaw = obj.onReject
    if (Array.isArray(onRejectRaw)) {
      onReject = parseNodeArray(onRejectRaw, joinPointer(pointer, 'onReject'), ctx)
    } else {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `approval.onReject must be an array when present, received ${describeJsType(onRejectRaw)}`,
        pointer: joinPointer(pointer, 'onReject'),
      })
    }
  }

  const node: ApprovalNode = {
    type: 'approval',
    ...parseCommonNodeFields(obj, pointer, ctx),
    question: questionRaw as string,
    onApprove,
  }
  if (options !== undefined) node.options = options
  if (onReject !== undefined) node.onReject = onReject
  return node
}

function parseClarification(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): ClarificationNode | null {
  const questionRaw = obj.question
  if (typeof questionRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `clarification.question must be a string, received ${describeJsType(questionRaw)}`,
      pointer: joinPointer(pointer, 'question'),
    })
    return null
  }

  let expected: 'text' | 'choice' | undefined
  if ('expected' in obj) {
    const expectedRaw = obj.expected
    if (expectedRaw === 'text' || expectedRaw === 'choice') {
      expected = expectedRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `clarification.expected must be "text" or "choice" when present, received ${describeJsType(expectedRaw)}`,
        pointer: joinPointer(pointer, 'expected'),
      })
    }
  }

  let choices: string[] | undefined
  if ('choices' in obj) {
    const choicesRaw = obj.choices
    if (Array.isArray(choicesRaw) && choicesRaw.every((v) => typeof v === 'string')) {
      choices = choicesRaw as string[]
    } else if (Array.isArray(choicesRaw)) {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `clarification.choices must be an array of strings`,
        pointer: joinPointer(pointer, 'choices'),
      })
    } else {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `clarification.choices must be an array when present, received ${describeJsType(choicesRaw)}`,
        pointer: joinPointer(pointer, 'choices'),
      })
    }
  }

  const node: ClarificationNode = {
    type: 'clarification',
    ...parseCommonNodeFields(obj, pointer, ctx),
    question: questionRaw,
  }
  if (expected !== undefined) node.expected = expected
  if (choices !== undefined) node.choices = choices
  return node
}

function parsePersona(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): PersonaNode | null {
  const personaIdRaw = obj.personaId
  const bodyRaw = obj.body
  let failed = false

  if (typeof personaIdRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `persona.personaId must be a string, received ${describeJsType(personaIdRaw)}`,
      pointer: joinPointer(pointer, 'personaId'),
    })
    failed = true
  }
  if (!Array.isArray(bodyRaw)) {
    ctx.errors.push({
      code: bodyRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `persona.body must be an array, received ${describeJsType(bodyRaw)}`,
      pointer: joinPointer(pointer, 'body'),
    })
    failed = true
  }

  if (failed) {
    if (Array.isArray(bodyRaw)) parseNodeArray(bodyRaw, joinPointer(pointer, 'body'), ctx)
    return null
  }

  const body = parseNodeArray(bodyRaw as unknown[], joinPointer(pointer, 'body'), ctx)
  return {
    type: 'persona',
    ...parseCommonNodeFields(obj, pointer, ctx),
    personaId: personaIdRaw as string,
    body,
  }
}

function parseRoute(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): RouteNode | null {
  const strategyRaw = obj.strategy
  const bodyRaw = obj.body
  let failed = false

  if (strategyRaw !== 'capability' && strategyRaw !== 'fixed-provider') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `route.strategy must be "capability" or "fixed-provider", received ${describeJsType(strategyRaw)}`,
      pointer: joinPointer(pointer, 'strategy'),
    })
    failed = true
  }
  if (!Array.isArray(bodyRaw)) {
    ctx.errors.push({
      code: bodyRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `route.body must be an array, received ${describeJsType(bodyRaw)}`,
      pointer: joinPointer(pointer, 'body'),
    })
    failed = true
  }

  let tags: string[] | undefined
  if ('tags' in obj) {
    const tagsRaw = obj.tags
    if (Array.isArray(tagsRaw) && tagsRaw.every((v) => typeof v === 'string')) {
      tags = tagsRaw as string[]
    } else if (Array.isArray(tagsRaw)) {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `route.tags must be an array of strings`,
        pointer: joinPointer(pointer, 'tags'),
      })
    } else {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `route.tags must be an array when present, received ${describeJsType(tagsRaw)}`,
        pointer: joinPointer(pointer, 'tags'),
      })
    }
  }

  let provider: string | undefined
  if ('provider' in obj) {
    const providerRaw = obj.provider
    if (typeof providerRaw === 'string') {
      provider = providerRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `route.provider must be a string when present, received ${describeJsType(providerRaw)}`,
        pointer: joinPointer(pointer, 'provider'),
      })
    }
  }

  if (failed) {
    if (Array.isArray(bodyRaw)) parseNodeArray(bodyRaw, joinPointer(pointer, 'body'), ctx)
    return null
  }

  const body = parseNodeArray(bodyRaw as unknown[], joinPointer(pointer, 'body'), ctx)
  const node: RouteNode = {
    type: 'route',
    ...parseCommonNodeFields(obj, pointer, ctx),
    strategy: strategyRaw as 'capability' | 'fixed-provider',
    body,
  }
  if (tags !== undefined) node.tags = tags
  if (provider !== undefined) node.provider = provider
  return node
}

function parseParallel(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): ParallelNode | null {
  const branchesRaw = obj.branches
  if (!Array.isArray(branchesRaw)) {
    ctx.errors.push({
      code: branchesRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `parallel.branches must be an array, received ${describeJsType(branchesRaw)}`,
      pointer: joinPointer(pointer, 'branches'),
    })
    return null
  }

  const branches: FlowNode[][] = []
  for (let i = 0; i < branchesRaw.length; i++) {
    const branchPointer = joinPointer(joinPointer(pointer, 'branches'), String(i))
    const branchVal = branchesRaw[i]
    if (!Array.isArray(branchVal)) {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `parallel.branches[${i}] must be an array of nodes, received ${describeJsType(branchVal)}`,
        pointer: branchPointer,
      })
      continue
    }
    branches.push(parseNodeArray(branchVal, branchPointer, ctx))
  }

  return {
    type: 'parallel',
    ...parseCommonNodeFields(obj, pointer, ctx),
    branches,
  }
}

function parseComplete(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): CompleteNode | null {
  let result: string | undefined
  if ('result' in obj) {
    const resultRaw = obj.result
    if (typeof resultRaw === 'string') {
      result = resultRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `complete.result must be a string when present, received ${describeJsType(resultRaw)}`,
        pointer: joinPointer(pointer, 'result'),
      })
    }
  }
  const node: CompleteNode = {
    type: 'complete',
    ...parseCommonNodeFields(obj, pointer, ctx),
  }
  if (result !== undefined) node.result = result
  return node
}

function parseSpawn(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): SpawnNode | null {
  const templateRefRaw = obj.templateRef
  if (typeof templateRefRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `spawn.templateRef must be a string, received ${describeJsType(templateRefRaw)}`,
      pointer: joinPointer(pointer, 'templateRef'),
    })
    return null
  }

  let input: Record<string, unknown> | undefined
  if ('input' in obj) {
    const inputRaw = obj.input
    if (inputRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (isPlainObject(inputRaw)) {
      input = inputRaw
    } else {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: `spawn.input must be an object when present, received ${describeJsType(inputRaw)}`,
        pointer: joinPointer(pointer, 'input'),
      })
    }
  }

  let waitForCompletion: boolean | undefined
  if ('waitForCompletion' in obj) {
    const waitRaw = obj.waitForCompletion
    if (waitRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (typeof waitRaw === 'boolean') {
      waitForCompletion = waitRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `spawn.waitForCompletion must be a boolean when present, received ${describeJsType(waitRaw)}`,
        pointer: joinPointer(pointer, 'waitForCompletion'),
      })
    }
  }

  const node: SpawnNode = {
    type: 'spawn',
    ...parseCommonNodeFields(obj, pointer, ctx),
    templateRef: templateRefRaw,
  }
  if (input !== undefined) node.input = input
  if (waitForCompletion !== undefined) node.waitForCompletion = waitForCompletion
  return node
}

function parseClassify(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): ClassifyNode | null {
  const promptRaw = obj.prompt
  const choicesRaw = obj.choices
  const outputKeyRaw = obj.outputKey
  let failed = false

  if (typeof promptRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `classify.prompt must be a string, received ${describeJsType(promptRaw)}`,
      pointer: joinPointer(pointer, 'prompt'),
    })
    failed = true
  }
  if (!Array.isArray(choicesRaw)) {
    ctx.errors.push({
      code: choicesRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `classify.choices must be an array, received ${describeJsType(choicesRaw)}`,
      pointer: joinPointer(pointer, 'choices'),
    })
    failed = true
  } else if (!choicesRaw.every((value) => typeof value === 'string')) {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: 'classify.choices must be an array of strings',
      pointer: joinPointer(pointer, 'choices'),
    })
    failed = true
  }
  if (typeof outputKeyRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `classify.outputKey must be a string, received ${describeJsType(outputKeyRaw)}`,
      pointer: joinPointer(pointer, 'outputKey'),
    })
    failed = true
  }

  let defaultChoice: string | undefined
  if ('defaultChoice' in obj) {
    const defaultChoiceRaw = obj.defaultChoice
    if (defaultChoiceRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (typeof defaultChoiceRaw === 'string') {
      defaultChoice = defaultChoiceRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `classify.defaultChoice must be a string when present, received ${describeJsType(defaultChoiceRaw)}`,
        pointer: joinPointer(pointer, 'defaultChoice'),
      })
    }
  }

  if (failed) return null
  const node: ClassifyNode = {
    type: 'classify',
    ...parseCommonNodeFields(obj, pointer, ctx),
    prompt: promptRaw as string,
    choices: choicesRaw as string[],
    outputKey: outputKeyRaw as string,
  }
  if (defaultChoice !== undefined) node.defaultChoice = defaultChoice
  return node
}

function parseEmit(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): EmitNode | null {
  const eventRaw = obj.event
  if (typeof eventRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `emit.event must be a string, received ${describeJsType(eventRaw)}`,
      pointer: joinPointer(pointer, 'event'),
    })
    return null
  }

  let payload: Record<string, unknown> | undefined
  if ('payload' in obj) {
    const payloadRaw = obj.payload
    if (payloadRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (isPlainObject(payloadRaw)) {
      payload = payloadRaw
    } else {
      ctx.errors.push({
        code: 'EXPECTED_OBJECT',
        message: `emit.payload must be an object when present, received ${describeJsType(payloadRaw)}`,
        pointer: joinPointer(pointer, 'payload'),
      })
    }
  }

  const node: EmitNode = {
    type: 'emit',
    ...parseCommonNodeFields(obj, pointer, ctx),
    event: eventRaw,
  }
  if (payload !== undefined) node.payload = payload
  return node
}

function parseMemory(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): MemoryNode | null {
  const operationRaw = obj.operation
  const tierRaw = obj.tier
  let failed = false

  if (operationRaw !== 'read' && operationRaw !== 'write' && operationRaw !== 'list') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `memory.operation must be "read", "write", or "list", received ${describeJsType(operationRaw)}`,
      pointer: joinPointer(pointer, 'operation'),
    })
    failed = true
  }
  if (tierRaw !== 'session' && tierRaw !== 'project' && tierRaw !== 'workspace') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `memory.tier must be "session", "project", or "workspace", received ${describeJsType(tierRaw)}`,
      pointer: joinPointer(pointer, 'tier'),
    })
    failed = true
  }

  const optionalStrings: Pick<MemoryNode, 'key' | 'valueExpr' | 'outputVar'> = {}
  parseOptionalMemoryStringField(obj, 'key', pointer, ctx, (value) => {
    optionalStrings.key = value
  })
  parseOptionalMemoryStringField(obj, 'valueExpr', pointer, ctx, (value) => {
    optionalStrings.valueExpr = value
  })
  parseOptionalMemoryStringField(obj, 'outputVar', pointer, ctx, (value) => {
    optionalStrings.outputVar = value
  })

  if (failed) return null
  return {
    type: 'memory',
    ...parseCommonNodeFields(obj, pointer, ctx),
    operation: operationRaw as 'read' | 'write' | 'list',
    tier: tierRaw as 'session' | 'project' | 'workspace',
    ...optionalStrings,
  }
}

function parseCheckpoint(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): CheckpointNode | null {
  const captureOutputOfRaw = obj.captureOutputOf
  if (typeof captureOutputOfRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `checkpoint.captureOutputOf must be a string, received ${describeJsType(captureOutputOfRaw)}`,
      pointer: joinPointer(pointer, 'captureOutputOf'),
    })
    return null
  }

  let label: string | undefined
  if ('label' in obj) {
    const labelRaw = obj.label
    if (labelRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (typeof labelRaw === 'string') {
      label = labelRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `checkpoint.label must be a string when present, received ${describeJsType(labelRaw)}`,
        pointer: joinPointer(pointer, 'label'),
      })
    }
  }

  const node: CheckpointNode = {
    type: 'checkpoint',
    ...parseCommonNodeFields(obj, pointer, ctx),
    captureOutputOf: captureOutputOfRaw,
  }
  if (label !== undefined) node.label = label
  return node
}

function parseRestore(obj: Record<string, unknown>, pointer: string, ctx: ParseContext): RestoreNode | null {
  const checkpointLabelRaw = obj.checkpointLabel
  if (typeof checkpointLabelRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `restore.checkpointLabel must be a string, received ${describeJsType(checkpointLabelRaw)}`,
      pointer: joinPointer(pointer, 'checkpointLabel'),
    })
    return null
  }

  let onNotFound: 'fail' | 'skip' | undefined
  if ('onNotFound' in obj) {
    const onNotFoundRaw = obj.onNotFound
    if (onNotFoundRaw === undefined) {
      // Treat explicit undefined like an omitted optional field.
    } else if (onNotFoundRaw === 'fail' || onNotFoundRaw === 'skip') {
      onNotFound = onNotFoundRaw
    } else {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `restore.onNotFound must be "fail" or "skip" when present, received ${describeJsType(onNotFoundRaw)}`,
        pointer: joinPointer(pointer, 'onNotFound'),
      })
    }
  }

  const node: RestoreNode = {
    type: 'restore',
    ...parseCommonNodeFields(obj, pointer, ctx),
    checkpointLabel: checkpointLabelRaw,
  }
  if (onNotFound !== undefined) node.onNotFound = onNotFound
  return node
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function parseNodeArray(items: unknown[], basePointer: string, ctx: ParseContext): FlowNode[] {
  const out: FlowNode[] = []
  for (let i = 0; i < items.length; i++) {
    const child = parseNode(items[i], joinPointer(basePointer, String(i)), ctx)
    if (child) out.push(child)
  }
  return out
}

function parseCommonNodeFields(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): Pick<SequenceNode, 'id' | 'name' | 'description' | 'meta'> {
  const fields: Pick<SequenceNode, 'id' | 'name' | 'description' | 'meta'> = {}

  parseOptionalStringField(obj, 'id', pointer, ctx, (value) => {
    fields.id = value
  })
  parseOptionalStringField(obj, 'name', pointer, ctx, (value) => {
    fields.name = value
  })
  parseOptionalStringField(obj, 'description', pointer, ctx, (value) => {
    fields.description = value
  })

  if ('meta' in obj) {
    const metaRaw = obj.meta
    if (metaRaw !== undefined) {
      if (isPlainObject(metaRaw)) {
        fields.meta = metaRaw
      } else {
        ctx.errors.push({
          code: 'EXPECTED_OBJECT',
          message: `Field "meta" must be an object when present, received ${describeJsType(metaRaw)}`,
          pointer: joinPointer(pointer, 'meta'),
        })
      }
    }
  }

  return fields
}

function parseOptionalStringField(
  obj: Record<string, unknown>,
  key: 'id' | 'name' | 'description',
  pointer: string,
  ctx: ParseContext,
  assign: (value: string) => void,
): void {
  if (!(key in obj)) return
  const raw = obj[key]
  if (raw === undefined) return
  if (typeof raw === 'string') {
    assign(raw)
    return
  }
  ctx.errors.push({
    code: 'WRONG_FIELD_TYPE',
    message: `Field "${key}" must be a string when present, received ${describeJsType(raw)}`,
    pointer: joinPointer(pointer, key),
  })
}

function parseOptionalMemoryStringField(
  obj: Record<string, unknown>,
  key: 'key' | 'valueExpr' | 'outputVar',
  pointer: string,
  ctx: ParseContext,
  assign: (value: string) => void,
): void {
  if (!(key in obj)) return
  const raw = obj[key]
  if (raw === undefined) return
  if (typeof raw === 'string') {
    assign(raw)
    return
  }
  ctx.errors.push({
    code: 'WRONG_FIELD_TYPE',
    message: `memory.${key} must be a string when present, received ${describeJsType(raw)}`,
    pointer: joinPointer(pointer, key),
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeJsType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** RFC 6901-style pointer join: encode '~' and '/' in segments. */
function joinPointer(base: string, segment: string): string {
  const encoded = segment.replace(/~/g, '~0').replace(/\//g, '~1')
  return `${base}/${encoded}`
}

/**
 * Best-effort line/column extraction from a V8 / Node JSON.parse error.
 * Returns undefined on any parsing miss — never throws.
 */
function extractJsonErrorPosition(message: string, source: string): { line: number; column: number } | undefined {
  // V8 / Node ≥20: "Unexpected token X in JSON at position N" or "...at position N (line L column C)"
  const lineColMatch = /line (\d+) column (\d+)/.exec(message)
  if (lineColMatch && lineColMatch[1] && lineColMatch[2]) {
    const line = Number(lineColMatch[1])
    const column = Number(lineColMatch[2])
    if (Number.isFinite(line) && Number.isFinite(column)) return { line, column }
  }
  const positionMatch = /position (\d+)/.exec(message)
  if (positionMatch && positionMatch[1]) {
    const offset = Number(positionMatch[1])
    if (Number.isFinite(offset)) return offsetToLineColumn(source, offset)
  }
  return undefined
}

function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1
  let column = 1
  const limit = Math.min(offset, source.length)
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++
      column = 1
    } else {
      column++
    }
  }
  return { line, column }
}
