/**
 * Hard admission pass for state destinations produced by flow nodes.
 *
 * A collision exists when two distinct output declarations can write the same
 * state key on one execution path. Explicitly exclusive alternatives
 * (`branch.then` / `branch.else`, approval outcomes, and successful
 * `try_catch.body` / recovery `try_catch.catch` completion) are analysed from
 * the same incoming state and merged only after each alternative has been
 * checked, so their writes do not collide with each other. Parallel branches
 * are not exclusive and therefore share one collision domain.
 */
import type { FlowNode } from './types.js'

export const OUTPUT_KEY_UNIQUENESS_CODE = 'output_key_collision'
export const OUTPUT_KEY_UNIQUENESS_SEVERITY = 'error'

export interface OutputKeyDiagnostic {
  code: typeof OUTPUT_KEY_UNIQUENESS_CODE
  severity: typeof OUTPUT_KEY_UNIQUENESS_SEVERITY
  message: string
  /** Both colliding node ids, lexicographically sorted. */
  relatedIds: string[]
  /** Path of the later declaration that made the collision observable. */
  scopePath: string
  /** The colliding state key. */
  key: string
}

interface OutputDeclaration {
  key: string
  field: string
}

interface OutputProducer {
  id: string
  nodePath: string
  nodeType: FlowNode['type']
  field: string
}

type ProducerState = Map<string, OutputProducer[]>

interface WalkContext {
  diagnostics: OutputKeyDiagnostic[]
  diagnosticKeys: Set<string>
}

function producerId(node: FlowNode, nodePath: string): string {
  return node.id ?? nodePath
}

function outputDeclarations(node: FlowNode): OutputDeclaration[] {
  switch (node.type) {
    case 'agent':
      return [{ key: node.output.key, field: 'output.key' }]
    case 'prompt':
      return [{ key: node.outputKey ?? node.id ?? 'promptResult', field: 'outputKey' }]
    case 'clarification':
      return node.outputKey === undefined ? [] : [{ key: node.outputKey, field: 'outputKey' }]
    case 'classify':
    case 'worker.dispatch':
    case 'spdd.import_sources':
    case 'spdd.build_source_pack':
    case 'spdd.run_analysis':
    case 'spdd.generate_canvas':
    case 'spdd.validate_canvas':
    case 'spdd.review_canvas':
    case 'spdd.project_plan':
    case 'spdd.arm_dispatch':
    case 'spdd.run_validation':
    case 'spdd.collect_proof':
    case 'spdd.scan_drift':
    case 'spdd.create_sync_proposal':
    case 'spdd.agent_swarm':
      return [{ key: node.outputKey, field: 'outputKey' }]
    case 'fleet.dispatch':
    case 'fleet.gather':
    case 'fleet.contract-net':
      return node.output === undefined ? [] : [{ key: node.output, field: 'output' }]
    case 'knowledge.query':
    case 'shell.run':
    case 'evidence.write':
    case 'validate.schema':
    case 'adapter.run':
    case 'adapter.race':
    case 'adapter.parallel':
    case 'adapter.supervisor':
      return [{ key: node.output, field: 'output' }]
    case 'memory':
      return node.outputVar === undefined ? [] : [{ key: node.outputVar, field: 'outputVar' }]
    case 'http':
      return [{ key: node.outputVar ?? node.id ?? 'httpResponse', field: 'outputVar' }]
    case 'subflow':
      return [{ key: node.outputVar ?? node.id ?? 'subflowResult', field: 'outputVar' }]
    case 'for_each': {
      const declarations: OutputDeclaration[] = []
      if (node.collect !== undefined) {
        declarations.push({ key: node.collect.into, field: 'collect.into' })
      }
      if (node.accumulator !== undefined) {
        declarations.push({ key: node.accumulator.key, field: 'accumulator.key' })
      }
      return declarations
    }
    case 'try_catch':
      return [{ key: node.errorVar ?? 'error', field: 'errorVar' }]
    case 'sequence':
    case 'action':
    case 'branch':
    case 'approval':
    case 'persona':
    case 'route':
    case 'parallel':
    case 'complete':
    case 'spawn':
    case 'emit':
    case 'set':
    case 'checkpoint':
    case 'restore':
    case 'loop':
    case 'wait':
    case 'return_to':
    case 'validate':
    case 'knowledge.write':
      return []
    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

function cloneState(state: ProducerState): ProducerState {
  return new Map([...state].map(([key, producers]) => [key, [...producers]]))
}

function mergeExclusiveStates(states: readonly ProducerState[]): ProducerState {
  const merged: ProducerState = new Map()
  for (const state of states) {
    for (const [key, producers] of state) {
      const current = merged.get(key) ?? []
      for (const producer of producers) {
        if (!current.some((item) => producerToken(item) === producerToken(producer))) {
          current.push(producer)
        }
      }
      merged.set(key, current)
    }
  }
  return merged
}

function producerToken(producer: OutputProducer): string {
  return `${producer.nodePath}:${producer.field}`
}

function addOutputs(
  node: FlowNode,
  nodePath: string,
  state: ProducerState,
  context: WalkContext,
): ProducerState {
  for (const declaration of outputDeclarations(node)) {
    if (declaration.key.length === 0) continue
    const producer: OutputProducer = {
      id: producerId(node, nodePath),
      nodePath,
      nodeType: node.type,
      field: declaration.field,
    }
    const existing = state.get(declaration.key) ?? []
    for (const prior of existing) {
      const pair = [producerToken(prior), producerToken(producer)].sort()
      const diagnosticKey = `${declaration.key}:${pair[0]}:${pair[1]}`
      if (context.diagnosticKeys.has(diagnosticKey)) continue
      context.diagnosticKeys.add(diagnosticKey)
      const relatedIds = [prior.id, producer.id].sort()
      context.diagnostics.push({
        code: OUTPUT_KEY_UNIQUENESS_CODE,
        severity: OUTPUT_KEY_UNIQUENESS_SEVERITY,
        message:
          `Output key "${declaration.key}" can be written by ` +
          `${prior.nodeType} "${prior.id}" (${prior.field}) and ` +
          `${producer.nodeType} "${producer.id}" (${producer.field}) ` +
          'on the same execution path.',
        relatedIds,
        scopePath: nodePath,
        key: declaration.key,
      })
    }
    state.set(declaration.key, [...existing, producer])
  }
  return state
}

function walkSequence(
  nodes: readonly FlowNode[],
  parentPath: string,
  state: ProducerState,
  context: WalkContext,
): ProducerState {
  let current = state
  nodes.forEach((node, index) => {
    current = walkNode(node, `${parentPath}[${index}]`, current, context)
  })
  return current
}

function walkNode(
  node: FlowNode,
  nodePath: string,
  state: ProducerState,
  context: WalkContext,
): ProducerState {
  switch (node.type) {
    case 'sequence':
      return walkSequence(node.nodes, `${nodePath}.nodes`, state, context)
    case 'branch': {
      const thenState = walkSequence(node.then, `${nodePath}.then`, cloneState(state), context)
      const elseState = node.else === undefined
        ? cloneState(state)
        : walkSequence(node.else, `${nodePath}.else`, cloneState(state), context)
      return mergeExclusiveStates([thenState, elseState])
    }
    case 'approval': {
      const approved = walkSequence(
        node.onApprove,
        `${nodePath}.onApprove`,
        cloneState(state),
        context,
      )
      const rejected = node.onReject === undefined
        ? cloneState(state)
        : walkSequence(node.onReject, `${nodePath}.onReject`, cloneState(state), context)
      return mergeExclusiveStates([approved, rejected])
    }
    case 'parallel': {
      let parallelState = state
      node.branches.forEach((branch, branchIndex) => {
        parallelState = walkSequence(
          branch,
          `${nodePath}.branches[${branchIndex}]`,
          parallelState,
          context,
        )
      })
      return parallelState
    }
    case 'try_catch': {
      const bodyState = walkSequence(
        node.body,
        `${nodePath}.body`,
        cloneState(state),
        context,
      )
      const catchIncoming = addOutputs(
        node,
        nodePath,
        cloneState(state),
        context,
      )
      const catchState = walkSequence(
        node.catch,
        `${nodePath}.catch`,
        catchIncoming,
        context,
      )
      return mergeExclusiveStates([bodyState, catchState])
    }
    case 'persona':
    case 'route':
    case 'loop':
      return walkSequence(node.body, `${nodePath}.body`, state, context)
    case 'for_each': {
      // Each item runs against an iteration-local state copy. Validate output
      // ownership within that scope, but expose only declared aggregates to the
      // outer state after the loop completes.
      walkSequence(node.body, `${nodePath}.body`, new Map(), context)
      return addOutputs(node, nodePath, state, context)
    }
    default:
      return addOutputs(node, nodePath, state, context)
  }
}

/**
 * Return every same-path output destination collision in deterministic source
 * order. Any returned diagnostic is a hard authoring/compile admission error.
 */
export function checkOutputKeyUniqueness(root: FlowNode): OutputKeyDiagnostic[] {
  const context: WalkContext = {
    diagnostics: [],
    diagnosticKeys: new Set(),
  }
  walkNode(root, 'root', new Map(), context)
  return context.diagnostics
}
