import { describe, expect, it } from 'vitest'

import {
  getDynamicWorkflowRoleRoutes,
  resolveDynamicWorkflowProvider,
} from '../orchestration/dynamic-workflow-router.js'
import { resolveDynamicWorkflowProvider as resolveFromOrchestrationBarrel } from '../orchestration.js'
import { resolveDynamicWorkflowProvider as resolveFromRootBarrel } from '../index.js'

describe('dynamic workflow provider router', () => {
  it('routes workflow design to Claude with the required reason', () => {
    const decision = resolveDynamicWorkflowProvider('workflow-designer')

    expect(decision).toEqual({
      role: 'workflow-designer',
      provider: 'claude',
      fallbackProviders: ['codex'],
      reason: 'claude is preferred for workflow design and synthesis',
    })
  })

  it('routes repo implementation to Codex with the required reason', () => {
    const decision = resolveDynamicWorkflowProvider('implementation-worker')

    expect(decision).toEqual({
      role: 'implementation-worker',
      provider: 'codex',
      fallbackProviders: ['claude'],
      reason: 'codex is preferred for repo-local implementation',
    })
  })

  it('routes supporting workflow roles deterministically', () => {
    expect(resolveDynamicWorkflowProvider('quality-reviewer')).toMatchObject({
      provider: 'codex',
      fallbackProviders: ['claude'],
    })
    expect(resolveDynamicWorkflowProvider('spec-reviewer')).toMatchObject({
      provider: 'claude',
      fallbackProviders: ['codex'],
    })
    expect(resolveDynamicWorkflowProvider('summarizer')).toMatchObject({
      provider: 'claude',
      fallbackProviders: ['codex'],
    })
    expect(resolveDynamicWorkflowProvider('coordinator')).toMatchObject({
      provider: 'claude',
      fallbackProviders: ['codex'],
    })
  })

  it('returns immutable route snapshots', () => {
    const routes = getDynamicWorkflowRoleRoutes()
    const firstDesignerRoute = routes['workflow-designer']

    expect(Object.isFrozen(routes)).toBe(true)
    expect(Object.isFrozen(firstDesignerRoute)).toBe(true)
    expect(Object.isFrozen(firstDesignerRoute.fallbackProviders)).toBe(true)
    const mutableFallbacks = firstDesignerRoute.fallbackProviders as string[]
    expect(() => {
      mutableFallbacks.push('claude')
    }).toThrow(TypeError)
  })

  it('fails clearly for unknown roles', () => {
    expect(() => resolveDynamicWorkflowProvider('planner' as never)).toThrow(
      'Unknown dynamic workflow role: planner',
    )
  })

  it('exports the router from public barrels', () => {
    expect(resolveFromOrchestrationBarrel('workflow-designer').provider).toBe('claude')
    expect(resolveFromRootBarrel('implementation-worker').provider).toBe('codex')
  })
})
