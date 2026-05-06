# Full-Spectrum Audit: dzupagent

**Date:** 2026-05-05
**Run:** run-001
**Scope:** Whole monorepo `dzupagent/packages/*` (32 packages, ~2,670 TS files, ~256k LOC)
**Domains analysed:** code, security, architecture, agent
**Depth:** deep

---

## Risk Matrix

| Domain | Critical | High | Medium | Low | Total |
|--------|---------:|-----:|-------:|----:|------:|
| Code Quality | 0 | 7 | 14 | 6 | **27** |
| Security | 2 | 6 | 9 | 5 | **22** |
| Architecture | 0 | 0 | 14 | 6 | **20** (P1=2, P2=12, P3=6) |
| Agent Patterns | 0 | 7 | 20 | 8 | **35** |
| **TOTAL** | **2** | **20** | **57** | **25** | **104** |

Of the architecture findings, ARCH-01 and ARCH-05 are P1 (treated as High in the cross-domain matrix).

---

## Top 10 Priority Actions

1. [Critical / Security]   **SEC-01** Approval bypass — `routes/approvals.ts:36-78` has no ownership/tenant check. ~30 min fix.
2. [Critical / Security]   **SEC-02** Cross-tenant learning data — `routes/learning.ts:120` reads unset `tenantId`; everyone falls into `defaultTenantId`. ~45 min fix.
3. [High / Security]       **SEC-03** Scraper SSRF — no private-IP / metadata-IP guard in `scraper/http-fetcher.ts`. AWS metadata exfil risk.
4. [High / Architecture]   **ARCH-01** Phantom dep — `server` imports `@dzupagent/memory` but doesn't declare it. Breaks isolated install.
5. [High / Architecture]   **ARCH-05** Two PII detectors — `core/security/pii-detector.ts` vs `security/src/pii/detector.ts` drift silently.
6. [High / Code]           **CODE-01** Stale `as never` Hono casts × 33 — `AppEnv` already exists; just unadopted in 6 files.
7. [High / Security]       **SEC-04** Express adapter has no Zod, no body cap, no rate limit, leaks raw error.message.
8. [High / Security]       **SEC-05** 19+ Hono routes use type-cast instead of Zod. Untrusted text reaches LLM verbatim.
9. [High / Agent]          **AGENT-101** `ComplianceAuditLogger` exists but **no producer wires it at the LLM-call boundary** — compliance gap.
10. [High / Security]      **SEC-07** `LocalWorkspace.runCommand` allow-list bypassed when undefined → arbitrary exec inside sandbox.

---

## Baseline Metrics

| Metric | Value |
|--------|------:|
| Source TS files (under `packages/*/src/**`) | ~1,356 |
| Test files (`*.test.ts` / `*.spec.ts`) | 7,633 |
| Total TS files (incl. tests / dist) | 17,675 |
| Packages | 32 |
| dzupagent typecheck failures (in-tree) | **0** ✅ |
| Consumer (codev-app, etc.) typecheck failures referencing dzupagent | several — see logs/baseline.log |
| `as never` casts in non-test sources | 38 (33 in `server/`) |
| Functions ≥ 80 LOC (sampled hot files) | 13 |
| Files with no matching `.test.ts` (critical packages) | 479/852 (56%) |

Notable consumer-facing API drift discovered in the typecheck sweep:
- `@dzupagent/flow-compiler` ships `.js` but no `.d.ts` in `dist/` → consumers see implicit-any module.
- `@dzupagent/memory` `ConsolidationResult` shape changed (added `summarized/summaries/provenance/durationMs`; removed `pruned/merged`) without a semver bump.
- `@dzupagent/core` `DzupEventBus` is no longer assignable to `DzupEventBusAdapter` from a consumer's perspective.

These are tracked as cross-domain `CONSUMER-IMPACT` findings (see CROSS-DOMAIN-MATRIX).

---

## Implementation Estimate

| Phase | Tasks | Total Effort |
|-------|------:|-------------:|
| Quick Fixes (P1 / <2h each) | 19 | ~35 hours |
| Refactors (P2 / 4–8h each) | 49 | ~280 hours |
| Major Changes (P3 / 16h+) | 18 | ~360 hours |
| **TOTAL** | **86** actionable items (excluding 18 documentation-only) | ~675 hours (~17 dev-weeks) |

(Some IDs serve as documentation/policy findings without an actionable code task; they are not double-counted in the totals.)

---

## What Already Landed (verified in this audit)

Three prior sprints landed during the same week and the 2026-05-05 audits did NOT reflect the latest tree:

- **MC sprint** — security pkg (95 tests), MemoryClient interface, durable approvals, OrchestratorFacade split (now 468 LOC, was 750+), subpath exports, base contracts.
- **Phase 1+2 security sprint** — H-01 workspace-write→default permission mode; C-01 prompt caching with `cacheReadTokens`+`cacheWriteTokens` end-to-end; REC-002 git-arg injection mitigated via `execFile`; REC-003 bootstrap risk-tier fix.
- **Sprint B Quick-Fixes** — `as never` source-count is now **0** in `agent/` and `agent-adapters/` source (only present in tests as fixtures); all 15 RF tasks closed.

The findings below are **net-new** vs those sprints (or were out-of-scope of those audits which were narrowed to `agent` + `agent-adapters`).

---

## Memory-vs-truth corrections

- **OrchestratorFacade** — memory says **279 LOC**; current file is **468 LOC**. Either the split regressed or memory is stale (ARCH-09).
- **Sprint B "0 TS errors"** — confirmed for dzupagent in-tree packages. Outside packages (consumer apps) DO have TS errors related to dzupagent's emitted `.d.ts` and public-API drift.

---

## Files

```
docs/
  CODE-AUDIT.md            27 findings (CODE-01..31)
  SECURITY-AUDIT.md        22 findings (SEC-01..22)
  ARCHITECTURE-AUDIT.md    20 findings (ARCH-01..20)
  AGENT-AUDIT.md           35 findings (AGENT-101..135)
  CROSS-DOMAIN-MATRIX.md   merged matrix of all 104 findings
  RECOMMENDATIONS.md       prioritised, deduped recommendations
prompts/
  quick-fixes.md           P1 tasks (1–2h each)
  refactors.md             P2 tasks (4–8h each)
  major-changes.md         P3 tasks (16h+ each)
logs/
  baseline.log             metrics + consumer typecheck snapshot
```

Run `/analyze-implement audit/full-dzupagent-2026-05-05/run-001/` to execute the remediation matrix.
