import type { DomainToolDefinition } from '../types.js'
import { InMemoryDomainToolRegistry } from '../registry.js'

/**
 * website.* — contract scaffold for the website-builder agent.
 *
 * These are pure {@link DomainToolDefinition} entries (metadata-only). The
 * runtime implementations live in `apps/website-app` (which is not yet
 * scaffolded). Consumers can import the definitions to wire LLM tool catalogs,
 * permission checks, and HITL gating before any executor exists.
 *
 * Three permission tiers are encoded:
 *
 * - **Read** (`permissionLevel: 'read'`, no side effects) — site/route/section
 *   inspection, design-token introspection, library browsing, SEO validation.
 * - **Write** (`permissionLevel: 'write'`, mutating side effects) — site
 *   creation, route generation, section editing, content-source binding.
 * - **Approval-gated write** (`permissionLevel: 'write'`, mutating side effects,
 *   `requiresApproval: true`) — publish, deployment-plan generation, structured
 *   clarification flows that must be reviewed before proceeding.
 */

export interface WebsiteToolRegistryBundle {
  /** Pre-populated registry keyed by tool name. */
  registry: InMemoryDomainToolRegistry
  /** Flat list of all `website.*` tool definitions. */
  tools: readonly DomainToolDefinition[]
}

// ---------------------------------------------------------------------------
// Read tier — inspection only, no side effects.
// ---------------------------------------------------------------------------

const readTools: DomainToolDefinition[] = [
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

// ---------------------------------------------------------------------------
// Write tier — mutate site state, no approval gate.
// ---------------------------------------------------------------------------

const writeTools: DomainToolDefinition[] = [
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

// ---------------------------------------------------------------------------
// Approval-gated tier — write + requires HITL approval.
// ---------------------------------------------------------------------------

const approvalTools: DomainToolDefinition[] = [
  {
    name: 'website.publish_site',
    description:
      "Publish the site to its primary domain (sets status: 'published' and triggers downstream deployment). Requires explicit human approval before execution.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['siteId'],
      properties: {
        siteId: { type: 'string', minLength: 1 },
        environment: { type: 'string', enum: ['preview', 'production'] },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['publishedAt'],
      properties: {
        publishedAt: { type: 'string' },
        deploymentId: { type: 'string' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'modifies_external_resource',
        description: 'Flips site status to published and starts a deployment.',
      },
      {
        type: 'sends_notification',
        description: 'Notifies subscribers (webhook, email) about the publish event.',
      },
    ],
    requiresApproval: true,
    namespace: 'website',
  },
  {
    name: 'website.generate_coolify_plan',
    description:
      'Generate a Coolify deployment plan (services, env vars, domains, build args) for review. Does not deploy — emits the plan document for human approval.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['siteId'],
      properties: {
        siteId: { type: 'string', minLength: 1 },
        environment: { type: 'string', enum: ['preview', 'production'] },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['plan'],
      properties: {
        plan: { type: 'object' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [],
    requiresApproval: true,
    namespace: 'website',
  },
  {
    name: 'website.clarify_requirements',
    description:
      'Ask the user a structured set of clarifying questions before proceeding with site generation. Pauses the agent until the user responds.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'prompt'],
            properties: {
              id: { type: 'string' },
              prompt: { type: 'string' },
              choices: { type: 'array', items: { type: 'string' } },
            },
          },
          minItems: 1,
        },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['answers'],
      properties: {
        answers: { type: 'array' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'sends_notification',
        description: 'Surfaces a clarification prompt to the human user.',
      },
    ],
    requiresApproval: true,
    namespace: 'website',
  },
]

/**
 * Flat list of every `website.*` tool definition. Order is stable: read tier,
 * then write tier, then approval-gated tier.
 */
export const websiteTools: readonly DomainToolDefinition[] = [
  ...readTools,
  ...writeTools,
  ...approvalTools,
]

/**
 * Pre-populated registry plus the source list, ready to merge into a larger
 * `BuiltinToolRegistryBundle` or used standalone for tool-catalog wiring.
 */
export const websiteToolBundle: WebsiteToolRegistryBundle = (() => {
  const registry = new InMemoryDomainToolRegistry()
  for (const tool of websiteTools) {
    registry.register(tool)
  }
  return { registry, tools: websiteTools }
})()
