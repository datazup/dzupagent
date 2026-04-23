import { describe, expect, it } from 'vitest'
import type { WorkflowSchedule } from '../index.js'

describe('runtime-contracts schedule seam', () => {
  it('keeps workflow schedule records constructable', () => {
    const schedule: WorkflowSchedule = {
      id: 's-1',
      workflowTemplateId: 'wf-1',
      scheduleType: 'recurring',
      scheduleExpression: '0 * * * *',
      context: { projectId: 'p-1' },
      enabled: true,
      createdBy: 'user-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    expect(schedule.scheduleType).toBe('recurring')
    expect(schedule.enabled).toBe(true)
  })
})
