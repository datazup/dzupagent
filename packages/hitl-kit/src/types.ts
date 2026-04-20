export interface ClarificationPayload {
  type: 'clarification'
  runId: string
  nodeIndex: number
  question: string
  expected: 'text' | 'choice'
  choices?: string[]
  context?: string
  expiresAt?: string             // ISO 8601
}

export interface ApprovalPayload {
  type: 'approval'
  runId: string
  nodeIndex: number
  question: string
  options: string[]
  sideEffects: string[]
  context?: string
  expiresAt?: string             // ISO 8601
}

export type HITLPayload = ClarificationPayload | ApprovalPayload

export interface ClarificationResponse {
  runId: string
  type: 'clarification'
  value: string                  // text answer or selected choice
  respondedAt: string            // ISO 8601
}

export interface ApprovalResponse {
  runId: string
  type: 'approval'
  decision: 'approved' | 'rejected'
  selectedOption?: string
  reason?: string
  respondedAt: string            // ISO 8601
}

export type HITLResponse = ClarificationResponse | ApprovalResponse

// Adapter formatting interface — adapters implement this to render HITL payloads
export interface HITLFormatter<TAdapterMessage = unknown> {
  formatClarification(payload: ClarificationPayload): TAdapterMessage
  formatApproval(payload: ApprovalPayload): TAdapterMessage
}
