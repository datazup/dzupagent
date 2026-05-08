/**
 * PostgresRegistry queries — ECO-048/049.
 *
 * In-memory store implementation, row<->agent mappers, and id generation
 * for the registry persistence layer.
 */

import type { RegisteredAgent, RegisterAgentInput, AgentHealth } from '@dzupagent/core/pipeline'

import type { AgentRow, RegistryStore } from './postgres-registry-types.js'

// ------------------------------------------------------------------ InMemory Store

export class InMemoryRegistryStore implements RegistryStore {
  private readonly _rows = new Map<string, AgentRow>()

  async insert(row: AgentRow): Promise<void> {
    this._rows.set(row.id, { ...row })
  }

  async update(id: string, partial: Partial<AgentRow>): Promise<void> {
    const existing = this._rows.get(id)
    if (!existing) return
    this._rows.set(id, { ...existing, ...partial })
  }

  async delete(id: string): Promise<void> {
    this._rows.delete(id)
  }

  async getById(id: string): Promise<AgentRow | undefined> {
    const row = this._rows.get(id)
    return row ? { ...row } : undefined
  }

  async list(limit: number, offset: number): Promise<AgentRow[]> {
    const all = [...this._rows.values()]
    return all.slice(offset, offset + limit)
  }

  async count(): Promise<number> {
    return this._rows.size
  }

  async findByCapabilityPrefix(prefix: string, limit: number, offset: number): Promise<AgentRow[]> {
    const lowerPrefix = prefix.toLowerCase()
    const matched: AgentRow[] = []
    for (const row of this._rows.values()) {
      const hasMatch = row.capabilities.some((c) => c.name.toLowerCase().startsWith(lowerPrefix))
      if (hasMatch) matched.push(row)
    }
    return matched.slice(offset, offset + limit)
  }

  async findByCapabilityExact(name: string, limit: number, offset: number): Promise<AgentRow[]> {
    const matched: AgentRow[] = []
    for (const row of this._rows.values()) {
      const hasMatch = row.capabilities.some((c) => c.name === name)
      if (hasMatch) matched.push(row)
    }
    return matched.slice(offset, offset + limit)
  }

  async findExpired(nowMs: number): Promise<AgentRow[]> {
    const expired: AgentRow[] = []
    for (const row of this._rows.values()) {
      if (row.ttl_ms !== null) {
        const registeredMs = new Date(row.registered_at).getTime()
        if (registeredMs + row.ttl_ms < nowMs) {
          expired.push(row)
        }
      }
    }
    return expired
  }
}

// ------------------------------------------------------------------ Helpers

let idCounter = 0
export function generateId(): string {
  idCounter++
  return `pg-agent-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

type AgentAuthenticationType = NonNullable<RegisteredAgent['authentication']>['type']

const AGENT_AUTHENTICATION_TYPES = new Set<AgentAuthenticationType>([
  'none',
  'bearer',
  'api-key',
  'oauth2',
  'mtls',
  'delegation',
])

function isAgentAuthenticationType(value: string): value is AgentAuthenticationType {
  return AGENT_AUTHENTICATION_TYPES.has(value as AgentAuthenticationType)
}

export function cloneRecord(value: Record<string, unknown> | null): Record<string, unknown> | null {
  return value ? { ...value } : null
}

export function rowToAgent(row: AgentRow): RegisteredAgent {
  const health: AgentHealth = {
    status: row.health_status,
    ...(row.health_data as Partial<AgentHealth> | null),
  }

  const authentication = row.authentication_type && isAgentAuthenticationType(row.authentication_type)
    ? {
        type: row.authentication_type,
        config: cloneRecord(row.authentication_config) ?? undefined,
      }
    : undefined

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    endpoint: row.endpoint ?? undefined,
    protocols: row.protocols,
    capabilities: row.capabilities,
    authentication,
    version: row.version ?? undefined,
    sla: row.sla as RegisteredAgent['sla'],
    health,
    metadata: row.metadata ?? undefined,
    registeredAt: new Date(row.registered_at),
    lastUpdatedAt: new Date(row.last_updated_at),
    ttlMs: row.ttl_ms ?? undefined,
    identity: row.identity ? ({ ...row.identity } as unknown as RegisteredAgent['identity']) : undefined,
    uri: row.uri ?? undefined,
  }
}

export function agentToRow(id: string, input: RegisterAgentInput, now: Date): AgentRow {
  return {
    id,
    name: input.name,
    description: input.description,
    endpoint: input.endpoint ?? null,
    protocols: input.protocols ?? [],
    capabilities: [...input.capabilities],
    authentication_type: input.authentication?.type ?? null,
    authentication_config: input.authentication?.config ?? null,
    version: input.version ?? null,
    sla: input.sla ? { ...input.sla } : null,
    health_status: 'unknown',
    health_data: null,
    metadata: input.metadata ? { ...input.metadata } : null,
    registered_at: now.toISOString(),
    last_updated_at: now.toISOString(),
    ttl_ms: input.ttlMs ?? null,
    identity: input.identity ? { ...input.identity } : null,
    uri: input.uri ?? null,
  }
}
