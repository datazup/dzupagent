import type { FeatureDefinition } from './types.js'

/**
 * Built-in feature overlays that can be applied on top of any template.
 */
const featureRegistry: Record<string, FeatureDefinition> = {
  auth: {
    slug: 'auth',
    name: 'Authentication',
    description: 'API key or JWT authentication middleware',
    dependencies: {
      '@dzupagent/server': '^0.1.0',
    },
    files: [
      {
        path: 'src/middleware/auth.ts',
        templateContent: `// {{projectName}} — authentication middleware
import type { Context, Next } from 'hono'

/**
 * API key authentication middleware.
 * Validates the Authorization header against the configured API key.
 */
export function authMiddleware(apiKey: string) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const header = c.req.header('Authorization')
    if (!header || header !== \`Bearer \${apiKey}\`) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  }
}
`,
      },
    ],
    envVars: [
      { key: 'DZIP_API_KEY', defaultValue: 'your-forge-api-key', description: 'API authentication key' },
    ],
  },

  dashboard: {
    slug: 'dashboard',
    name: 'Dashboard',
    description: 'Admin dashboard UI with agent monitoring',
    dependencies: {
      '@dzupagent/server': '^0.1.0',
    },
    files: [
      {
        path: 'src/routes/dashboard.ts',
        templateContent: `// {{projectName}} — dashboard routes
import type { Context } from 'hono'

/**
 * Dashboard route handlers for agent monitoring.
 */
export function dashboardRoutes() {
  return {
    getStatus: (c: Context) => c.json({ status: 'ok', project: '{{projectName}}' }),
    getMetrics: (c: Context) => c.json({ metrics: { requests: 0, errors: 0, latencyMs: 0 } }),
  }
}
`,
      },
    ],
    envVars: [
      { key: 'CORS_ORIGINS', defaultValue: 'http://localhost:3000', description: 'Allowed CORS origins' },
    ],
  },

  billing: {
    slug: 'billing',
    name: 'Billing',
    description: 'Stripe-based billing and subscription management',
    dependencies: {
      stripe: '^17.0.0',
    },
    files: [
      {
        path: 'src/services/billing.ts',
        templateContent: `// {{projectName}} — billing service
import Stripe from 'stripe'

const stripe = new Stripe(process.env['STRIPE_SECRET_KEY'] ?? '', {
  apiVersion: '2024-12-18.acacia',
})

export interface CreateCheckoutParams {
  priceId: string
  customerId: string
  successUrl: string
  cancelUrl: string
}

/**
 * Create a Stripe checkout session.
 */
export async function createCheckoutSession(params: CreateCheckoutParams): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: params.customerId,
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  })
  return session.url ?? ''
}
`,
      },
      {
        path: 'src/routes/billing.ts',
        templateContent: `// {{projectName}} — billing routes
import type { Context } from 'hono'

export function billingRoutes() {
  return {
    getPlans: (c: Context) =>
      c.json({ plans: [{ id: 'free', name: 'Free' }, { id: 'pro', name: 'Pro' }] }),
  }
}
`,
      },
    ],
    envVars: [
      { key: 'STRIPE_SECRET_KEY', defaultValue: 'sk_test_...', description: 'Stripe secret key' },
      { key: 'STRIPE_WEBHOOK_SECRET', defaultValue: 'whsec_...', description: 'Stripe webhook secret' },
      { key: 'STRIPE_PRICE_ID', defaultValue: 'price_...', description: 'Default Stripe price ID' },
    ],
  },

  teams: {
    slug: 'teams',
    name: 'Teams',
    description: 'Multi-tenant team management with RBAC',
    dependencies: {},
    files: [
      {
        path: 'src/services/teams.ts',
        templateContent: `// {{projectName}} — team management service

export interface Team {
  id: string
  name: string
  ownerId: string
  createdAt: Date
}

export interface TeamMember {
  userId: string
  teamId: string
  role: 'owner' | 'admin' | 'member'
}

/**
 * Team management service stub.
 * Replace with actual database implementation.
 */
export class TeamService {
  async createTeam(name: string, ownerId: string): Promise<Team> {
    return {
      id: crypto.randomUUID(),
      name,
      ownerId,
      createdAt: new Date(),
    }
  }

  async addMember(teamId: string, userId: string, role: TeamMember['role']): Promise<TeamMember> {
    return { userId, teamId, role }
  }
}
`,
      },
    ],
    envVars: [
      { key: 'MAX_TEAM_SIZE', defaultValue: '50', description: 'Maximum team members' },
    ],
  },

  ai: {
    slug: 'ai',
    name: 'AI / LLM',
    description: 'AI features with memory, embeddings, and vector search',
    dependencies: {
      '@dzupagent/memory': '^0.1.0',
      '@dzupagent/context': '^0.1.0',
    },
    files: [
      {
        path: 'src/services/ai.ts',
        templateContent: `// {{projectName}} — AI service

/**
 * AI service with memory and context management.
 * Provides chat completion with conversation history.
 */
export class AIService {
  private readonly model: string

  constructor(model = 'claude-3-5-haiku-20241022') {
    this.model = model
  }

  async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
    // Stub — replace with actual LLM call
    const lastMessage = messages[messages.length - 1]
    return \`Echo from \${this.model}: \${lastMessage?.content ?? ''}\`
  }
}
`,
      },
    ],
    envVars: [
      { key: 'OPENAI_API_KEY', defaultValue: 'your-openai-key', description: 'OpenAI API key for embeddings' },
      { key: 'EMBEDDING_PROVIDER', defaultValue: 'openai', description: 'Embedding provider' },
    ],
  },
}

/**
 * Get the feature overlay definition, or undefined if the feature is not built-in.
 */
export function getFeatureOverlay(slug: string): FeatureDefinition | undefined {
  return featureRegistry[slug]
}

/**
 * List all available built-in features.
 */
export function listFeatures(): FeatureDefinition[] {
  return Object.values(featureRegistry)
}

/**
 * Get available feature slugs.
 */
export function getFeatureSlugs(): string[] {
  return Object.keys(featureRegistry)
}
