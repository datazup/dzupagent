/**
 * AgentFileExporter — exports agent memory to the AgentFile format.
 *
 * Iterates configured namespaces on MemoryService, collects all records
 * with provenance metadata, and packages them into a portable AgentFile
 * JSON structure.
 *
 * Usage:
 *   const exporter = new AgentFileExporter({
 *     memoryService: svc,
 *     agentName: 'planner',
 *     agentUri: 'forge://acme/planner',
 *   })
 *   const file = await exporter.export()
 */
import { createHash } from 'node:crypto'
import type { MemoryService } from '../memory-service.js'
import { extractProvenance } from '../provenance/provenance-writer.js'
import type {
  AgentFile,
  AgentFileMemoryRecord,
  AgentFileMemorySection,
  AgentFilePromptsSection,
  AgentFileStateSection,
} from './types.js'
import { AGENT_FILE_SCHEMA, AGENT_FILE_VERSION } from './types.js'

/**
 * Configuration for the AgentFileExporter.
 */
export interface AgentFileExporterConfig {
  /** The MemoryService to export records from */
  memoryService: MemoryService
  /** Human-readable agent name */
  agentName: string
  /** forge:// URI of the agent performing the export */
  agentUri: string
  /** Optional agent description */
  agentDescription?: string | undefined
  /** Optional list of agent capabilities */
  capabilities?: string[] | undefined
  /** Scope used to read namespaces (e.g. { tenantId: 't1', projectId: 'p1' }) */
  scope: Record<string, string>
  /** Optional prompt templates to include in the export */
  prompts?: AgentFilePromptsSection | undefined
  /** Optional state snapshot to include in the export */
  state?: AgentFileStateSection | undefined
}

/**
 * Options for the export operation.
 */
export interface ExportOptions {
  /** Specific namespaces to export (default: all non-internal) */
  namespaces?: string[] | undefined
  /** Whether to include SHA-256 signature (default: true) */
  sign?: boolean | undefined
}

/**
 * Exports agent memory namespaces to the portable AgentFile format.
 */
export class AgentFileExporter {
  private readonly config: AgentFileExporterConfig

  constructor(config: AgentFileExporterConfig) {
    this.config = config
  }

  /**
   * Export memory namespaces to AgentFile format.
   *
   * @param options.namespaces - specific namespaces to export (default: all non-internal)
   * @param options.sign - whether to include SHA-256 signature (default: true)
   */
  async export(options?: ExportOptions): Promise<AgentFile> {
    const sign = options?.sign ?? true
    const requestedNamespaces = options?.namespaces

    // Collect all namespace names from MemoryService
    const allNamespaces = this.getNamespaceNames()

    // Filter namespaces
    const namespacesToExport = requestedNamespaces
      ? allNamespaces.filter(ns => requestedNamespaces.includes(ns))
      : allNamespaces.filter(ns => !ns.startsWith('__'))

    // Build memory section
    const memory = await this.exportMemory(namespacesToExport)

    // Build the AgentFile
    const agentFile: AgentFile = {
      $schema: AGENT_FILE_SCHEMA,
      version: AGENT_FILE_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBy: this.config.agentUri,
      agent: {
        name: this.config.agentName,
        ...(this.config.agentDescription !== undefined && {
          description: this.config.agentDescription,
        }),
        ...(this.config.capabilities !== undefined &&
          this.config.capabilities.length > 0 && {
            capabilities: this.config.capabilities,
          }),
      },
      memory,
    }

    // Include optional sections
    if (this.config.prompts) {
      agentFile.prompts = this.config.prompts
    }
    if (this.config.state) {
      agentFile.state = this.config.state
    }

    // Compute signature over content sections
    if (sign) {
      agentFile.signature = this.computeSignature(
        memory,
        agentFile.prompts,
        agentFile.state,
      )
    }

    return agentFile
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Get all namespace names from the MemoryService.
   * Accesses the private nsMap via the public getNamespaceNames method if
   * available, otherwise falls back to the internal map.
   */
  private getNamespaceNames(): string[] {
    const svc = this.config.memoryService
    // Use getNamespaceNames() if available on the service
    if ('getNamespaceNames' in svc && typeof svc.getNamespaceNames === 'function') {
      return (svc as MemoryService & { getNamespaceNames(): string[] }).getNamespaceNames()
    }
    // Fallback: access nsMap directly (works with the current MemoryService implementation)
    const nsMap = (svc as unknown as { nsMap: Map<string, unknown> }).nsMap
    if (nsMap instanceof Map) {
      return Array.from(nsMap.keys())
    }
    return []
  }

  /**
   * Export records from the given namespaces.
   */
  private async exportMemory(
    namespaces: string[],
  ): Promise<AgentFileMemorySection> {
    const result: AgentFileMemorySection = { namespaces: {} }
    const svc = this.config.memoryService

    for (const ns of namespaces) {
      try {
        const records = await svc.get(ns, this.config.scope)
        const exported: AgentFileMemoryRecord[] = []

        for (const record of records) {
          const provenance = extractProvenance(record)

          // Derive key from the record
          const key =
            typeof record['_key'] === 'string'
              ? record['_key']
              : `record-${exported.length}`

          const entry: AgentFileMemoryRecord = {
            key,
            value: record,
          }

          if (provenance) {
            entry.provenance = provenance
            entry.createdAt = provenance.createdAt
          }

          exported.push(entry)
        }

        if (exported.length > 0) {
          result.namespaces[ns] = exported
        }
      } catch {
        // Non-fatal — skip namespaces that fail to read
      }
    }

    return result
  }

  /**
   * Compute SHA-256 hex digest over the content sections.
   * Uses sorted keys for deterministic hashing.
   */
  private computeSignature(
    memory: AgentFileMemorySection,
    prompts?: AgentFilePromptsSection,
    state?: AgentFileStateSection,
  ): string {
    const payload = { memory, prompts, state }
    const canonical = JSON.stringify(payload, sortedReplacer)
    return createHash('sha256').update(canonical).digest('hex')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * JSON replacer that sorts object keys for deterministic serialization.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}
