/**
 * Team coordination patterns — strategy registry for `TeamRuntime`.
 *
 * Each entry is a focused module that owns one pattern's scheduling +
 * merge logic. The runtime looks up the pattern by `coordinatorPattern`
 * and delegates `execute` / `resume` to it.
 */

import type { CoordinatorPattern } from '../team-definition.js'
import type { TeamPattern } from './team-pattern.js'
import { supervisorPattern } from './supervisor-pattern.js'
import { contractNetPattern } from './contract-net-pattern.js'
import { blackboardPattern } from './blackboard-pattern.js'
import { peerToPeerPattern } from './peer-to-peer-pattern.js'
import { councilPattern } from './council-pattern.js'

export type {
  TeamPattern,
  TeamPatternContext,
  TeamPatternResult,
  TeamPatternHooks,
  ResolvedParticipant,
} from './team-pattern.js'

export { supervisorPattern } from './supervisor-pattern.js'
export { contractNetPattern } from './contract-net-pattern.js'
export { blackboardPattern } from './blackboard-pattern.js'
export { peerToPeerPattern } from './peer-to-peer-pattern.js'
export { councilPattern, DEFAULT_GOVERNANCE_MODEL } from './council-pattern.js'

/**
 * Lookup table from `CoordinatorPattern` → strategy. Exhaustive over the
 * union; the runtime treats this as immutable.
 */
export const TEAM_PATTERN_REGISTRY: Record<CoordinatorPattern, TeamPattern> = {
  supervisor: supervisorPattern,
  contract_net: contractNetPattern,
  blackboard: blackboardPattern,
  peer_to_peer: peerToPeerPattern,
  council: councilPattern,
}
