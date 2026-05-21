/**
 * @dzupagent/agent/cluster — agent cluster roles and in-memory coordination.
 *
 * Re-exports the cluster subsystem for hosts that coordinate multi-agent
 * topologies. Use this subpath when implementing a custom AgentCluster backend
 * or wiring the in-memory cluster into a server.
 */

export * from './cluster/index.js'
