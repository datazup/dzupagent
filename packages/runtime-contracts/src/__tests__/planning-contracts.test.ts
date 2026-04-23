import { describe, expect, it } from 'vitest'
import type {
  FeatureBrief,
  PersonaProfile,
  PersonaRoleType,
  WorkItem,
} from '../index.js'

describe('runtime-contracts planning seam', () => {
  it('keeps feature and work-item planning shapes constructable', () => {
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

    expect(brief.priority).toBe('high')
    expect(item.status).toBe('pending')
  })

  it('keeps persona profiles aligned with planning role types', () => {
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
    expect(persona.capabilities).toContain('express')
  })
})
