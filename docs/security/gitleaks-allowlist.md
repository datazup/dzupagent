# Gitleaks Allowlist Governance

This document describes the governance rules for the gitleaks allowlist used by
the DzupAgent repository, the validator that enforces them, and how the
controls are wired into CI and the local `verify` lanes.

## Why an allowlist exists

Gitleaks scans every commit on every push and pull request via
`.github/workflows/security.yml`. The framework intentionally checks in a set of
test fixtures, audit manifests, and detector spec files that contain
secret-shaped strings (placeholder API keys, tokenized example payloads,
generated audit manifests). These strings are not real secrets, but their
shape would otherwise trip the scanner.

The allowlist in `.gitleaks.toml` carries an explicit list of file paths that
are exempt from scanning. Each entry is a single path-anchored regex, paired
with a written description of why the exemption exists.

## File: `.gitleaks.toml`

The allowlist lives in the repository root. Every exemption sits inside a
single `[[allowlists]]` table:

```toml
[[allowlists]]
description = "Intentional secret-shaped fixtures used by security scanner tests and generated audit manifests"
paths = [
  '''^docs/analyze-full_2026_04_21/analysis-pack\.manifest\.json$''',
  '''^packages/codegen/src/__tests__/guardrail-rules\.test\.ts$''',
  # ...
]
```

## Governance rules

The validator script `scripts/check-gitleaks-allowlist.mjs` enforces the
following rules on every `paths = [...]` entry inside every `[[allowlists]]`
block:

1. **Anchored regex** — every entry must start with `^` and end with `$`.
   Unanchored entries can accidentally match unrelated files (for example a
   plain `secrets-scanner` would also match `node_modules/.../secrets-scanner-shim`).
2. **Valid regex** — every entry must compile as a JavaScript `RegExp`. This
   catches typos such as unclosed character classes.
3. **Triple-quoted string literal** — paths must use TOML `'''…'''` literals
   so backslashes and special characters do not need TOML escaping. The
   validator only extracts triple-quoted entries; single-quoted entries are
   ignored and therefore must not be used.

The validator does not enforce a description, but reviewers should require one
for any new allowlist block.

## When to add an entry

Add a new allowlist entry only when **all** of the following are true:

- The file is a test fixture, audit artifact, or example payload.
- The "secret" inside it is a placeholder, not a real credential. Real
  credentials must be revoked and removed from history before any action is
  taken.
- A maintainer has reviewed the rationale and the reviewer confirms the
  description on the `[[allowlists]]` block reflects the new entry.

Entries are reviewed during pull request review and at the security audit
cadence in `docs/SECURITY-AUDIT.md`.

## When to remove an entry

Remove an allowlist entry as soon as the underlying file no longer needs the
exemption. Common triggers:

- The fixture moved or was deleted.
- The fixture was rewritten to use a clearly synthetic placeholder shape that
  gitleaks no longer flags.
- A security audit reclassifies the entry as unnecessary.

The validator does not delete stale entries automatically — that responsibility
falls to the reviewer.

## CI and local verification

The validator runs in three places:

1. **Security CI workflow** — `.github/workflows/security.yml` runs
   `node scripts/check-gitleaks-allowlist.mjs` before invoking gitleaks. If the
   allowlist fails the rules above, the workflow exits non-zero before any
   scan starts.
2. **`yarn verify` and the strict variants** — `package.json` chains
   `yarn check:gitleaks-allowlist` into:
   - `verify`
   - `verify:strict`
   - `verify:strict:no-circular`
   - `verify:strict:ci:no-circular`
3. **Direct command** — `yarn check:gitleaks-allowlist` runs the validator
   against `.gitleaks.toml`. Use this when iterating on the allowlist locally.

If the validator emits issues it prints a report to `stderr` listing each
offending pattern and the failed rule, then exits with code `1`. The CI lane
fails fast so the gitleaks scan is never run against a misconfigured allowlist.

## Validator tests

Validator behavior is covered by
`scripts/__tests__/check-gitleaks-allowlist.test.mjs`. The test suite runs
under Node's built-in `node --test` runner:

```bash
node --test scripts/__tests__/check-gitleaks-allowlist.test.mjs
```

The suite verifies:

- triple-quoted pattern extraction from `[[allowlists]]` blocks
- character-class brackets are kept intact
- anchored valid regexes pass
- unanchored regexes are rejected with the expected message
- invalid regexes are rejected with an "invalid regex" message
- `renderReport` formats failures clearly
- `runCheck` reads a config file from disk and surfaces issues

Tests use placeholder fixtures only — no real secrets — and write to a
temporary directory when exercising filesystem code paths.

## Telemetry

The validator reports two governance signals:

- `gitleaks_allowlist_validation_status` — the exit status of
  `check-gitleaks-allowlist.mjs` (success or failure).
- `gitleaks_allowlist_rejected_rule_count` — the number of allowlist entries
  rejected by the validator. This is the length of `result.issues` in the
  validator's return value.

Both signals are emitted implicitly through the script's exit code and the
report rendered by `renderReport`. CI captures these via the workflow log; no
additional telemetry sink is wired today.

## Related documents

- `docs/SECURITY-AUDIT.md` — the security audit referencing gitleaks coverage
- `.github/workflows/security.yml` — security CI workflow
- `.gitleaks.toml` — the configuration file under governance
- `scripts/check-gitleaks-allowlist.mjs` — the validator
- `scripts/__tests__/check-gitleaks-allowlist.test.mjs` — validator tests
