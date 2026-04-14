/**
 * @dzupagent/core/stable — Curated facade-first API tier.
 *
 * This entrypoint keeps the public surface intentionally narrow by exposing
 * the namespace facades only. Consumers can opt into the higher-level, more
 * opinionated APIs without pulling in the broader internal surface.
 */

export * from './facades/index.js'
