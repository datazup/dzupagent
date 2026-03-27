/**
 * Role-Based Access Control (RBAC) middleware for DzipAgent server.
 *
 * Provides role-permission mapping and middleware guards that check
 * whether the current request's role has permission to access a resource.
 */
import type { MiddlewareHandler } from 'hono'

export type ForgeRole = 'admin' | 'operator' | 'viewer' | 'agent'

export interface ForgePermission {
  resource: 'agents' | 'runs' | 'tools' | 'approvals' | 'settings' | '*'
  action: 'create' | 'read' | 'update' | 'delete' | 'execute' | '*'
}

export interface RBACConfig {
  /** Function to extract role from request context */
  extractRole: (c: {
    req: { header: (name: string) => string | undefined }
    get: (key: string) => unknown
  }) => ForgeRole | undefined
  /** Custom role-permission mapping (merged with defaults) */
  customPermissions?: Partial<Record<ForgeRole, ForgePermission[]>>
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
  resource: ForgePermission['resource'],
  action: ForgePermission['action'],
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

/** Map a URL path segment to a resource name. */
function pathToResource(path: string): ForgePermission['resource'] | undefined {
  const resourceMap: Record<string, ForgePermission['resource']> = {
    agents: 'agents',
    runs: 'runs',
    tools: 'tools',
    approve: 'approvals',
    reject: 'approvals',
  }
  const segments = path.replace(/^\/api\//, '').split('/')
  for (const segment of segments) {
    if (segment in resourceMap) return resourceMap[segment]
  }
  return undefined
}

/** Map an HTTP method to an action. */
function methodToAction(method: string): ForgePermission['action'] {
  const map: Record<string, ForgePermission['action']> = {
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
  return async (c, next) => {
    // Health endpoints bypass RBAC
    if (c.req.path.startsWith('/api/health')) {
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

    const resource = pathToResource(c.req.path)
    if (!resource) {
      return next()
    }

    const action = methodToAction(c.req.method)
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
