import { describe, it, expect } from 'vitest'
import type {
  ExecutionRunStatus,
  ExecutionRun,
  PersonaRoleType,
  FeatureBrief,
  WorkItem,
  PersonaProfile,
} from '../index.js'

describe('runtime-contracts type exports', () => {
  it('ExecutionRun shape is constructable', () => {
    const run: ExecutionRun = {
      id: 'r-1',
      taskId: 't-1',
      workflowRunId: 'w-1',
      providerId: 'openai',
      status: 'queued' satisfies ExecutionRunStatus,
      input: 'test prompt',
      startedAt: Date.now(),
    }
    expect(run.id).toBe('r-1')
    expect(run.status).toBe('queued')
  })

  it('FeatureBrief shape is constructable', () => {
    const brief: FeatureBrief = {
      id: 'f-1',
      title: 'Auth feature',
      problem: 'Users cannot log in',
      constraints: ['must use OAuth'],
      acceptanceCriteria: ['login works'],
      priority: 'high',
      createdBy: 'user-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(brief.priority).toBe('high')
  })

  it('WorkItem shape is constructable', () => {
    const item: WorkItem = {
      id: 'wi-1',
      featureId: 'f-1',
      title: 'Implement login endpoint',
      description: 'POST /auth/login',
      dependsOn: [],
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(item.status).toBe('pending')
  })

  it('PersonaProfile shape is constructable', () => {
    const persona: PersonaProfile = {
      id: 'p-1',
      name: 'Backend Dev',
      roleType: 'backend_dev' satisfies PersonaRoleType,
      description: 'Implements API endpoints',
      capabilities: ['express', 'prisma'],
      preferredTags: ['api', 'database'],
      guardrails: ['no raw SQL'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(persona.roleType).toBe('backend_dev')
  })
})
