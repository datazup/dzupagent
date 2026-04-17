# Wave 20 — Implementation Tracking

> **Start date**: 2026-04-17  
> **Target**: ≥200 new tests, close 5 gaps  
> **Theme**: Security Sidecar Hardening + System Reminder + Git Worktree + Import Validator + Context Token Lifecycle

---

## Gap Assessment (pre-wave)

| Gap | Prior state | Wave 20 action |
|-----|------------|----------------|
| G-31 Security sidecar | `secrets-scanner.ts` (153 LOC, ~19 tests) + `pii-detector.ts` (97 LOC, ~20 tests) — thin coverage | Deep expand: 60+ tests |
| G-23 System reminder injector | `system-reminder.ts` (95 LOC, 12 tests) in `@dzupagent/context` — shallow | Deep expand: 45+ tests |
| G-06 Git worktree manager | `git-worktree.ts` (135 LOC, 12 tests) in `@dzupagent/codegen` — shallow | Deep expand: 40+ tests |
| G-34 Import validator | `import-validator.ts` (109 LOC, 10 tests) in `@dzupagent/codegen` — very shallow | Deep expand: 35+ tests |
| CF-0007 Context token lifecycle | Does not exist in `@dzupagent/context` | Implement + 40+ tests |

---

## Task Summary

| ID | Task | Package | Gap | Target Tests | Agent | Status |
|----|------|---------|-----|-------------|-------|--------|
| W20-A1 | Security sidecar: secrets-scanner + pii-detector deep coverage | `core` | G-31 | +60 | dzupagent-core-dev | DONE |
| W20-A2 | System reminder injector deep coverage | `context` | G-23 | +45 | dzupagent-core-dev | DONE |
| W20-B1 | Context token lifecycle — implement + tests | `context` | CF-0007 | +40 | dzupagent-core-dev | DONE |
| W20-B2 | Git worktree manager deep coverage | `codegen` | G-06 | +40 | dzupagent-codegen-dev | pending |
| W20-B3 | Import validator deep coverage | `codegen` | G-34 | +35 | dzupagent-codegen-dev | pending |

---

## Detailed Task Specs

### W20-A1: Security Sidecar Deep Coverage (G-31)

**Goal**: `secrets-scanner.ts` (153 LOC) has ~19 tests and `pii-detector.ts` (97 LOC) has ~20 tests.
Both need much deeper coverage. Add 60+ total new tests.

**Files to read first**:
- `packages/core/src/security/secrets-scanner.ts`
- `packages/core/src/security/pii-detector.ts`
- `packages/core/src/__tests__/secrets-scanner.test.ts` (gap analysis)
- `packages/core/src/__tests__/pii-detector.test.ts` (gap analysis)
- `packages/core/src/__tests__/security-pii-detector.test.ts` (gap analysis)

**Deliverables**:

1. `packages/core/src/__tests__/secrets-scanner-deep.test.ts` — 35+ tests:
   - AWS access key detection (AKIA prefix — high confidence)
   - AWS secret key detection (40-char base64 — 0.4 confidence)
   - GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ all detected
   - GitLab tokens: glpat- prefix detected
   - Slack tokens: xoxb, xoxp, xapp detected
   - Generic api_key, password, secret, token in assignments
   - Connection strings: postgres://, mysql://, mongodb://
   - Shannon entropy detection: high-entropy strings flagged
   - Redaction: matching segments replaced with [REDACTED:type]
   - Multi-line content: each secret on different line found
   - No false positive: regular word strings not flagged
   - `hasSecrets`: false when no matches
   - `matches` array: each has type, value, confidence, line fields
   - Confidence ordering: matches with confidence < threshold excluded
   - Multiple secrets in same text: all found
   - JSON content with embedded secrets: detected
   - Empty string: returns { hasSecrets: false, matches: [], redacted: '' }

2. `packages/core/src/__tests__/pii-detector-deep.test.ts` — 25+ tests:
   - Email detection: standard, subdomain, plus-addressing
   - Email false positives: version strings like "1.2@foo" NOT matched
   - Phone: US formats (555-1234, (555) 123-4567, +1-555-123-4567)
   - SSN: 123-45-6789 format detected
   - Credit card: 16-digit Visa/MC/Amex patterns
   - IP address: IPv4 only (not partial matches in URLs like /192.168.1.1/)
   - Redaction: [REDACTED:email], [REDACTED:phone], etc.
   - `hasPII`: false when nothing found
   - `matches` array: each has type, value, start, end positions
   - Multiple PII types in same text: all found independently
   - Empty string: returns { hasPII: false, matches: [], redacted: '' }
   - Long text with embedded PII: positions correct

**Acceptance criteria**:
- 60+ new tests
- All existing security tests still pass

---

### W20-A2: System Reminder Injector Deep Coverage (G-23)

**Goal**: `system-reminder.ts` (95 LOC) in `@dzupagent/context` has only 12 tests.
Add 45+ tests covering all branches and edge cases.

**Files to read first**:
- `packages/context/src/system-reminder.ts`
- `packages/context/src/__tests__/system-reminder.test.ts` (gap analysis)

**Deliverables**:

1. `packages/context/src/__tests__/system-reminder-deep.test.ts` — 45+ tests:
   - `getReminders()`: returns null below intervalMessages threshold
   - `getReminders()`: returns reminder block at exact interval
   - `getReminders()`: returns reminder block at multiple of interval
   - Default intervalMessages=15: triggers at 15, 30, 45
   - Custom intervalMessages=5: triggers at 5, 10, 15
   - Empty reminders array: returns null even at interval
   - Condition=true: reminder included
   - Condition=false: reminder excluded
   - Condition function receives agent state object
   - Multiple reminders: all included when condition=true
   - Mixed conditions: only passing reminders included
   - Custom tagName: output wrapped in custom XML tag
   - Default tagName='system-reminder': output wrapped correctly
   - Reminder content is HTML/XML escaped if needed (or not — check implementation)
   - `reset()` if it exists: clears counter
   - Large message count: triggers at 100, 200, etc.
   - State changes between calls: condition re-evaluated each time
   - Single reminder, no condition: always injected at interval
   - `getMessageInsert()` or equivalent API (read actual implementation)

**Acceptance criteria**:
- 45+ new tests
- All existing context tests still pass

---

### W20-B1: Context Token Lifecycle — Implement + Tests (CF-0007)

**Goal**: Context token lifecycle management does not exist as a dedicated module.
It should track token budget consumption per conversation phase, warn approaching limits,
and provide compression/eviction recommendations.

**Current state**: Does not exist. Related: `packages/context/src/prompt-cache.ts`,
`packages/context/src/context-eviction.ts`, `packages/context/src/progressive-compress.ts`
(read these before implementing to understand what already exists).

**Deliverables**:

1. `packages/context/src/token-lifecycle.ts`:
   ```ts
   export interface TokenBudget {
     total: number       // model context limit (e.g., 200_000)
     reserved: number    // tokens reserved for output (e.g., 4_096)
     available: number   // total - reserved
   }

   export interface TokenPhaseUsage {
     phase: string
     tokens: number
     timestamp: number
   }

   export interface TokenLifecycleConfig {
     budget: TokenBudget
     warnThresholdPct?: number  // warn when used% >= this (default: 0.8)
     criticalThresholdPct?: number // critical when used% >= this (default: 0.95)
   }

   export type TokenLifecycleStatus = 'ok' | 'warn' | 'critical' | 'exhausted'

   export interface TokenLifecycleReport {
     used: number
     available: number
     pct: number
     status: TokenLifecycleStatus
     phases: TokenPhaseUsage[]
     recommendation?: string
   }

   export class TokenLifecycleManager {
     constructor(config: TokenLifecycleConfig)
     track(phase: string, tokens: number): void
     get report(): TokenLifecycleReport
     get status(): TokenLifecycleStatus
     get usedTokens(): number
     get remainingTokens(): number
     reset(): void
   }
   ```

2. Export from `packages/context/src/index.ts`

3. `packages/context/src/__tests__/token-lifecycle.test.ts` — 40+ tests:
   - Constructor with custom budget
   - `track()`: accumulates tokens per phase
   - `usedTokens`: sum of all tracked tokens
   - `remainingTokens`: available - usedTokens
   - `status`: 'ok' below warn threshold
   - `status`: 'warn' at/above warnThresholdPct
   - `status`: 'critical' at/above criticalThresholdPct
   - `status`: 'exhausted' when usedTokens >= available
   - Default thresholds: warn=0.8, critical=0.95
   - Custom thresholds respected
   - `report.pct`: correct percentage (0-1 range)
   - `report.phases`: all tracked phases with tokens+timestamp
   - `report.recommendation`: present when status=warn or critical
   - Multiple calls to track() same phase: both recorded
   - `reset()`: clears all tracked usage
   - Zero budget edge case: immediately exhausted
   - Large inputs: no integer overflow

**Acceptance criteria**:
- `TokenLifecycleManager` exported from `@dzupagent/context`
- 40+ tests passing
- No existing context tests broken

---

### W20-B2: Git Worktree Manager Deep Coverage (G-06)

**Goal**: `git-worktree.ts` (135 LOC) in `@dzupagent/codegen` has only 12 tests.
Add 40+ tests covering all branches and edge cases.

**Files to read first**:
- `packages/codegen/src/git/git-worktree.ts`
- `packages/codegen/src/__tests__/git-worktree.test.ts` (gap analysis — identify gaps)

**Deliverables**:

1. `packages/codegen/src/__tests__/git-worktree-deep.test.ts` — 40+ tests:
   - Read the implementation to identify all testable branches
   - Worktree creation: success path
   - Worktree creation: git command failure (non-zero exit code)
   - Worktree list: parses output correctly
   - Worktree remove: success path
   - Worktree remove: non-existent worktree error handling
   - Path sanitization: no shell injection via worktree names
   - Concurrent worktree creation: multiple worktrees created independently
   - Cleanup: worktree removed after use
   - Branch name: auto-generated or custom
   - Base branch: defaults to HEAD, custom override
   - Git executor mock: verify correct git commands are issued
   - Error messages: descriptive on failure
   - Any additional API surface exposed by the implementation

**Acceptance criteria**:
- 40+ new tests
- No existing codegen tests broken

---

### W20-B3: Import Validator Deep Coverage (G-34)

**Goal**: `import-validator.ts` (109 LOC) in `@dzupagent/codegen` has only 10 tests.
Add 35+ tests covering resolution, circular deps, and boundary violations.

**Files to read first**:
- `packages/codegen/src/validation/import-validator.ts`
- `packages/codegen/src/__tests__/import-validator.test.ts` (gap analysis)
- `packages/codegen/src/quality/import-validator.ts` if different (check both paths)

**Deliverables**:

1. `packages/codegen/src/__tests__/import-validator-deep.test.ts` — 35+ tests:
   - Read implementation to understand what validateImports() checks
   - Valid imports: all resolved → valid=true, errors=[]
   - Missing import: unresolved module → valid=false, error message identifies missing module
   - Circular dependency: A imports B imports A → detected and reported
   - Deep circular: A→B→C→A → detected
   - Self-import: file imports itself → detected
   - Relative import resolution: ./foo, ../bar, ./dir/file
   - Extension handling: .js, .ts, implicit extensions
   - Index file resolution: ./dir → ./dir/index.ts
   - Multiple files: validates all files in VFS
   - Boundary violation: if the validator checks domain boundaries, test those
   - Empty VFS: no errors
   - Single file no imports: no errors
   - External (node_modules) imports: NOT flagged as unresolved (pass through)
   - Error format: each error identifies file + import path + reason

**Acceptance criteria**:
- 35+ new tests
- All existing codegen tests still pass

---

## Progress

| ID | Status | Tests Added | Notes |
|----|--------|-------------|-------|
| W20-A1 | DONE | +95 | `secrets-scanner-deep.test.ts` (57 tests): all AWS/GitHub/GitLab/Slack prefixes, generic assignment patterns, connection strings, JWT, bearer, private keys, entropy, redaction round-trip, line numbers, confidence ranges, result contract. `pii-detector-deep.test.ts` (38 tests): email variants, phone formats, SSN, credit cards, IPv4 validation, position slicing, multi-PII, PIIType union, result contract. All 95 green; original 65 security tests remain green. Target 60+ exceeded. |
| W20-A2 | DONE | +47 | `system-reminder-deep.test.ts`: exhaustive interval gating (counts 1, 5, 14, 15, 16, 30, 45, 75), custom intervals (1/5/100), empty reminders, conditional reminders (state propagation, fresh re-evaluation, toggling), multi-reminder order preservation, default + custom tag names, reset + forceReminder + construction defaults. All 47 green; original 10 existing tests remain green. Target 45+ exceeded. |
| W20-B1 | DONE | +59 | Implemented `token-lifecycle.ts` + `TokenLifecycleManager` class + `createTokenBudget()` factory; exported from `context/src/index.ts`. Tests cover: budget factory edge cases, construction defaults, track() accumulation + phase snapshotting, status thresholds (default 0.8/0.95 + custom), report shape (used/available/pct/status/phases/recommendation), recommendation strings per status, reset(), zero-budget/over-budget/reserved>=total edges, immutable phases snapshot, type contracts. 59 tests, all green. Target 40+ exceeded. |
| W20-B2 | DONE | +58 | `git-worktree-deep.test.ts`: constructor defaults/overrides, `create()` (args, concurrency, errors, branch names with slashes), `remove()` (force flag, branch deletion, suppressed errors), `list()` (porcelain parsing — empty/single/multiple/detached/missing-HEAD/unknown-keys), `merge()` (branch save/restore, CONFLICT in stdout or stderr, string vs Error rejection, --no-edit), exec plumbing (cwd/timeout/maxBuffer). 58 tests, all green. Target 40+ exceeded. |
| W20-B3 | DONE | +84 | `import-validator-deep.test.ts`: covers BOTH `validation/import-validator.ts` (VFS-based) and `quality/import-validator.ts` (Map-based with circular detection). VFS: extension resolution (.ts/.tsx/.js/.jsx/.vue), dir index, .js→.ts ESM mapping, path traversal, external/bare/@scope/node:, import syntax variants (default/namespace/named/re-export/dynamic), error shape, file-type filtering. Map: baseline API shape, unresolved+line numbers, self-import (3 variants), circular 2/3/4-cycle + disjoint cycles, DAG no false positive, issue shape, rootDir fallback. 84 tests, all green. Target 35+ exceeded. |
| **Total** | — | **343 / ≥200** | W20-A1 95 + W20-A2 47 + W20-B1 59 + W20-B2 58 + W20-B3 84 = 343 new tests across core, context, codegen |

---

## Wave 21 Candidates (preview)

- `@dzupagent/server` — Hono REST API + Drizzle run store (P3 from roadmap)
- `CF-0022` Multi-agent orchestration hardening (researchScore 193, partial impl)
- `CF-0023` Knowledge Agents / corpus lifecycle (missing, high evidence)
- `CF-0009` Context management stabilization
- `@dzupagent/otel` — OpenTelemetry tracing deep coverage
