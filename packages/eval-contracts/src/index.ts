/**
 * @dzupagent/eval-contracts
 *
 * Neutral, runtime-free type contracts shared between @dzupagent/evals
 * (Layer 5) and @dzupagent/server (Layer 4). Created in MC-A02 to resolve the
 * server -> evals layer inversion: orchestrators now live in evals and the
 * server imports only the injection-friendly interfaces from this package.
 */

export * from './eval-types.js'
export * from './benchmark-types.js'
export * from './store-contracts.js'
export * from './orchestrator-contracts.js'
