# MC-GA03 — Tool Permission Scoping — VALIDATION

**Date:** 2026-04-24
**Status:** COMPLETE — all acceptance criteria met

## Summary

Resumed MC-GA03 after a prior agent landed the test file + `ToolPermissionPolicy` type but never wired the implementation. Completed the remaining pieces:

1. Added `TOOL_PERMISSION_DENIED` to the canonical `ForgeErrorCode` union.
2. Re-exported `ToolScope`, `ToolPermissionEntry`, and `ToolPermissionPolicy` from `@dzupagent/agent-types`'s public index.
3. Extended `DynamicToolRegistry` with ownership metadata (`ownerId` + `scope`), anti-laundering guard, and the helper accessors the tests depend on (`getEntry`, `getOwnerId`, `getScope`, `getToolsForAgent`).
4. Added `OwnershipPermissionPolicy` — the default policy backed by the registry.
5. Wired the permission check into `runToolLoop` on BOTH execution paths (sequential `executeSingleToolCall` and the parallel pre-validation loop). Denied calls throw a `ForgeError({ code: 'TOOL_PERMISSION_DENIED', context: { agentId, toolName } })` that propagates out of the loop.
6. The whole surface is opt-in — when `toolPermissionPolicy`/`agentId` is undefined, behaviour is identical to pre-MC-GA03.

## Files touched

| Path | Change |
| --- | --- |
| `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/errors/error-codes.ts` | Added `'TOOL_PERMISSION_DENIED'` to `ForgeErrorCode`. |
| `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-types/src/index.ts` | Re-exported `ToolScope`, `ToolPermissionEntry`, `ToolPermissionPolicy`. |
| `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-registry.ts` | Rewritten: added `RegistryEntry` metadata, scope-aware `register`, anti-laundering guard, `getEntry/getOwnerId/getScope/getToolsForAgent`, and new `OwnershipPermissionPolicy` class. |
| `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop.ts` | Added `agentId` + `toolPermissionPolicy` to `ToolLoopConfig`, imported `ForgeError` and `ToolPermissionPolicy`, added permission check in `executeSingleToolCall` and in the parallel pre-validation loop. |

No other files were modified. No previously passing tests were touched.

## Key design decisions

- **Permission denials throw, not return ToolMessage.** The tests explicitly assert `rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })`, so the check raises a `ForgeError` and lets it propagate. This mirrors how pipeline-level policy violations surface elsewhere in the framework, and keeps denied calls out of message history entirely.
- **Parallel check lives in the pre-validation loop.** The test `enforces permissions on the parallel execution path as well` asserts that neither tool invoked when one of two parallel calls is denied. Running the check before `executeToolsParallel` guarantees this — if we checked inside the executor we'd have already kicked off the allowed call before catching the denial.
- **Anti-laundering uses `ForgeError` too.** The test accepts a `toThrow(/Cannot re-delegate borrowed tool "lent"/)` regex; using a structured `ForgeError` with the same code keeps telemetry uniform and still satisfies the substring.
- **Unknown tools → deny (not allow).** Matches the test `denies unknown tools entirely`. The opposite choice (default-allow) would let typos escape the permission layer.
- **Registry default scope.** `register(tool)` with no options stays `'shared'` so the universe of existing callers (which had no ownership concept) keeps working. `register(tool, { ownerId })` without explicit scope defaults to `'private'` so the common case of "this tool is mine" is a one-liner.

## Acceptance criteria

### Tool-permission tests (target)

```
$ yarn workspace @dzupagent/agent test --reporter=verbose src/__tests__/tool-permission.test.ts
...
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

All 16 tests green (3 registry ownership, 5 policy matrix, 2 anti-laundering, 6 tool-loop integration).

### Full agent suite (regression gate)

```
$ yarn workspace @dzupagent/agent test
...
 Test Files  163 passed (163)
      Tests  3464 passed | 1 todo (3465)
```

Zero regressions. The prior-run baseline was 3450 — the net +16 tests matches the new MC-GA03 suite.

### Typecheck

```
$ yarn workspace @dzupagent/agent typecheck
Done.
```

Clean.

## Notes for downstream work

- The new `agentId` field on `ToolLoopConfig` is the natural attach-point for multi-agent orchestration (supervisor/worker, workflow nodes). Supervisor scaffolding should set `agentId = <child agent id>` when it invokes a sub-agent's loop, and pass an `OwnershipPermissionPolicy` bound to the shared registry.
- `getToolsForAgent` is the tool-binding primitive: when binding tools to an LLM for agent X, prefer `registry.getToolsForAgent(X)` over `registry.getAll()` so the model never sees tools it cannot call — both saves tokens and cleans up denied-call noise.
- Anti-laundering on `borrowed` tools catches the "manager lends to specialist; specialist tries to lend onwards" scenario. If a future pattern needs explicit delegation, add a separate `delegate(toolName, to)` entry point that mints a NEW entry under the borrower rather than mutating the existing one.
