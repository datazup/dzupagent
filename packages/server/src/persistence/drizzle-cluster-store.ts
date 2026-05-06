/**
 * Drizzle-backed persistence for agent clusters and their roles.
 *
 * Stores clusters in `agent_clusters` and roles in `cluster_roles`.
 * Follows the same pattern as {@link DrizzleMailboxStore}.
 */
import type { ClusterRole } from '@dzupagent/agent'
import { eq, and } from 'drizzle-orm'
import { agentClusters, clusterRoles } from './drizzle-schema.js'
import type { DrizzleStoreDatabase } from './drizzle-store-types.js'

export interface ClusterRecord {
  id: string
  workspaceType: string
  workspaceOptions: Record<string, unknown>
  metadata: Record<string, unknown>
  tenantId?: string | null
  roles: ClusterRole[]
  createdAt: Date
  updatedAt: Date
}

export interface CreateClusterInput {
  id: string
  workspaceType?: string
  workspaceOptions?: Record<string, unknown>
  metadata?: Record<string, unknown>
  tenantId?: string
}

export interface ClusterStore {
  create(input: CreateClusterInput): Promise<ClusterRecord>
  findById(id: string, tenantId?: string): Promise<ClusterRecord | null>
  delete(id: string, tenantId?: string): Promise<boolean>
  addRole(clusterId: string, role: ClusterRole, tenantId?: string): Promise<void>
  removeRole(clusterId: string, roleId: string, tenantId?: string): Promise<boolean>
  listRoles(clusterId: string, tenantId?: string): Promise<ClusterRole[]>
}

/** In-memory cluster store for testing and single-process deployments. */
export class InMemoryClusterStore implements ClusterStore {
  private readonly clusters = new Map<string, {
    id: string
    workspaceType: string
    workspaceOptions: Record<string, unknown>
    metadata: Record<string, unknown>
    tenantId: string
    roles: Map<string, ClusterRole>
    createdAt: Date
    updatedAt: Date
  }>()

  async create(input: CreateClusterInput): Promise<ClusterRecord> {
    if (this.clusters.has(input.id)) {
      throw new Error(`Conflict: Cluster "${input.id}" already exists`)
    }

    const now = new Date()
    const record = {
      id: input.id,
      workspaceType: input.workspaceType ?? 'local',
      workspaceOptions: input.workspaceOptions ?? {},
      metadata: input.metadata ?? {},
      tenantId: input.tenantId ?? 'default',
      roles: new Map<string, ClusterRole>(),
      createdAt: now,
      updatedAt: now,
    }
    this.clusters.set(input.id, record)

    return {
      id: record.id,
      workspaceType: record.workspaceType,
      workspaceOptions: record.workspaceOptions,
      metadata: record.metadata,
      tenantId: record.tenantId,
      roles: [],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async findById(id: string, tenantId?: string): Promise<ClusterRecord | null> {
    const record = this.clusters.get(id)
    if (!record) return null
    if (tenantId && record.tenantId !== tenantId) return null

    return {
      id: record.id,
      workspaceType: record.workspaceType,
      workspaceOptions: record.workspaceOptions,
      metadata: record.metadata,
      tenantId: record.tenantId,
      roles: Array.from(record.roles.values()),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    if (tenantId && !(await this.findById(id, tenantId))) return false
    return this.clusters.delete(id)
  }

  async addRole(clusterId: string, role: ClusterRole, tenantId?: string): Promise<void> {
    const record = this.clusters.get(clusterId)
    if (!record) {
      throw new Error(`NotFound: Cluster "${clusterId}" not found`)
    }
    if (tenantId && record.tenantId !== tenantId) {
      throw new Error(`NotFound: Cluster "${clusterId}" not found`)
    }
    if (record.roles.has(role.roleId)) {
      throw new Error(`Conflict: Role "${role.roleId}" already exists in cluster "${clusterId}"`)
    }
    record.roles.set(role.roleId, { ...role })
  }

  async removeRole(clusterId: string, roleId: string, tenantId?: string): Promise<boolean> {
    const record = this.clusters.get(clusterId)
    if (!record) {
      throw new Error(`NotFound: Cluster "${clusterId}" not found`)
    }
    if (tenantId && record.tenantId !== tenantId) {
      throw new Error(`NotFound: Cluster "${clusterId}" not found`)
    }
    return record.roles.delete(roleId)
  }

  async listRoles(clusterId: string, tenantId?: string): Promise<ClusterRole[]> {
    const record = this.clusters.get(clusterId)
    if (!record) return []
    if (tenantId && record.tenantId !== tenantId) return []
    return Array.from(record.roles.values())
  }
}

/** Drizzle-backed cluster store for Postgres persistence. */
export class DrizzleClusterStore implements ClusterStore {
  constructor(private readonly db: DrizzleStoreDatabase) {}

  async create(input: CreateClusterInput): Promise<ClusterRecord> {
    const now = new Date()
    await this.db.insert(agentClusters).values({
      id: input.id,
      workspaceType: input.workspaceType ?? 'local',
      workspaceOptions: input.workspaceOptions ?? {},
      metadata: input.metadata ?? {},
      tenantId: input.tenantId ?? 'default',
      createdAt: now,
      updatedAt: now,
    })

    return {
      id: input.id,
      workspaceType: input.workspaceType ?? 'local',
      workspaceOptions: input.workspaceOptions ?? {},
      metadata: input.metadata ?? {},
      tenantId: input.tenantId ?? 'default',
      roles: [],
      createdAt: now,
      updatedAt: now,
    }
  }

  async findById(id: string, tenantId?: string): Promise<ClusterRecord | null> {
    const conditions = [eq(agentClusters.id, id)]
    if (tenantId !== undefined) conditions.push(eq(agentClusters.tenantId, tenantId))

    const rows = await this.db
      .select()
      .from(agentClusters)
      .where(and(...conditions))
      .limit(1)

    if (rows.length === 0) return null

    const row = rows[0]! as {
      id: string
      workspaceType: string
      workspaceOptions: Record<string, unknown> | null
      metadata: Record<string, unknown> | null
      tenantId: string
      createdAt: Date
      updatedAt: Date
    }
    const roles = await this.listRoles(id)

    return {
      id: row.id,
      workspaceType: row.workspaceType,
      workspaceOptions: (row.workspaceOptions ?? {}) as Record<string, unknown>,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      tenantId: row.tenantId,
      roles,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    const conditions = [eq(agentClusters.id, id)]
    if (tenantId !== undefined) conditions.push(eq(agentClusters.tenantId, tenantId))

    const result = await this.db
      .delete(agentClusters)
      .where(and(...conditions))

    return ((result as { rowCount?: number }).rowCount ?? 0) > 0
  }

  async addRole(clusterId: string, role: ClusterRole, tenantId?: string): Promise<void> {
    const cluster = await this.findById(clusterId, tenantId)
    if (!cluster) {
      throw new Error(`NotFound: Cluster "${clusterId}" not found`)
    }

    await this.db.insert(clusterRoles).values({
      clusterId,
      roleId: role.roleId,
      agentId: role.agentId,
      capabilities: role.capabilities ?? [],
    })
  }

  async removeRole(clusterId: string, roleId: string, tenantId?: string): Promise<boolean> {
    const cluster = await this.findById(clusterId, tenantId)
    if (!cluster) {
      throw new Error(`NotFound: Cluster "${clusterId}" not found`)
    }

    const result = await this.db
      .delete(clusterRoles)
      .where(
        and(
          eq(clusterRoles.clusterId, clusterId),
          eq(clusterRoles.roleId, roleId),
        ),
      )

    return ((result as { rowCount?: number }).rowCount ?? 0) > 0
  }

  async listRoles(clusterId: string, tenantId?: string): Promise<ClusterRole[]> {
    if (tenantId !== undefined) {
      const exists = await this.db
        .select({ id: agentClusters.id })
        .from(agentClusters)
        .where(and(eq(agentClusters.id, clusterId), eq(agentClusters.tenantId, tenantId)))
        .limit(1)
      if (exists.length === 0) return []
    }

    const rows = await this.db
      .select()
      .from(clusterRoles)
      .where(eq(clusterRoles.clusterId, clusterId)) as Array<{
        roleId: string
        agentId: string
        capabilities: string[] | null
      }>

    return rows.map((row) => ({
      roleId: row.roleId,
      agentId: row.agentId,
      capabilities: (row.capabilities ?? []) as string[],
    }))
  }
}
