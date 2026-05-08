import type { DomainToolDefinition } from '../types.js'

// Read tier — inspection only, no side effects.
export const websiteReadTools: readonly DomainToolDefinition[] = [
  {
    name: 'website.get_site_info',
    description:
      "Get current site metadata (name, primary domain, publish status, last-updated timestamp). Use before any write to confirm the site's current state.",
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
      required: ['site'],
      properties: {
        site: {
          type: 'object',
          required: ['id', 'name', 'status'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            domain: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'published', 'archived'] },
            updatedAt: { type: 'string' },
          },
        },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'website',
  },
  {
    name: 'website.list_routes',
    description:
      "List all routes/pages registered on the site, returned as a flat array with route paths and titles. Use this to enumerate the site's information architecture.",
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
      required: ['routes'],
      properties: {
        routes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'path'],
            properties: {
              id: { type: 'string' },
              path: { type: 'string' },
              title: { type: 'string' },
            },
          },
        },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'website',
  },
  {
    name: 'website.get_route',
    description:
      'Get a specific route together with its ordered sections, layout slot assignments, and SEO metadata. Returns null when the route id is unknown.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['routeId'],
      properties: {
        routeId: { type: 'string', minLength: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['route'],
      properties: {
        route: {},
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'website',
  },
  {
    name: 'website.list_sections',
    description:
      'List sections placed on a route in render order. Each entry exposes the section type, slot, and an optional human label for orientation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['routeId'],
      properties: {
        routeId: { type: 'string', minLength: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['sections'],
      properties: {
        sections: { type: 'array' },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'website',
  },
  {
    name: 'website.get_section',
    description:
      "Get a section's full subcomponent content tree (heading, body, CTAs, media references, props). Use before editing so the agent can produce a precise diff.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sectionId'],
      properties: {
        sectionId: { type: 'string', minLength: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['section'],
      properties: {
        section: {},
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'website',
  },
  {
    name: 'website.get_site_tone_persona',
    description:
      "Get the site's current tone persona — voice attributes (formal/casual), reading level, brand keywords, and forbidden phrases. Drives all generated copy.",
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
      required: ['persona'],
      properties: {
        persona: {},
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'website',
  },
  {
    name: 'website.get_design_tokens',
    description:
      "Get the site's design-token overrides (colors, typography, spacing, radius) layered on top of the base theme. Use to keep generated sections visually consistent.",
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
      required: ['tokens'],
      properties: {
        tokens: { type: 'object' },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'website',
  },
  {
    name: 'website.list_section_library',
    description:
      'List saved reusable sections in the site library. Each entry includes a label, preview thumbnail reference, and the section schema id used to instantiate it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        siteId: { type: 'string', minLength: 1 },
        tag: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['entries'],
      properties: {
        entries: { type: 'array' },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'website',
  },
  {
    name: 'website.validate_seo',
    description:
      'Validate SEO metadata for a route — title length, description length, canonical URL presence, OG tags, and structured-data hints. Read-only diagnostic; reports issues without writing.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['routeId'],
      properties: {
        routeId: { type: 'string', minLength: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['issues'],
      properties: {
        issues: { type: 'array' },
        score: { type: 'number' },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'website',
  },
]
