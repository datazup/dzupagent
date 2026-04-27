import { describe, expect, it } from 'vitest'

import {
  buildWebsiteBuilderSystemPrompt,
  WEBSITE_BUILDER_APPROVAL_TOOLS,
  WEBSITE_BUILDER_READ_TOOLS,
  WEBSITE_BUILDER_TOOL_NAMES,
  WEBSITE_BUILDER_WRITE_TOOLS,
} from './website-builder.js'

describe('buildWebsiteBuilderSystemPrompt', () => {
  it('identifies the agent as the Website Builder Agent', () => {
    const prompt = buildWebsiteBuilderSystemPrompt()

    expect(prompt).toContain('Website Builder Agent')
  })

  it('includes the website.clarify_requirements guardrail', () => {
    const prompt = buildWebsiteBuilderSystemPrompt()

    expect(prompt).toContain('website.clarify_requirements')
    expect(prompt.toLowerCase()).toContain('approval')
  })

  it('appends siteSystemPrompt verbatim when provided', () => {
    const tone =
      'Write in a confident, plain-English voice. Avoid jargon. Reading level: grade 8.'
    const prompt = buildWebsiteBuilderSystemPrompt({ siteSystemPrompt: tone })

    expect(prompt).toContain(tone)
  })

  it('includes site name and status when provided', () => {
    const prompt = buildWebsiteBuilderSystemPrompt({
      siteName: 'Acme Marketing',
      siteStatus: 'DRAFT',
    })

    expect(prompt).toContain('Acme Marketing')
    expect(prompt).toContain('DRAFT')
  })
})

describe('Website Builder tool name catalogues', () => {
  it('exposes every website.* tool name (21 total)', () => {
    expect(WEBSITE_BUILDER_TOOL_NAMES).toHaveLength(21)
    expect(
      WEBSITE_BUILDER_TOOL_NAMES.every((name) => name.startsWith('website.')),
    ).toBe(true)

    // Read + write + approval should partition the full catalogue.
    expect(
      WEBSITE_BUILDER_READ_TOOLS.length +
        WEBSITE_BUILDER_WRITE_TOOLS.length,
    ).toBe(WEBSITE_BUILDER_TOOL_NAMES.length)
  })

  it('marks website.publish_site as approval-gated', () => {
    expect(WEBSITE_BUILDER_APPROVAL_TOOLS).toContain('website.publish_site')
  })
})
