## Summary

- Add a package export artifact guard that checks package `types` fields and export targets resolve to built runtime/declaration files.
- Wire the guard into `verify`, `verify:strict`, and `verify:strict:no-circular` so broad gates fail explicitly on missing export artifacts.
- Refresh the MC split readiness checkpoint with the current strict validation result and follow-on review status.

## Affected Areas

- `package.json`
- `scripts/check-package-export-artifacts.mjs`
- `scripts/__tests__/check-package-export-artifacts.test.mjs`
- `docs/improvements/MC_SPLIT_PR_READINESS_2026-05-08.md`

## Validation

- `node --test scripts/__tests__/check-package-export-artifacts.test.mjs`: passed.
- `yarn -s check:package-export-artifacts`: passed, 32 packages.
- `yarn -s verify:strict:no-circular`: passed after the export-artifact guard was wired into the command.
- Broad strict lane summary: 128 of 128 Turbo tasks successful.
- Server tests in broad lane: 195 files passed, 3,221 tests passed.
- `git diff --check origin/main..HEAD`: passed.

## Plan Re-Evaluation

Implementation drift is low. The remaining DzupAgent work should stay in PR review, CI confirmation, and targeted guard/doc/test lanes unless CI finds a concrete regression. Do not start another broad MC split wave until this PR package is reviewed.

## Follow-Up

- Let CI confirm the sharded strict workflow and the new export-artifact guard.
- Review the separate dirty `apps/codev-app` worktree before any cross-repo action.
