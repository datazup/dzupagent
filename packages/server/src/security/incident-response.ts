/**
 * Incident response engine — monitors DzupEventBus for security-relevant
 * events and executes automated playbooks (kill agent, disable tool, etc.).
 */
import type { DzupEventBus, DzupEvent } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IncidentAction =
  | 'kill_agent'
  | 'disable_tool'
  | 'quarantine_namespace'
  | 'webhook_notification'
  | 'log_alert'

export interface IncidentTrigger {
  /** DzupEvent type to match */
  eventType: string
  /** Optional filter — only triggers when condition returns true */
  condition?: (event: Record<string, unknown>) => boolean
  severity: 'low' | 'medium' | 'high' | 'critical'
}

export interface PlaybookAction {
  type: IncidentAction
  /** Action-specific configuration */
  config: Record<string, unknown>
}

export interface IncidentPlaybook {
  id: string
  name: string
  description: string
  triggers: IncidentTrigger[]
  actions: PlaybookAction[]
  enabled: boolean
  /** Prevent repeated firing within this window (default: 60000ms) */
  cooldownMs?: number
}

export interface IncidentActionResult {
  action: IncidentAction
  success: boolean
  details?: string
}

export interface IncidentRecord {
  id: string
  playbookId: string
  /** The event type that triggered this incident */
  triggeredBy: string
  timestamp: Date
  severity: string
  actionsTaken: IncidentActionResult[]
  resolved: boolean
  resolvedAt?: Date
}

export interface IncidentResponseConfig {
  playbooks: IncidentPlaybook[]
  onIncident?: (record: IncidentRecord) => void
}

// ---------------------------------------------------------------------------
// Action executors
// ---------------------------------------------------------------------------

/** Set of agents marked for kill by the incident engine. */
const killedAgents = new Set<string>()
/** Set of tools disabled by the incident engine. */
const disabledTools = new Set<string>()
/** Set of namespaces quarantined by the incident engine. */
const quarantinedNamespaces = new Set<string>()

/** Check if an agent has been killed by incident response. */
export function isAgentKilled(agentId: string): boolean {
  return killedAgents.has(agentId)
}

/** Check if a tool has been disabled by incident response. */
export function isToolDisabled(toolName: string): boolean {
  return disabledTools.has(toolName)
}

/** Check if a namespace has been quarantined by incident response. */
export function isNamespaceQuarantined(namespace: string): boolean {
  return quarantinedNamespaces.has(namespace)
}

/** Clear all incident flags (used for testing). */
export function clearIncidentFlags(): void {
  killedAgents.clear()
  disabledTools.clear()
  quarantinedNamespaces.clear()
}

type FetchFn = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>

async function executeAction(
  action: PlaybookAction,
  fetchImpl?: FetchFn,
): Promise<IncidentActionResult> {
  const config = action.config

  switch (action.type) {
    case 'kill_agent': {
      const agentId = config['agentId']
      if (typeof agentId !== 'string') {
        return { action: 'kill_agent', success: false, details: 'Missing agentId in config' }
      }
      killedAgents.add(agentId)
      return { action: 'kill_agent', success: true, details: `Agent ${agentId} marked for kill` }
    }

    case 'disable_tool': {
      const toolName = config['toolName']
      if (typeof toolName !== 'string') {
        return { action: 'disable_tool', success: false, details: 'Missing toolName in config' }
      }
      disabledTools.add(toolName)
      return { action: 'disable_tool', success: true, details: `Tool ${toolName} disabled` }
    }

    case 'quarantine_namespace': {
      const namespace = config['namespace']
      if (typeof namespace !== 'string') {
        return {
          action: 'quarantine_namespace',
          success: false,
          details: 'Missing namespace in config',
        }
      }
      quarantinedNamespaces.add(namespace)
      return {
        action: 'quarantine_namespace',
        success: true,
        details: `Namespace ${namespace} quarantined`,
      }
    }

    case 'webhook_notification': {
      const url = config['url']
      if (typeof url !== 'string') {
        return {
          action: 'webhook_notification',
          success: false,
          details: 'Missing url in config',
        }
      }
      const method = typeof config['method'] === 'string' ? config['method'] : 'POST'
      try {
        const doFetch = fetchImpl ?? globalThis.fetch
        const response = await doFetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'incident_notification', timestamp: new Date().toISOString() }),
        })
        return {
          action: 'webhook_notification',
          success: response.ok,
          details: `Webhook ${method} ${url} → ${response.status}`,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { action: 'webhook_notification', success: false, details: `Webhook failed: ${msg}` }
      }
    }

    case 'log_alert': {
      const message = config['message']
      if (typeof message !== 'string') {
        return { action: 'log_alert', success: false, details: 'Missing message in config' }
      }
       
      console.warn(`[IncidentResponse] ALERT: ${message}`)
      return { action: 'log_alert', success: true, details: message }
    }

    default:
      return { action: action.type, success: false, details: `Unknown action type: ${action.type}` }
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

let incidentCounter = 0

function generateIncidentId(): string {
  incidentCounter += 1
  return `incident-${Date.now()}-${incidentCounter}`
}

export class IncidentResponseEngine {
  private readonly playbooks: Map<string, IncidentPlaybook>
  private readonly incidents: IncidentRecord[] = []
  private readonly lastTrigger: Map<string, number> = new Map()
  private readonly onIncident?: (record: IncidentRecord) => void
  private unsubscribe: (() => void) | undefined
  private fetchImpl: FetchFn | undefined

  constructor(config: IncidentResponseConfig) {
    this.playbooks = new Map()
    for (const pb of config.playbooks) {
      this.playbooks.set(pb.id, pb)
    }
    this.onIncident = config.onIncident
  }

  /**
   * Inject a custom fetch implementation (useful for testing).
   */
  setFetchImpl(fn: FetchFn): void {
    this.fetchImpl = fn
  }

  /**
   * Start monitoring — subscribe to DzupEventBus.
   */
  attach(eventBus: DzupEventBus): void {
    this.detach()
    this.unsubscribe = eventBus.onAny((event: DzupEvent) => {
      void this.handleEvent(event)
    })
  }

  /**
   * Stop monitoring.
   */
  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = undefined
    }
  }

  /**
   * Execute all actions for a matched playbook.
   */
  async executePlaybook(
    playbook: IncidentPlaybook,
    triggerEvent: Record<string, unknown>,
  ): Promise<IncidentRecord> {
    const eventType = typeof triggerEvent['type'] === 'string' ? triggerEvent['type'] : 'unknown'
    const trigger = playbook.triggers.find((t) => t.eventType === eventType)
    const severity = trigger?.severity ?? 'medium'

    const actionsTaken: IncidentActionResult[] = []
    for (const action of playbook.actions) {
      const result = await executeAction(action, this.fetchImpl)
      actionsTaken.push(result)
    }

    const record: IncidentRecord = {
      id: generateIncidentId(),
      playbookId: playbook.id,
      triggeredBy: eventType,
      timestamp: new Date(),
      severity,
      actionsTaken,
      resolved: false,
    }

    this.incidents.push(record)
    this.onIncident?.(record)

    return record
  }

  /**
   * Get all incident records.
   */
  getIncidents(): IncidentRecord[] {
    return [...this.incidents]
  }

  /**
   * Resolve an incident by ID.
   */
  resolveIncident(incidentId: string): void {
    const incident = this.incidents.find((i) => i.id === incidentId)
    if (incident) {
      incident.resolved = true
      incident.resolvedAt = new Date()
    }
  }

  /**
   * Add a playbook at runtime.
   */
  addPlaybook(playbook: IncidentPlaybook): void {
    this.playbooks.set(playbook.id, playbook)
  }

  /**
   * Remove a playbook at runtime.
   */
  removePlaybook(playbookId: string): void {
    this.playbooks.delete(playbookId)
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.detach()
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async handleEvent(event: DzupEvent): Promise<void> {
    const eventType = event.type
    const eventRecord = event as unknown as Record<string, unknown>

    for (const playbook of this.playbooks.values()) {
      if (!playbook.enabled) continue

      for (const trigger of playbook.triggers) {
        if (trigger.eventType !== eventType) continue

        // Check optional condition
        if (trigger.condition && !trigger.condition(eventRecord)) continue

        // Check cooldown
        const cooldownMs = playbook.cooldownMs ?? 60_000
        const lastTime = this.lastTrigger.get(playbook.id)
        const now = Date.now()
        if (lastTime !== undefined && now - lastTime < cooldownMs) continue

        // Mark trigger time and execute
        this.lastTrigger.set(playbook.id, now)
        await this.executePlaybook(playbook, eventRecord)
      }
    }
  }
}
