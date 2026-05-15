# Policy Context Legacy Option Migration

This note tracks deprecation of legacy policy transport keys on `AgentInput.options`:

- `__activePolicy`
- `__policyConformanceMode`

## Current State (May 15, 2026)

- Typed policy transport is first-class via `AgentInput.policyContext`.
- Legacy option keys are still read for backward compatibility.
- When a legacy key is consumed, runtime emits `adapter:progress` with phase `policy:legacy_option_deprecated` and details identifying the key.
- Runtime also emits a first-class governance event `policy:legacy_option_deprecated` for audit/telemetry pipelines.

## Typed-First Precedence

When both transports are present:

- `policyContext` wins.
- Legacy option keys are ignored and are not considered "consumed".

## Planned Cutover Timeline

- **2026-05-15**: Deprecation telemetry enabled; compatibility read-path retained.
- **2026-06-15**: Raise migration visibility in release notes and package docs.
- **2026-08-01**: Remove compatibility reads for legacy keys in `AdapterRegistryRouter` and keep only typed `policyContext`.

## Migration Guidance

Move any callers still writing legacy keys to typed policy context:

```ts
input.policyContext = {
  activePolicy: { sandboxMode: 'workspace-write' },
  conformanceMode: 'strict',
}
```

## Strict Migration Rehearsal Flag

Set `DZUP_STRICT_POLICY_CONTEXT=1` to fail runs that still consume legacy option keys.
This is intended for migration rehearsal before hard removal.
