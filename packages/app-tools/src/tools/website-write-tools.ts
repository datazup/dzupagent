import type { DomainToolDefinition } from '../types.js'

// Write tier — mutate site state, no approval gate.
export const websiteWriteTools: readonly DomainToolDefinition[] = [
  {
    name: 'website.create_site',
    description:
      'Create a new site from a template. Allocates a site id, seeds default routes/sections from the template, and returns the created site record.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'templateId'],
      properties: {
        name: { type: 'string', minLength: 1 },
        templateId: { type: 'string', minLength: 1 },
        domain: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['site'],
      properties: {
        site: { type: 'object' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'creates_external_resource',
        description: 'Allocates a new site record (mutates state).',
      },
    ],
    namespace: 'website',
  },
  {
    name: 'website.generate_routes',
    description:
      'Generate the route tree from a natural-language site brief. Creates route records with paths, titles, and parent-child relationships. Idempotent per site brief hash.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['siteId', 'brief'],
      properties: {
        siteId: { type: 'string', minLength: 1 },
        brief: { type: 'string', minLength: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['routes'],
      properties: {
        routes: { type: 'array' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Inserts route records into the site (mutates state).',
      },
    ],
    namespace: 'website',
  },
  {
    name: 'website.generate_sections_per_route',
    description:
      'Generate sections for every route on the site, respecting the tone persona and design tokens. Existing sections are preserved unless `overwrite` is true.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['siteId'],
      properties: {
        siteId: { type: 'string', minLength: 1 },
        overwrite: { type: 'boolean' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['generated'],
      properties: {
        generated: { type: 'array' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Adds or replaces sections across all routes (mutates state).',
      },
    ],
    namespace: 'website',
  },
  {
    name: 'website.generate_seo_metadata',
    description:
      'Generate title, description, canonical URL, and OG tags for every route, derived from each route content and the site tone persona.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['siteId'],
      properties: {
        siteId: { type: 'string', minLength: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['updated'],
      properties: {
        updated: { type: 'array' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Writes SEO metadata onto every route (mutates state).',
      },
    ],
    namespace: 'website',
  },
  {
    name: 'website.update_section_content',
    description:
      "Update a section's subcomponent content (heading, body, CTAs, props). Pass only the fields to change; unspecified fields are preserved.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sectionId', 'patch'],
      properties: {
        sectionId: { type: 'string', minLength: 1 },
        patch: { type: 'object' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['section'],
      properties: {
        section: { type: 'object' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Mutates the section content tree.',
      },
    ],
    namespace: 'website',
  },
  {
    name: 'website.update_site_tone_persona',
    description:
      'Update the site tone persona — voice axes, reading level, brand keywords, forbidden phrases. Future copy generation honours the new persona.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['siteId', 'persona'],
      properties: {
        siteId: { type: 'string', minLength: 1 },
        persona: { type: 'object' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['persona'],
      properties: {
        persona: { type: 'object' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Updates the persona record on the site (mutates state).',
      },
    ],
    namespace: 'website',
  },
  {
    name: 'website.save_section_to_library',
    description:
      "Save a section as a reusable library block under a label and tag set. The block can later be inserted into any route via `website.insert_section_from_library`.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sectionId', 'label'],
      properties: {
        sectionId: { type: 'string', minLength: 1 },
        label: { type: 'string', minLength: 1 },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['libraryEntryId'],
      properties: {
        libraryEntryId: { type: 'string' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'creates_external_resource',
        description: 'Creates a new entry in the section library (mutates state).',
      },
    ],
    namespace: 'website',
  },
  {
    name: 'website.insert_section_from_library',
    description:
      "Insert a library section into a route at a given slot/index. The inserted section is a deep clone — edits don't affect the library entry.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['routeId', 'libraryEntryId'],
      properties: {
        routeId: { type: 'string', minLength: 1 },
        libraryEntryId: { type: 'string', minLength: 1 },
        slot: { type: 'string' },
        index: { type: 'integer', minimum: 0 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['section'],
      properties: {
        section: { type: 'object' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Adds a new section onto the route (mutates state).',
      },
    ],
    namespace: 'website',
  },
  {
    name: 'website.bind_content_source',
    description:
      'Bind a content source (RSS feed, REST API, research-app collection) to a route so dynamic sections can hydrate from it. Replaces any existing binding for the same slot.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['routeId', 'source'],
      properties: {
        routeId: { type: 'string', minLength: 1 },
        source: {
          type: 'object',
          required: ['type', 'ref'],
          properties: {
            type: { type: 'string', enum: ['rss', 'rest', 'research_app'] },
            ref: { type: 'string', minLength: 1 },
            slot: { type: 'string' },
          },
        },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['bindingId'],
      properties: {
        bindingId: { type: 'string' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Persists a content-source binding on the route (mutates state).',
      },
    ],
    namespace: 'website',
  },
]
