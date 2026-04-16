/**
 * Cluster Workspace types for multi-role agent teams.
 *
 * A cluster groups multiple agent roles that share a single workspace
 * and communicate via intra-cluster mail routing.
 */
import type { MailMessage, MailboxStore } from '../mailbox/types.js'

/** A role within an agent cluster. */
export interface ClusterRole {
  /** Unique role identifier within the cluster (e.g. "planner", "coder", "reviewer"). */
  roleId: string
  /** The agent ID assigned to this role. */
  agentId: string
  /** Optional capability tags describing what this role can do. */
  capabilities?: string[]
}

/**
 * An agent cluster: a group of roles sharing a workspace and mailbox.
 *
 * The `workspace` property is typed as `unknown` here so that `@dzupagent/agent`
 * does not depend on `@dzupagent/codegen` (which owns the `Workspace` interface).
 * Consumers that need the full `Workspace` type can narrow it at the call site.
 */
export interface AgentCluster {
  /** Unique cluster identifier. */
  readonly clusterId: string
  /** Current set of roles. */
  readonly roles: readonly ClusterRole[]
  /** Shared workspace instance (type narrowed by consumers). */
  readonly workspace: unknown
  /** Shared mailbox store for intra-cluster messaging. */
  readonly mailbox: MailboxStore
  /** Add a role to the cluster. Throws if roleId is already taken. */
  addRole(role: ClusterRole): void
  /** Remove a role by roleId. Throws if not found. */
  removeRole(roleId: string): void
  /** Send a mail message from one role to another within the cluster. */
  routeMail(from: string, to: string, message: Omit<MailMessage, 'id' | 'from' | 'to' | 'createdAt'>): Promise<MailMessage>
  /** Broadcast a mail message from one role to all other roles. */
  broadcast(from: string, message: Omit<MailMessage, 'id' | 'from' | 'to' | 'createdAt'>): Promise<MailMessage[]>
}
