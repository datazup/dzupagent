import { describe, it, expect } from 'vitest'
import { getFeatureOverlay, listFeatures, getFeatureSlugs } from '../features.js'

describe('features', () => {
  it('has 5 built-in features', () => {
    expect(listFeatures()).toHaveLength(5)
  })

  it('getFeatureSlugs returns all slugs', () => {
    const slugs = getFeatureSlugs()
    expect(slugs).toContain('auth')
    expect(slugs).toContain('dashboard')
    expect(slugs).toContain('billing')
    expect(slugs).toContain('teams')
    expect(slugs).toContain('ai')
  })

  it('each feature has required fields', () => {
    for (const feature of listFeatures()) {
      expect(feature.slug).toBeTruthy()
      expect(feature.name).toBeTruthy()
      expect(feature.description).toBeTruthy()
    }
  })

  it('getFeatureOverlay returns the correct feature', () => {
    const auth = getFeatureOverlay('auth')
    expect(auth).toBeDefined()
    expect(auth?.slug).toBe('auth')
    expect(auth?.files?.length).toBeGreaterThan(0)
  })

  it('getFeatureOverlay returns undefined for unknown features', () => {
    expect(getFeatureOverlay('nonexistent')).toBeUndefined()
  })

  it('auth feature has middleware file', () => {
    const auth = getFeatureOverlay('auth')
    const hasMiddleware = auth?.files?.some((f) => f.path.includes('middleware'))
    expect(hasMiddleware).toBe(true)
  })

  it('billing feature has stripe service', () => {
    const billing = getFeatureOverlay('billing')
    const hasStripe = billing?.files?.some((f) => f.path.includes('billing'))
    expect(hasStripe).toBe(true)
  })

  it('billing feature has env vars', () => {
    const billing = getFeatureOverlay('billing')
    expect(billing?.envVars).toBeDefined()
    const stripeKey = billing?.envVars?.find((v) => v.key === 'STRIPE_SECRET_KEY')
    expect(stripeKey).toBeDefined()
  })

  it('teams feature has team service', () => {
    const teams = getFeatureOverlay('teams')
    const hasTeams = teams?.files?.some((f) => f.path.includes('teams'))
    expect(hasTeams).toBe(true)
  })

  it('ai feature has ai service and memory dependencies', () => {
    const ai = getFeatureOverlay('ai')
    expect(ai?.dependencies?.['@dzupagent/memory']).toBeDefined()
    expect(ai?.dependencies?.['@dzupagent/context']).toBeDefined()
  })

  it('feature template content includes {{projectName}} placeholder', () => {
    for (const feature of listFeatures()) {
      if (feature.files && feature.files.length > 0) {
        const hasPlaceholder = feature.files.some((f) => f.templateContent.includes('{{projectName}}'))
        expect(hasPlaceholder).toBe(true)
      }
    }
  })
})
