import type {
  SubagentAuditIdentity,
  SubagentSpec,
} from "../../contracts/background-task.js";

/**
 * Derive the persona/inline audit identity for a spec from its resolved
 * definition (preferred) or raw definition. Returns `undefined` when no
 * persona name is available so callers can omit the `audit` field entirely.
 */
export function defaultAuditForSpec(
  spec: SubagentSpec
): SubagentAuditIdentity | undefined {
  const definition = spec.resolvedDefinition ?? spec.definition;
  const personaName = spec.resolvedPersonaName ?? definition?.name;
  if (personaName === undefined) return undefined;
  return { personaName };
}
