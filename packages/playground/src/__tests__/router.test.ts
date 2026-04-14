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
})
