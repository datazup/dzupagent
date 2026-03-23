export type StandardEventType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'phase_change'
  | 'progress'
  | 'done'
  | 'error'

export interface StandardSSEEvent {
  type: StandardEventType | string
  data: Record<string, unknown>
}
