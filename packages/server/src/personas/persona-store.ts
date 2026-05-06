/**
 * Persona persistence — in-memory store for persona definitions.
 *
 * A persona encapsulates a named set of instructions and optional model
 * configuration that can be applied to agent runs to alter behavior.
 */

export interface PersonaRecord {
  id: string
  name: string
  instructions: string
  modelId?: string | null
  temperature?: number | null
  metadata?: Record<string, unknown> | null
  tenantId?: string | null
  createdAt: string
  updatedAt: string
}

export interface PersonaStore {
  save(persona: Omit<PersonaRecord, 'createdAt' | 'updatedAt'>): Promise<PersonaRecord>
  list(filter?: { tenantId?: string }): Promise<PersonaRecord[]>
  get(id: string, tenantId?: string): Promise<PersonaRecord | null>
  update(
    id: string,
    patch: Partial<Omit<PersonaRecord, 'id' | 'createdAt' | 'updatedAt'>>,
    tenantId?: string,
  ): Promise<PersonaRecord | null>
  delete(id: string, tenantId?: string): Promise<boolean>
}

/**
 * In-memory persona store for development and testing.
 */
export class InMemoryPersonaStore implements PersonaStore {
  private readonly personas = new Map<string, PersonaRecord>()

  async save(
    persona: Omit<PersonaRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<PersonaRecord> {
    const now = new Date().toISOString()
    const existing = this.personas.get(persona.id)
    const record: PersonaRecord = {
      ...persona,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.personas.set(record.id, record)
    return record
  }

  async list(filter?: { tenantId?: string }): Promise<PersonaRecord[]> {
    let results = Array.from(this.personas.values())
    if (filter?.tenantId !== undefined) {
      results = results.filter((p) => (p.tenantId ?? 'default') === filter.tenantId)
    }
    return results
  }

  async get(id: string, tenantId?: string): Promise<PersonaRecord | null> {
    const persona = this.personas.get(id) ?? null
    if (!persona) return null
    if (tenantId && (persona.tenantId ?? 'default') !== tenantId) return null
    return persona
  }

  async update(
    id: string,
    patch: Partial<Omit<PersonaRecord, 'id' | 'createdAt' | 'updatedAt'>>,
    tenantId?: string,
  ): Promise<PersonaRecord | null> {
    const existing = await this.get(id, tenantId)
    if (!existing) return null
    const updated: PersonaRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    this.personas.set(id, updated)
    return updated
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    if (tenantId && !(await this.get(id, tenantId))) return false
    return this.personas.delete(id)
  }
}
