import type { ApprovalPayload, ClarificationPayload } from '@dzupagent/hitl-kit'
import type { DomainToolDefinition } from '../types.js'
import type { ExecutableDomainTool } from './shared.js'

/**
 * human.* — human-in-the-loop interaction tools.
 *
 * `human.clarify` and `human.approve` produce HITL payloads conforming to
 * `@dzupagent/hitl-kit` and hand them off to injected callbacks. The callbacks
 * are responsible for actually delivering the payload (SSE, WebSocket, email,
 * etc.) — this layer is pure plumbing.
 */

export type ClarifyCallback = (payload: ClarificationPayload) => void | Promise<void>
export type ApproveCallback = (payload: ApprovalPayload) => void | Promise<void>

// ---------------------------------------------------------------------------
// human.clarify
// ---------------------------------------------------------------------------

interface ClarifyInput {
  question: string
  context?: string
  choices?: string[]
}

interface ClarifyOutput {
  sent: true
}

function buildHumanClarify(
  onClarify: ClarifyCallback,
): ExecutableDomainTool<ClarifyInput, ClarifyOutput> {
  const definition: DomainToolDefinition = {
    name: 'human.clarify',
    description: 'Request clarification from a human operator.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1 },
        context: { type: 'string' },
        choices: { type: 'array', items: { type: 'string' } },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['sent'],
      properties: {
        sent: { type: 'boolean', const: true },
      },
    },
    permissionLevel: 'read',
    sideEffects: [
      {
        type: 'sends_notification',
        description: 'Sends a clarification request to a human operator.',
      },
    ],
    namespace: 'human',
  }

  return {
    definition,
    async execute(input: ClarifyInput): Promise<ClarifyOutput> {
      const hasChoices = input.choices !== undefined && input.choices.length > 0
      const payload: ClarificationPayload = {
        type: 'clarification',
        runId: '',
        nodeIndex: 0,
        question: input.question,
        expected: hasChoices ? 'choice' : 'text',
        ...(hasChoices ? { choices: input.choices as string[] } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
      }
      await onClarify(payload)
      return { sent: true }
    },
  }
}

// ---------------------------------------------------------------------------
// human.approve
// ---------------------------------------------------------------------------

interface ApproveInput {
  question: string
  options?: string[]
  sideEffects?: string[]
  context?: string
}

interface ApproveOutput {
  sent: true
}

function buildHumanApprove(
  onApprove: ApproveCallback,
): ExecutableDomainTool<ApproveInput, ApproveOutput> {
  const definition: DomainToolDefinition = {
    name: 'human.approve',
    description: 'Request approval from a human operator for a side-effectful action.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1 },
        options: { type: 'array', items: { type: 'string' } },
        sideEffects: { type: 'array', items: { type: 'string' } },
        context: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['sent'],
      properties: {
        sent: { type: 'boolean', const: true },
      },
    },
    permissionLevel: 'read',
    sideEffects: [
      {
        type: 'sends_notification',
        description: 'Sends an approval request to a human operator.',
      },
    ],
    requiresApproval: true,
    namespace: 'human',
  }

  return {
    definition,
    async execute(input: ApproveInput): Promise<ApproveOutput> {
      const payload: ApprovalPayload = {
        type: 'approval',
        runId: '',
        nodeIndex: 0,
        question: input.question,
        options: input.options ?? ['approve', 'reject'],
        sideEffects: input.sideEffects ?? [],
        ...(input.context !== undefined ? { context: input.context } : {}),
      }
      await onApprove(payload)
      return { sent: true }
    },
  }
}

export function buildHumanTools(
  onClarify: ClarifyCallback,
  onApprove: ApproveCallback,
): ExecutableDomainTool[] {
  return [
    buildHumanClarify(onClarify) as unknown as ExecutableDomainTool,
    buildHumanApprove(onApprove) as unknown as ExecutableDomainTool,
  ]
}
