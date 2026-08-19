/**
 * Provider-session schema identities and capability/effect vocabularies.
 *
 * Extracted from `provider-session.ts` (RF-03 pin exit) so the contract
 * declarations and the runtime admission validator can both depend on this
 * vocabulary without importing each other. `provider-session.ts` re-exports
 * everything here, so the `@dzupagent/runtime-contracts/provider-session`
 * surface is unchanged.
 */

export const PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1 =
  "dzupagent.providerSessionCapabilityDescriptor/v1" as const;
export const PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA =
  "dzupagent.providerSessionCapabilityDescriptor/v2" as const;
export const PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA_V1 =
  "dzupagent.providerSessionAttemptBinding/v1" as const;
export const PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA =
  "dzupagent.providerSessionAttemptBinding/v2" as const;
export const PROVIDER_SESSION_REFERENCE_SCHEMA =
  "dzupagent.providerSessionReference/v1" as const;
export const PROVIDER_SESSION_OPERATION_SCHEMA_V1 =
  "dzupagent.providerSessionOperation/v1" as const;
export const PROVIDER_SESSION_OPERATION_SCHEMA =
  "dzupagent.providerSessionOperation/v2" as const;

export const PROVIDER_SESSION_CAPABILITIES_V1 = [
  "execute",
  "stream",
  "resume",
  "cancel",
  "interaction",
  "usage",
  "provider-request-lookup",
  "steer",
  "interrupt-turn",
  "fork-session",
  "start-review",
  "history-read",
  "compact",
] as const;

export const PROVIDER_SESSION_CAPABILITIES = [
  ...PROVIDER_SESSION_CAPABILITIES_V1,
  "goal-control",
] as const;

export type ProviderSessionCapability =
  (typeof PROVIDER_SESSION_CAPABILITIES)[number];

export const PROVIDER_SESSION_RICH_CONTROL_CAPABILITIES = [
  "steer",
  "interrupt-turn",
  "fork-session",
  "start-review",
  "history-read",
  "compact",
  "goal-control",
] as const satisfies readonly ProviderSessionCapability[];

export const PROVIDER_SESSION_EFFECTS_V1 = [
  "execute",
  "resume",
  "cancel",
  "interaction",
  "steer",
  "interrupt-turn",
  "fork-session",
  "start-review",
  "compact",
] as const;

export const PROVIDER_SESSION_EFFECTS = [
  ...PROVIDER_SESSION_EFFECTS_V1,
  "goal-set",
  "goal-clear",
] as const;

export type ProviderSessionEffect = (typeof PROVIDER_SESSION_EFFECTS)[number];
