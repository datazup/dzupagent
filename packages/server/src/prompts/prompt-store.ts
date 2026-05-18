/**
 * Prompt version persistence — in-memory store for prompt versions.
 *
 * A prompt version captures a named, typed prompt template with a version
 * counter, status lifecycle (draft → published → archived), and optional
 * ownership linkage (agent or persona).
 */

export type PromptStatus = 'draft' | 'published' | 'archived'

export interface PromptVersionRecord {
  id: string
  promptId: string
  name: string
  type: string
  category?: string | null
  content: string
  version: number
  status: PromptStatus
  ownerId?: string | null
  ownerType?: 'agent' | 'persona' | null
  metadata?: Record<string, unknown> | null
  tenantId?: string | null
  createdAt: string
  updatedAt: string
}

export interface PromptStore {
  save(prompt: Omit<PromptVersionRecord, 'createdAt' | 'updatedAt'>): Promise<PromptVersionRecord>
  list(filter?: {
    type?: string
    category?: string
    status?: PromptStatus
    tenantId?: string
  }): Promise<PromptVersionRecord[]>
  get(id: string, tenantId?: string): Promise<PromptVersionRecord | null>
  getActive(promptId: string, tenantId?: string): Promise<PromptVersionRecord | null>
  update(
    id: string,
    patch: Partial<Omit<PromptVersionRecord, 'id' | 'promptId' | 'version' | 'createdAt' | 'updatedAt'>>,
    tenantId?: string,
  ): Promise<PromptVersionRecord | null>
  publish(id: string, tenantId?: string): Promise<PromptVersionRecord | null>
  rollback(promptId: string, targetId: string, tenantId?: string): Promise<PromptVersionRecord | null>
  delete(id: string, tenantId?: string): Promise<boolean>
}

export class InMemoryPromptStore implements PromptStore {
  private readonly versions = new Map<string, PromptVersionRecord>()

  async save(
    prompt: Omit<PromptVersionRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<PromptVersionRecord> {
    const now = new Date().toISOString()
    const existing = this.versions.get(prompt.id)
    const record: PromptVersionRecord = {
      ...prompt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.versions.set(record.id, record)
    return record
  }

  async list(filter?: {
    type?: string
    category?: string
    status?: PromptStatus
    tenantId?: string
  }): Promise<PromptVersionRecord[]> {
    let records = Array.from(this.versions.values())
    if (filter?.type) records = records.filter((r) => r.type === filter.type)
    if (filter?.category) records = records.filter((r) => r.category === filter.category)
    if (filter?.status) records = records.filter((r) => r.status === filter.status)
    if (filter?.tenantId) records = records.filter((r) => (r.tenantId ?? 'default') === filter.tenantId)
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async get(id: string, tenantId?: string): Promise<PromptVersionRecord | null> {
    const record = this.versions.get(id) ?? null
    if (!record) return null
    if (tenantId && (record.tenantId ?? 'default') !== tenantId) return null
    return record
  }

  async getActive(promptId: string, tenantId?: string): Promise<PromptVersionRecord | null> {
    const published = Array.from(this.versions.values())
      .filter((r) => r.promptId === promptId && r.status === 'published')
      .filter((r) => tenantId === undefined || (r.tenantId ?? 'default') === tenantId)
      .sort((a, b) => b.version - a.version)
    return published[0] ?? null
  }

  async update(
    id: string,
    patch: Partial<Omit<PromptVersionRecord, 'id' | 'promptId' | 'version' | 'createdAt' | 'updatedAt'>>,
    tenantId?: string,
  ): Promise<PromptVersionRecord | null> {
    const existing = await this.get(id, tenantId)
    if (!existing) return null
    const updated: PromptVersionRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    this.versions.set(id, updated)
    return updated
  }

  async publish(id: string, tenantId?: string): Promise<PromptVersionRecord | null> {
    const target = await this.get(id, tenantId)
    if (!target) return null

    // Archive all other published versions for the same promptId
    for (const [key, record] of this.versions) {
      if (
        record.promptId === target.promptId &&
        record.status === 'published' &&
        (record.tenantId ?? 'default') === (target.tenantId ?? 'default') &&
        key !== id
      ) {
        this.versions.set(key, { ...record, status: 'archived', updatedAt: new Date().toISOString() })
      }
    }

    const published: PromptVersionRecord = {
      ...target,
      status: 'published',
      updatedAt: new Date().toISOString(),
    }
    this.versions.set(id, published)
    return published
  }

  async rollback(promptId: string, targetId: string, tenantId?: string): Promise<PromptVersionRecord | null> {
    const target = await this.get(targetId, tenantId)
    if (!target || target.promptId !== promptId) return null
    return this.publish(targetId, tenantId)
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    const record = await this.get(id, tenantId)
    if (!record || record.status === 'published') return false
    return this.versions.delete(id)
  }
}
