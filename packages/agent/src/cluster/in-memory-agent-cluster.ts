/**
 * In-memory implementation of {@link AgentCluster}.
 *
 * Manages roles and delegates message persistence to the injected
 * {@link MailboxStore}. Suitable for single-process deployments and tests.
 */
import { randomUUID } from 'node:crypto'
import type { MailboxStore, MailMessage } from '../mailbox/types.js'
import type { AgentCluster, ClusterRole } from './cluster-types.js'

export interface InMemoryAgentClusterConfig {
  /** Unique cluster identifier. */
  clusterId: string
  /** Shared workspace instance (opaque — see AgentCluster docs). */
  workspace: unknown
  /** Mailbox store for message persistence. */
  mailbox: MailboxStore
  /** Initial roles to register (optional). */
  roles?: ClusterRole[]
}

export class InMemoryAgentCluster implements AgentCluster {
  readonly clusterId: string
  readonly workspace: unknown
  readonly mailbox: MailboxStore

  private readonly _roles: Map<string, ClusterRole>

  constructor(config: InMemoryAgentClusterConfig) {
    this.clusterId = config.clusterId
    this.workspace = config.workspace
    this.mailbox = config.mailbox
    this._roles = new Map()

    if (config.roles) {
      for (const role of config.roles) {
        this._roles.set(role.roleId, { ...role })
      }
    }
  }

  get roles(): readonly ClusterRole[] {
    return Array.from(this._roles.values())
  }

  addRole(role: ClusterRole): void {
    if (this._roles.has(role.roleId)) {
      throw new Error(`Role "${role.roleId}" already exists in cluster "${this.clusterId}"`)
    }
    this._roles.set(role.roleId, { ...role })
  }

  removeRole(roleId: string): void {
    if (!this._roles.has(roleId)) {
      throw new Error(`Role "${roleId}" not found in cluster "${this.clusterId}"`)
    }
    this._roles.delete(roleId)
  }

  async routeMail(
    from: string,
    to: string,
    partial: Omit<MailMessage, 'id' | 'from' | 'to' | 'createdAt'>,
  ): Promise<MailMessage> {
    const fromRole = this._roles.get(from)
    if (!fromRole) {
      throw new Error(`Sender role "${from}" not found in cluster "${this.clusterId}"`)
    }

    const toRole = this._roles.get(to)
    if (!toRole) {
      throw new Error(`Recipient role "${to}" not found in cluster "${this.clusterId}"`)
    }

    const message: MailMessage = {
      id: randomUUID(),
      from: fromRole.agentId,
      to: toRole.agentId,
      subject: partial.subject,
      body: partial.body,
      createdAt: Date.now(),
      readAt: partial.readAt,
      ttl: partial.ttl,
    }

    await this.mailbox.save(message)
    return message
  }

  async broadcast(
    from: string,
    partial: Omit<MailMessage, 'id' | 'from' | 'to' | 'createdAt'>,
  ): Promise<MailMessage[]> {
    const fromRole = this._roles.get(from)
    if (!fromRole) {
      throw new Error(`Sender role "${from}" not found in cluster "${this.clusterId}"`)
    }

    const targets = Array.from(this._roles.values()).filter(
      (r) => r.roleId !== from,
    )

    const messages: MailMessage[] = []
    for (const target of targets) {
      const message: MailMessage = {
        id: randomUUID(),
        from: fromRole.agentId,
        to: target.agentId,
        subject: partial.subject,
        body: partial.body,
        createdAt: Date.now(),
        readAt: partial.readAt,
        ttl: partial.ttl,
      }
      await this.mailbox.save(message)
      messages.push(message)
    }

    return messages
  }
}
