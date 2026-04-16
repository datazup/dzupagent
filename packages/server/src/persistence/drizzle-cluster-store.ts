/**
 * Drizzle-backed persistence for agent clusters and their roles.
 *
 * Stores clusters in `agent_clusters` and roles in `cluster_roles`.
 * Follows the same pattern as {@link DrizzleMailboxStore}.
 */
import type { ClusterRole } from '@dzupagent/agent'
import { eq, and } from 'drizzle-orm'
import { agentClusters, clusterRoles } from './drizzle-schema.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzle = any

export interface ClusterRecord {
  id: string
  workspaceType: string
  workspaceOptions: Record<string, unknown>
  metadata: Record<string, unknown>
  roles: ClusterRole[]
  createdAt: Date
  updatedAt: Date
}

export interface CreateClusterInput {
  id: string
  workspaceType?: string
  workspaceOptions?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface ClusterStore {
  create(input: CreateClusterInput): Promise<ClusterRecord>
  findById(id: string): Promise<ClusterRecord | null>
  delete(id: string): Promise<boolean>
  addRole(clusterId: string, role: ClusterRole): Promise<void>
  removeRole(clusterId: string, roleId: string): Promise<boolean>
  listRoles(clusterId: string): Promise<ClusterRole[]>
}

/** In-memory cluster store for testing and single-process deployments. */
export class InMemoryClusterStore implements ClusterStore {
  private readonly clusters = new Map<string, {
    id: string
    workspaceType: string
    workspaceOptions: Record<string, unknown>
    metadata: Record<string, unknown>
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
      roles: [],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async findById(id: string): Promise<ClusterRecord | null> {
    const record = this.clusters.get(id)
    if (!record) return null

    return {
      id: record.id,
      workspaceType: record.workspaceType,
      workspaceOptions: record.workspaceOptions,
      metadata: record.metadata,
      roles: Array.from(record.roles.values()),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async delete(id: string): Promise<boolean> {
    return this.clusters.delete(id)
  }

  async addRole(clusterId: string, role: ClusterRole): Promise<void> {
    const record = this.clusters.get(clusterId)
    if (!record) {
      throw new Error(`NotFound: Cluster "${clusterId}" not found`)
    }
    if (record.roles.has(role.roleId)) {
      throw new Error(`Conflict: Role "${role.roleId}" already exists in cluster "${clusterId}"`)
    }
    record.roles.set(role.roleId, { ...role })
  }

  async removeRole(clusterId: string, roleId: string): Promise<boolean> {
    const record = this.clusters.get(clusterId)
    if (!record) {
      throw new Error(`NotFound: Cluster "${clusterId}" not found`)
    }
    return record.roles.delete(roleId)
  }

  async listRoles(clusterId: string): Promise<ClusterRole[]> {
    const record = this.clusters.get(clusterId)
    if (!record) return []
    return Array.from(record.roles.values())
  }
}

/** Drizzle-backed cluster store for Postgres persistence. */
export class DrizzleClusterStore implements ClusterStore {
  constructor(private readonly db: AnyDrizzle) {}

  async create(input: CreateClusterInput): Promise<ClusterRecord> {
    const now = new Date()
    await this.db.insert(agentClusters).values({
      id: input.id,
      workspaceType: input.workspaceType ?? 'local',
      workspaceOptions: input.workspaceOptions ?? {},
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })

    return {
      id: input.id,
      workspaceType: input.workspaceType ?? 'local',
      workspaceOptions: input.workspaceOptions ?? {},
      metadata: input.metadata ?? {},
      roles: [],
      createdAt: now,
      updatedAt: now,
    }
  }

  async findById(id: string): Promise<ClusterRecord | null> {
    const rows = await this.db
      .select()
      .from(agentClusters)
      .where(eq(agentClusters.id, id))
      .limit(1)

    if (rows.length === 0) return null

    const row = rows[0]!
    const roles = await this.listRoles(id)

    return {
      id: row.id,
      workspaceType: row.workspaceType,
      workspaceOptions: (row.workspaceOptions ?? {}) as Record<string, unknown>,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      roles,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(agentClusters)
      .where(eq(agentClusters.id, id))

    return ((result as { rowCount?: number }).rowCount ?? 0) > 0
  }

  async addRole(clusterId: string, role: ClusterRole): Promise<void> {
    await this.db.insert(clusterRoles).values({
      clusterId,
      roleId: role.roleId,
      agentId: role.agentId,
      capabilities: role.capabilities ?? [],
    })
  }

  async removeRole(clusterId: string, roleId: string): Promise<boolean> {
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

  async listRoles(clusterId: string): Promise<ClusterRole[]> {
    const rows = await this.db
      .select()
      .from(clusterRoles)
      .where(eq(clusterRoles.clusterId, clusterId))

    return rows.map((row: { roleId: string; agentId: string; capabilities: string[] | null }) => ({
      roleId: row.roleId,
      agentId: row.agentId,
      capabilities: (row.capabilities ?? []) as string[],
    }))
  }
}
