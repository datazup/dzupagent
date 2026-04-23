import { describe, expect, it } from 'vitest'
import { router } from '../router/index.js'

describe('playground router', () => {
  it('registers the benchmark and eval routes', () => {
    const routes = router.getRoutes()
    const paths = routes.map((route) => route.path)
    const names = routes.map((route) => route.name)

    expect(paths).toContain('/benchmarks')
    expect(paths).toContain('/benchmarks/:runId')
    expect(paths).toContain('/evals')
    expect(paths).toContain('/evals/:id')
    expect(names).toContain('benchmarks')
    expect(names).toContain('benchmark-detail')
    expect(names).toContain('evals')
    expect(names).toContain('eval-detail')
  })

  it('registers the canonical agent-definitions, runs, and eval-dashboard routes', () => {
    const routes = router.getRoutes()
    const paths = routes.map((route) => route.path)
    const names = routes.map((route) => route.name)

    expect(paths).toContain('/agent-definitions')
    expect(names).toContain('agent-definitions')
    expect(paths).toContain('/runs')
    expect(names).toContain('runs')
    expect(paths).toContain('/runs/:id')
    expect(names).toContain('run-detail')
    expect(paths).toContain('/eval-dashboard')
    expect(names).toContain('eval-dashboard')
  })

  it('keeps the legacy /agents route only as a compatibility redirect', () => {
    const legacyRoute = router.getRoutes().find((route) => route.path === '/agents')

    expect(legacyRoute?.name).toBe('agents')
    expect(legacyRoute?.redirect).toBe('/agent-definitions')
  })
})
