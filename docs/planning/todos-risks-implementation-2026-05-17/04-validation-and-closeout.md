# DzupAgent Validation And Closeout Plan

Date: 2026-05-17

## Validation Lanes

### Package-Local Lane

Use for any single-package runtime change.

```bash
yarn workspace <package> typecheck
yarn workspace <package> test
yarn workspace <package> build
yarn workspace <package> lint
```

### Governance Lane

Use when exports, package boundaries, runtime events, terminal tools, or server API surfaces change.

```bash
yarn check:package-tiers
yarn check:domain-boundaries
yarn check:gitleaks-allowlist
yarn check:server-api-surface
yarn check:terminal-tool-event-guards
yarn check:package-export-artifacts
```

### Strict Lane

Use after package-local and governance checks are green.

```bash
yarn verify
# then, for cross-package/public API changes:
yarn verify:strict
```

## Packet-Specific Gates

| Packet | Required Gates |
| --- | --- |
| DZ-P1 | `@dzupagent/memory` test/typecheck/build, `@dzupagent/memory-ipc` test/typecheck/build, domain boundaries |
| DZ-P2 | `@dzupagent/core` MCP tests/typecheck/build, terminal tool event guards, domain boundaries |
| DZ-P3 | `@dzupagent/core` plugin tests/typecheck/build, domain boundaries |
| DZ-P4 | `@dzupagent/core` event tests, `@dzupagent/otel` tests/typecheck/build, package export artifacts |
| DZ-P5 | `@dzupagent/agent` tools tests/typecheck/build, `@dzupagent/core` typecheck |
| DZ-P6 | `@dzupagent/server` tests/typecheck/build, server API surface, package tiers |
| DZ-P8 | `@dzupagent/flow-compiler` tests/typecheck/build, affected agent/runtime-contract tests |
| DZ-P9 | `@dzupagent/agent` auth tests/typecheck/build |
| DZ-P10 | `node scripts/check-gitleaks-allowlist.mjs`, script unit tests, security workflow review |
| DZ-P11 | `@dzupagent/connectors-documents` tests/typecheck/build |

## Latest-Update Gates

The current dirty tree includes a new gitleaks allowlist validator wired into root verification and security CI. Treat that as part of the current plan baseline:

```bash
yarn check:gitleaks-allowlist
node --test scripts/__tests__/check-gitleaks-allowlist.test.mjs
```

If these fail, fix the allowlist governance slice before widening security workflow changes.

## Closeout Checklist

- Implementation packet and affected packages are named.
- Public API changes are documented.
- Package-local validation was run and result recorded.
- Governance validation was run when applicable.
- Known unrelated failures are separated from packet failures.
- Existing dirty files not owned by the packet were not modified.
- Follow-up TODOs are converted into tracked docs or issues, not left as vague code comments.

## Failure Handling

- If Turbo or downstream typecheck reports stale declarations, rebuild the upstream package before editing unrelated downstream code.
- If `verify:strict` fails after focused checks pass, classify failures by package and determine whether they are current-slice regressions or pre-existing broad-lane drift.
- Do not weaken boundary/package-tier checks to land a packet. Update policy only when the public contract is intentional and documented.
