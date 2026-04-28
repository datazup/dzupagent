/**
 * Role-Based Access Control (RBAC) middleware for DzupAgent server.
 *
 * Provides role-permission mapping and middleware guards that check
 * whether the current request's role has permission to access a resource.
 */
import type { MiddlewareHandler } from 'hono'

export type ForgeRole = 'admin' | 'operator' | 'viewer' | 'agent'

export type ForgePermissionResource =
  | 'agents'
  | 'runs'
  | 'tools'
  | 'approvals'
  | 'settings'
  | 'events'
  | 'memory'
  | 'registry'
  | 'apiKeys'
  | 'triggers'
  | 'schedules'
  | 'deploy'
  | 'evals'
  | 'benchmarks'
  | 'learning'
  | 'prompts'
  | 'personas'
  | 'presets'
  | 'marketplace'
  | 'reflections'
  | 'mailbox'
  | 'clusters'
  | 'mcp'
  | 'skills'
  | 'workflows'
  | (string & {})
  | '*'

export type ForgePermissionAction =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'execute'
  | '*'

export interface ForgePermission {
  resource: ForgePermissionResource
  action: ForgePermissionAction
}

export type RoutePermissionPolicy =
  | {
      /** Resource checked through the role permission map. */
      resource: ForgePermissionResource
      /** Override the HTTP-method-derived action for this route prefix. */
      action?: ForgePermissionAction
    }
  | {
      /** Require `role === 'admin'` regardless of the permission map. */
      adminOnly: true
    }

export interface ResolvedRoutePermission {
  prefix: string
  policy: RoutePermissionPolicy
}

export interface RBACConfig {
  /** Function to extract role from request context */
  extractRole: (c: {
    req: { header: (name: string) => string | undefined }
    get: (key: string) => unknown
  }) => ForgeRole | undefined
  /** Custom role-permission mapping (merged with defaults) */
  customPermissions?: Partial<Record<ForgeRole, ForgePermission[]>>
  /**
   * MC-S02: Path prefixes that require `role === 'admin'` regardless of
   * the permission map. Evaluated BEFORE the generic resource/action
   * check. Any non-admin role hitting a listed prefix receives 403.
   *
   * Defaults to {@link DEFAULT_ADMIN_ONLY_PATHS}.
   */
  adminOnlyPaths?: string[]
  /**
   * Additional or overriding route-prefix policies.
   *
   * Hosts mounting route plugins under `/api/*` should add an entry here
   * and, when using resource policies, grant matching customPermissions.
   */
  routePermissions?: Record<string, RoutePermissionPolicy>
}

/**
 * MC-S02: Default path prefixes that require admin role.
 *
 * MCP registration can spawn processes and wire external tools; cluster
 * management alters multi-role agent topology. Both are gated to
 * `role === 'admin'` by the default rbacMiddleware configuration.
 */
export const DEFAULT_ADMIN_ONLY_PATHS: string[] = [
  '/api/keys',
  '/api/registry',
  '/api/triggers',
  '/api/schedules',
  '/api/deploy',
  '/api/evals',
  '/api/benchmarks',
  '/api/prompts',
  '/api/personas',
  '/api/marketplace',
  '/api/mailbox',
  '/api/mcp',
  '/api/clusters',
]

export const DEFAULT_ROUTE_PERMISSIONS: Record<string, RoutePermissionPolicy> = {
  '/api/agent-definitions': { resource: 'agents' },
  '/api/agents': { resource: 'agents' },
  '/api/runs': { resource: 'runs' },
  '/api/approvals': { resource: 'approvals' },
  '/api/events': { resource: 'events', action: 'read' },
  '/api/tools': { resource: 'tools' },
  '/api/memory': { resource: 'memory' },
  '/api/memory-browse': { resource: 'memory', action: 'read' },
  '/api/learning': { resource: 'learning' },
  '/api/reflections': { resource: 'reflections' },
  '/api/presets': { resource: 'presets' },
  '/api/skills': { resource: 'skills' },
  '/api/workflows': { resource: 'workflows' },
}

/**
 * Default role permissions.
 *
 * - admin: full access to everything
 * - operator: manage runs and approvals, read agents and tools
 * - viewer: read-only access to runs, agents, and tools
 * - agent: programmatic access for agent-to-agent calls
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<ForgeRole, ForgePermission[]> = {
  admin: [{ resource: '*', action: '*' }],
  operator: [
    { resource: 'runs', action: 'create' },
    { resource: 'runs', action: 'read' },
    { resource: 'runs', action: 'execute' },
    { resource: 'agents', action: 'read' },
    { resource: 'approvals', action: 'create' },
    { resource: 'approvals', action: 'read' },
    { resource: 'tools', action: 'read' },
    { resource: 'tools', action: 'execute' },
  ],
  viewer: [
    { resource: 'runs', action: 'read' },
    { resource: 'agents', action: 'read' },
    { resource: 'tools', action: 'read' },
  ],
  agent: [
    { resource: 'runs', action: 'create' },
    { resource: 'runs', action: 'read' },
    { resource: 'runs', action: 'execute' },
    { resource: 'tools', action: 'execute' },
  ],
}

/**
 * Check if a role has a specific permission.
 *
 * Wildcards (`*`) on either resource or action match all values.
 */
export function hasPermission(
  role: ForgeRole,
  resource: ForgePermissionResource,
  action: ForgePermissionAction,
  customPermissions?: Partial<Record<ForgeRole, ForgePermission[]>>,
): boolean {
  const permissions = customPermissions?.[role] ?? DEFAULT_ROLE_PERMISSIONS[role]
  if (!permissions) return false

  return permissions.some(
    (p) =>
      (p.resource === '*' || p.resource === resource) &&
      (p.action === '*' || p.action === action),
  )
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function normalizeRoutePermissions(
  adminOnlyPaths: readonly string[],
  routePermissions?: Record<string, RoutePermissionPolicy>,
): ResolvedRoutePermission[] {
  const policies: Record<string, RoutePermissionPolicy> = {
    ...DEFAULT_ROUTE_PERMISSIONS,
  }
  for (const prefix of adminOnlyPaths) {
    policies[prefix] = { adminOnly: true }
  }
  if (routePermissions) {
    for (const [prefix, policy] of Object.entries(routePermissions)) {
      policies[prefix] = policy
    }
  }
  return Object.entries(policies)
    .map(([prefix, policy]) => ({ prefix, policy }))
    .sort((a, b) => b.prefix.length - a.prefix.length)
}

export function resolveRoutePermission(
  path: string,
  policies: readonly ResolvedRoutePermission[] = normalizeRoutePermissions(DEFAULT_ADMIN_ONLY_PATHS),
): ResolvedRoutePermission | undefined {
  return policies.find(({ prefix }) => pathMatchesPrefix(path, prefix))
}

/** Map an HTTP method to an action. */
function methodToAction(method: string): ForgePermissionAction {
  const map: Record<string, ForgePermissionAction> = {
    GET: 'read',
    POST: 'create',
    PATCH: 'update',
    PUT: 'update',
    DELETE: 'delete',
  }
  return map[method.toUpperCase()] ?? 'read'
}

/**
 * Create RBAC middleware that checks permissions for each request.
 *
 * Extracts the role using the provided config function and checks
 * whether that role has permission to access the requested resource.
 * Health endpoints are always allowed through.
 */
export function rbacMiddleware(config: RBACConfig): MiddlewareHandler {
  const adminOnlyPaths = config.adminOnlyPaths ?? DEFAULT_ADMIN_ONLY_PATHS
  const routePermissions = normalizeRoutePermissions(adminOnlyPaths, config.routePermissions)
  return async (c, next) => {
    // Health endpoints bypass RBAC
    if (pathMatchesPrefix(c.req.path, '/api/health')) {
      return next()
    }

    const role = config.extractRole(c)
    if (!role) {
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'No role assigned to this request' } },
        403,
      )
    }

    c.set('forgeRole' as never, role as never)

    const routePermission = resolveRoutePermission(c.req.path, routePermissions)
    if (!routePermission) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: `No RBAC policy is configured for endpoint '${c.req.path}'`,
          },
        },
        403,
      )
    }

    const { prefix, policy } = routePermission
    if ('adminOnly' in policy) {
      if (role === 'admin') {
        return next()
      }
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: `Role '${role}' cannot access admin-only endpoint '${prefix}'`,
          },
        },
        403,
      )
    }

    const resource = policy.resource
    const action = policy.action ?? methodToAction(c.req.method)
    if (!hasPermission(role, resource, action, config.customPermissions)) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: `Role '${role}' lacks permission ${action}:${resource}`,
          },
        },
        403,
      )
    }

    return next()
  }
}

/**
 * Create a guard for a specific resource + action.
 *
 * Use as: `app.post('/agents', rbacGuard('agents', 'create', config), handler)`
 */
export function rbacGuard(
  resource: ForgePermission['resource'],
  action: ForgePermission['action'],
  config?: RBACConfig,
): MiddlewareHandler {
  return async (c, next) => {
    const role = config
      ? config.extractRole(c)
      : (c.get('forgeRole' as never) as ForgeRole | undefined)

    if (!role) {
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'No role assigned to this request' } },
        403,
      )
    }

    const customPerms = config?.customPermissions
    if (!hasPermission(role, resource, action, customPerms)) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: `Role '${role}' lacks permission ${action}:${resource}`,
          },
        },
        403,
      )
    }

    return next()
  }
}
