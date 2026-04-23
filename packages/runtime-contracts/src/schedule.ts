export type ScheduleType = 'immediate' | 'delayed' | 'recurring' | 'event_triggered'

export interface WorkflowSchedule {
  id: string
  workflowTemplateId: string
  scheduleType: ScheduleType
  scheduleExpression?: string
  triggerEvent?: string
  context: Record<string, unknown>
  enabled: boolean
  lastRunAt?: number
  nextRunAt?: number
  createdBy: string
  createdAt: number
  updatedAt: number
}
