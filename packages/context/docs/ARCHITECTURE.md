# @dzupagent/context Architecture

## Purpose
`@dzupagent/context` manages prompt window pressure and context quality. It provides compression, eviction, reminder injection, phase-aware retention, and transfer logic that keeps model context useful under token constraints.

## Main Responsibilities
- Detect when message history should be summarized/compressed.
- Prune low-value tool traces while preserving conversational integrity.
- Apply context eviction strategies for oversized content.
- Inject periodic system reminders to keep long sessions aligned.
- Support phase-aware and progressive compression strategies.
- Optimize Anthropic prompt caching breakpoints.

## Module Structure
Top-level modules under `src/`:
- `message-manager.ts`: summarize/prune/repair/orchestration helpers.
- `auto-compress.ts`: single-call compression pipeline.
- `progressive-compress.ts`: compression levels and budget-targeting.
- `phase-window.ts`: phase-aware context retention manager.
- `context-eviction.ts`: large block head/tail eviction.
- `system-reminder.ts`: reminder scheduler/injector.
- `prompt-cache.ts`: cache breakpoint annotations.
- `context-transfer.ts`: intent-aware transfer between sessions.
- `completeness-scorer.ts`, `extraction-bridge.ts`.

## How It Works (Compression Flow)
1. Message list is evaluated with thresholds (`shouldSummarize`).
2. Tool outputs are pruned and orphaned tool-call/result pairs repaired.
3. Summary model compresses historical messages while preserving recent turns.
4. Optional progressive compression reduces fidelity to hit strict budgets.
5. Result is returned as trimmed messages + summary metadata.

## Main Features
- Multi-stage context reduction pipeline.
- Phase-aware retention for different conversation stages.
- System reminder injection on configurable intervals.
- Intent-based context transfer for new threads/runs.
- Prompt-cache controls for cost/performance optimization.

## Integration Boundaries
- Used by `@dzupagent/agent` during message preparation.
- Reused by `@dzupagent/core` via exports/integration points.
- Depends on LangChain message abstractions.

## Extensibility Points
- Customize compression levels and phase weighting.
- Add domain-specific reminder policies.
- Extend transfer relevance rules for vertical-specific intents.

## Quality and Test Posture
- Test coverage focuses on transfer logic, phase windows, progressive compression, and reminder behavior.
