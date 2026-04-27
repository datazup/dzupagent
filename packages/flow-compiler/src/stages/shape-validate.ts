import type { FlowNode, ValidationError } from '@dzupagent/flow-ast'

import { routeTarget } from '../route-target.js'

/**
 * Stage 2 — Structural validation.
 *
 * Runs purely over the AST. Aggregates every structural defect into a single
 * ValidationError[] (no early exit). Does NOT resolve refs (Stage 3) and does
 * NOT compile to a target (Stage 4).
 *
 * Includes the OI-4 cross-stage rule: rejects `on_error`-bearing constructs in
 * flows that would route to skill-chain. The feature-bitmask preview is reused
 * from `../route-target.ts` so STAGE 2 and STAGE 4 stay in lockstep.
 */
export function validateShape(ast: FlowNode): ValidationError[] {
  const errors: ValidationError[] = []
  visit(ast, 'root', errors)

  // OI-4: skill-chain-routed flows reject on_error anywhere.
  const { target } = routeTarget(ast)
  if (target === 'skill-chain') {
    walkOnError(ast, 'root', errors)
  }

  return errors
}

// ---------------------------------------------------------------------------
// Per-node structural rules (R1 EMPTY_BODY + R2 MISSING_REQUIRED_FIELD).
// R3 INVALID_CONDITION is intentionally deferred to STAGE 3.
// ---------------------------------------------------------------------------

function visit(node: FlowNode, path: string, errors: ValidationError[]): void {
  switch (node.type) {
    case 'sequence': {
      if (node.nodes.length === 0) {
        errors.push(emptyBody(node.type, path, 'sequence.nodes must contain at least one node'))
      }
      node.nodes.forEach((child, idx) => visit(child, `${path}.nodes[${idx}]`, errors))
      return
    }
    case 'action': {
      if (!isNonEmptyString(node.toolRef)) {
        errors.push(missing(node.type, path, 'action.toolRef is required (non-empty string)'))
      }
      if (!isPlainObject(node.input)) {
        errors.push(missing(node.type, path, 'action.input is required (object, may be empty)'))
      }
      return
    }
    case 'for_each': {
      if (!isNonEmptyString(node.source)) {
        errors.push(missing(node.type, path, 'for_each.source is required (non-empty string)'))
      }
      if (!isNonEmptyString(node.as)) {
        errors.push(missing(node.type, path, 'for_each.as is required (non-empty string)'))
      }
      if (node.body.length === 0) {
        errors.push(emptyBody(node.type, path, 'for_each.body must contain at least one node'))
      }
      node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`, errors))
      return
    }
    case 'branch': {
      if (!isNonEmptyString(node.condition)) {
        errors.push(missing(node.type, path, 'branch.condition is required (non-empty string)'))
      }
      if (node.then.length === 0) {
        errors.push(emptyBody(node.type, path, 'branch.then must contain at least one node'))
      }
      node.then.forEach((child, idx) => visit(child, `${path}.then[${idx}]`, errors))
      if (node.else !== undefined) {
        if (node.else.length === 0) {
          errors.push(emptyBody(node.type, path, 'branch.else, when present, must contain at least one node'))
        }
        node.else.forEach((child, idx) => visit(child, `${path}.else[${idx}]`, errors))
      }
      return
    }
    case 'parallel': {
      if (node.branches.length === 0) {
        errors.push(emptyBody(node.type, path, 'parallel.branches must contain at least one branch'))
      }
      node.branches.forEach((branch, bIdx) => {
        if (branch.length === 0) {
          errors.push(
            emptyBody(node.type, `${path}.branches[${bIdx}]`, 'parallel.branches[*] must contain at least one node'),
          )
        }
        branch.forEach((child, idx) => visit(child, `${path}.branches[${bIdx}][${idx}]`, errors))
      })
      return
    }
    case 'approval': {
      if (!isNonEmptyString(node.question)) {
        errors.push(missing(node.type, path, 'approval.question is required (non-empty string)'))
      }
      if (node.onApprove.length === 0) {
        errors.push(emptyBody(node.type, path, 'approval.onApprove must contain at least one node'))
      }
      node.onApprove.forEach((child, idx) => visit(child, `${path}.onApprove[${idx}]`, errors))
      if (node.onReject !== undefined) {
        if (node.onReject.length === 0) {
          errors.push(
            emptyBody(node.type, path, 'approval.onReject, when present, must contain at least one node'),
          )
        }
        node.onReject.forEach((child, idx) => visit(child, `${path}.onReject[${idx}]`, errors))
      }
      return
    }
    case 'clarification': {
      if (!isNonEmptyString(node.question)) {
        errors.push(missing(node.type, path, 'clarification.question is required (non-empty string)'))
      }
      if (node.expected === 'choice') {
        if (!Array.isArray(node.choices) || node.choices.length === 0) {
          errors.push(
            missing(node.type, path, "clarification.choices is required (non-empty array) when expected='choice'"),
          )
        }
      }
      return
    }
    case 'persona': {
      if (!isNonEmptyString(node.personaId)) {
        errors.push(missing(node.type, path, 'persona.personaId is required (non-empty string)'))
      }
      if (node.body.length === 0) {
        errors.push(emptyBody(node.type, path, 'persona.body must contain at least one node'))
      }
      node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`, errors))
      return
    }
    case 'route': {
      if (node.strategy === 'fixed-provider') {
        if (!isNonEmptyString(node.provider)) {
          errors.push(
            missing(node.type, path, "route.provider is required (non-empty string) when strategy='fixed-provider'"),
          )
        }
      } else if (node.strategy === 'capability') {
        if (!Array.isArray(node.tags) || node.tags.length === 0) {
          errors.push(
            missing(node.type, path, "route.tags is required (non-empty array) when strategy='capability'"),
          )
        }
      }
      if (node.body.length === 0) {
        errors.push(emptyBody(node.type, path, 'route.body must contain at least one node'))
      }
      node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`, errors))
      return
    }
    case 'complete': {
      // Leaf — no required fields beyond `type`.
      return
    }
    case 'spawn': {
      if (!isNonEmptyString(node.templateRef)) {
        errors.push(missing(node.type, path, 'spawn.templateRef is required (non-empty string)'))
      }
      return
    }
    case 'classify': {
      if (!isNonEmptyString(node.prompt)) {
        errors.push(missing(node.type, path, 'classify.prompt is required (non-empty string)'))
      }
      if (!Array.isArray(node.choices) || node.choices.length === 0) {
        errors.push(missing(node.type, path, 'classify.choices is required (non-empty array)'))
      }
      if (!isNonEmptyString(node.outputKey)) {
        errors.push(missing(node.type, path, 'classify.outputKey is required (non-empty string)'))
      }
      return
    }
    case 'emit': {
      if (!isNonEmptyString(node.event)) {
        errors.push(missing(node.type, path, 'emit.event is required (non-empty string)'))
      }
      return
    }
    case 'memory': {
      return
    }
    case 'checkpoint': {
      if (!isNonEmptyString(node.captureOutputOf)) {
        errors.push(missing(node.type, path, 'checkpoint.captureOutputOf is required (non-empty string)'))
      }
      return
    }
    case 'restore': {
      if (!isNonEmptyString(node.checkpointLabel)) {
        errors.push(missing(node.type, path, 'restore.checkpointLabel is required (non-empty string)'))
      }
      return
    }
    default: {
      // Exhaustiveness guard — adding a FlowNode variant without a case fails compilation here.
      const _exhaustive: never = node
      void _exhaustive
      return
    }
  }
}

// ---------------------------------------------------------------------------
// OI-4 walker — emits one MISSING_REQUIRED_FIELD per `on_error`-bearing node
// when the AST routes to skill-chain. Forward-compatible structural check:
// the FlowNode union does not yet declare `on_error` on any variant.
// ---------------------------------------------------------------------------

function walkOnError(node: FlowNode, path: string, errors: ValidationError[]): void {
  if ((node as unknown as Record<string, unknown>).on_error !== undefined) {
    errors.push({
      nodeType: node.type,
      nodePath: path,
      code: 'MISSING_REQUIRED_FIELD',
      message: 'on_error is only legal in pipeline-targeted flows',
    })
  }
  switch (node.type) {
    case 'sequence': {
      node.nodes.forEach((child, idx) => walkOnError(child, `${path}.nodes[${idx}]`, errors))
      return
    }
    case 'branch': {
      node.then.forEach((child, idx) => walkOnError(child, `${path}.then[${idx}]`, errors))
      if (node.else) {
        node.else.forEach((child, idx) => walkOnError(child, `${path}.else[${idx}]`, errors))
      }
      return
    }
    case 'parallel': {
      node.branches.forEach((branch, bIdx) => {
        branch.forEach((child, idx) => walkOnError(child, `${path}.branches[${bIdx}][${idx}]`, errors))
      })
      return
    }
    case 'for_each': {
      node.body.forEach((child, idx) => walkOnError(child, `${path}.body[${idx}]`, errors))
      return
    }
    case 'approval': {
      node.onApprove.forEach((child, idx) => walkOnError(child, `${path}.onApprove[${idx}]`, errors))
      if (node.onReject) {
        node.onReject.forEach((child, idx) => walkOnError(child, `${path}.onReject[${idx}]`, errors))
      }
      return
    }
    case 'persona':
    case 'route': {
      node.body.forEach((child, idx) => walkOnError(child, `${path}.body[${idx}]`, errors))
      return
    }
    case 'action':
    case 'clarification':
    case 'complete':
    case 'spawn':
    case 'classify':
    case 'emit':
    case 'memory':
    case 'checkpoint':
    case 'restore': {
      return
    }
    default: {
      const _exhaustive: never = node
      void _exhaustive
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyBody(nodeType: FlowNode['type'], nodePath: string, message: string): ValidationError {
  return { nodeType, nodePath, code: 'EMPTY_BODY', message }
}

function missing(nodeType: FlowNode['type'], nodePath: string, message: string): ValidationError {
  return { nodeType, nodePath, code: 'MISSING_REQUIRED_FIELD', message }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
