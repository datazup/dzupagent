import type { DomainToolDefinition } from '../types.js'

// Approval-gated tier — write + requires HITL approval.
export const websiteApprovalTools: readonly DomainToolDefinition[] = [
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
