# DzipAgent Self-Improvement & Self-Correction Architecture

> **Generated:** 2026-03-26 | **Scope:** @dzipagent/* packages | **Method:** Research synthesis + codebase audit + brainstorm
> **Source research:** `docs/self_correction_agent.md` — comparative analysis of Deepsense.ai, STeCa, Ralph Pattern, smolagents, and LangGraph reflection patterns

---

## Executive Summary

DzipAgent already implements a **rich set of self-correction primitives** — far more than initially apparent. The deep audit reveals: stuck detection with 3-stage escalation wired into the tool loop, iteration budgets with parent/child sharing, a full recovery copilot (failure analysis → strategy ranking → execution → approval gates), run reflectors with heuristic + LLM scoring, memory consolidation/healing/dedup, convention extraction + conformance checking, skill learning with optimization thresholds, adaptive retrieval with feedback loops, code quality scoring, code review, safety monitoring, multi-agent debate, CI failure fix loops, tool argument validation with auto-repair, and trace capture with replay.

The feature generation pipeline itself has a **3-tier adaptive fix escalation** (targeted → contextual → regenerative with model upgrade to Opus), multi-gate validation, risk-gated generation strategies, and memory-augmented prompts.

**The core gap is not missing primitives but missing integration**: these components don't form a unified closed loop. The recovery copilot doesn't feed lessons back to memory, the convention extractor doesn't auto-inject into generation prompts, the quality scorer from evals is a placeholder, and there's no trajectory-level quality tracking across pipeline steps. This document maps every research concept to DzipAgent and blueprints the integration layer needed to close the loop.

This document maps every applicable self-improvement concept from the research to DzipAgent's TypeScript/LangGraph architecture, identifies what exists vs. what's missing, and provides detailed implementation blueprints for building a **closed-loop self-improving agent framework**.

---

## Table of Contents

1. [Current State Audit](#1-current-state-audit)
2. [The Five Self-Improvement Mechanisms](#2-the-five-self-improvement-mechanisms)
3. [Self-Correction Strategy Taxonomy Applied to DzipAgent](#3-self-correction-strategy-taxonomy)
4. [Concept 1: Reflection Pattern — Drafter/Critic Loop](#4-concept-1-reflection-pattern)
5. [Concept 2: Tool-Augmented Correction — Code Execution Feedback](#5-concept-2-tool-augmented-correction)
6. [Concept 3: Step-Level Trajectory Calibration (STeCa)](#6-concept-3-step-level-trajectory-calibration)
7. [Concept 4: Recovery Copilot Enhancement](#7-concept-4-recovery-copilot-enhancement)
8. [Concept 5: Stuck Detection → Active Recovery](#8-concept-5-stuck-detection-active-recovery)
9. [Concept 6: Multi-Agent Verification & Consensus](#9-concept-6-multi-agent-verification)
10. [Concept 7: LLM-as-a-Judge for Continuous Evaluation](#10-concept-7-llm-as-a-judge)
11. [Concept 8: Memory-Driven Self-Improvement Loop](#11-concept-8-memory-driven-self-improvement)
12. [Concept 9: Convention Extraction & Rule Enforcement](#12-concept-9-convention-extraction)
13. [Concept 10: Observability-Driven Self-Correction](#13-concept-10-observability-driven-self-correction)
14. [Concept 11: Progressive Decomposition & Refinement](#14-concept-11-progressive-decomposition)
15. [Concept 12: Cost-Aware Iteration Control](#15-concept-12-cost-aware-iteration-control)
16. [Integration Architecture](#16-integration-architecture)
17. [Implementation Roadmap](#17-implementation-roadmap)
18. [Evaluation Framework](#18-evaluation-framework)
19. [Safety & Governance](#19-safety-and-governance)

---

## 1. Current State Audit

### What DzipAgent Already Has

| Component | Package | Status | Self-Correction Role |
|-----------|---------|--------|---------------------|
| **StuckDetector** | `@dzipagent/agent` guardrails | Implemented, NOT wired | Detects repeated tool calls, error storms, idle iterations |
| **IterationBudget** | `@dzipagent/agent` guardrails | Implemented, active | Token/cost/iteration limits with threshold warnings |
| **CascadingTimeout** | `@dzipagent/agent` guardrails | Implemented | Time-based execution limits |
| **PipelineRuntime.attemptRecovery** | `@dzipagent/agent` pipeline | Implemented | Recovery copilot with error classification (timeout, resource, build, test, generation) |
| **PipelineRuntime.classifyError** | `@dzipagent/agent` pipeline | Implemented | 5-category error taxonomy |
| **LoopExecutor** | `@dzipagent/agent` pipeline | Implemented | Loop nodes with max iterations |
| **AgentOrchestrator.debate** | `@dzipagent/agent` orchestration | Implemented | Multi-round proposer/judge debate |
| **QualityScorer** | `@dzipagent/codegen` quality | Implemented | Weighted multi-dimension code scoring |
| **CodeReviewer** | `@dzipagent/codegen` review | Implemented | Rule-based code review with severity levels |
| **MemoryConsolidation** | `@dzipagent/memory` | Implemented | Prunes, merges, deduplicates memory entries |
| **MemoryHealer** | `@dzipagent/memory` | Implemented | Finds contradictions, duplicates, stale records |
| **LessonDedup** | `@dzipagent/memory` | Implemented | Jaccard-based lesson deduplication |
| **ConventionExtractor** | `@dzipagent/memory` convention | Implemented | Heuristic + LLM convention detection, conformance checking |
| **SleepConsolidator** | `@dzipagent/memory` | Implemented | Background consolidation with Arrow-based decay |
| **StalenesPruner** | `@dzipagent/memory` | Implemented | Time-based memory pruning |
| **CausalGraph** | `@dzipagent/memory` causal | Implemented | Causal relationship tracking between memories |
| **SafetyMonitor** | `@dzipagent/otel` | Implemented | Pattern-based input/output scanning, tool failure tracking |
| **AutoCompress** | `@dzipagent/context` | Implemented | Automatic context compression when approaching limits |
| **ContextTransfer** | `@dzipagent/context` | Implemented | Cross-intent context sharing |
| **PhaseWindow** | `@dzipagent/context` | Implemented | Phase-aware message windowing |
| **ProgressiveCompress** | `@dzipagent/context` | Implemented | Multi-stage compression |
| **InstructionMerger** | `@dzipagent/agent` instructions | Implemented | Multi-source instruction merging (AGENTS.md + config) |
| **MemoryProfiles** | `@dzipagent/agent` | Implemented | Balanced/minimal/memory-heavy profiles for token allocation |
| **LlmJudgeScorer** | `@dzipagent/evals` scorers | Implemented (placeholder) | Returns 1.0 for non-empty — needs real implementation |
| **BenchmarkRunner** | `@dzipagent/evals` benchmarks | Implemented | Code-gen, QA, tool-use, multi-turn, vector-search suites |
| **Provenance** | `@dzipagent/memory` provenance | Implemented | Tracks origin and lineage of memory entries |
| **AdaptiveRetriever** | `@dzipagent/memory` retrieval | Implemented | Weight-learning retrieval with RRF fusion |
| **RunReflector** | `@dzipagent/agent` reflection | Implemented | 5-dimension heuristic scoring (completeness, coherence, toolSuccess, conciseness, reliability) + optional LLM enhancement on low scores |
| **RecoveryCopilot** | `@dzipagent/agent` recovery | Implemented | 4-step: FailureAnalyzer → StrategyGenerator → StrategyRanker → RecoveryExecutor, with approval gates for high-risk |
| **StrategyRanker** | `@dzipagent/agent` recovery | Implemented | Composite scoring (confidence×0.5 + risk×0.3 + cost×0.2), penalizes already-attempted strategies |
| **SkillLearner** | `@dzipagent/core` skills | Implemented | Tracks execution count, success rate, avg tokens/latency; identifies skills needing review (<50%) or optimization (>80%) |
| **ConventionLearner** | `@dzipagent/codegen` guardrails | Implemented | Learns naming, export, import patterns from ≥3 existing files (majority voting) |
| **CIMonitor + FixLoop** | `@dzipagent/codegen` ci | Implemented | CI failure categorization (type-check, test, lint, build, deploy) + automated fix attempts with escalating prompts |
| **RetrievalFeedbackHook** | `@dzipagent/server` runtime | Implemented | Closed-loop: run reflection score → feedback quality label → AdaptiveRetriever weight tuning |
| **ToolArgValidator** | `@dzipagent/agent` | Implemented | JSON schema validation + auto-repair (type coercion, missing fields) before tool execution |
| **TraceCapture + ReplayEngine** | `@dzipagent/agent` replay | Implemented | Full event capture, breakpoint support, configurable playback speed, state snapshots |
| **CircuitBreaker** | `@dzipagent/core` llm | Implemented | 3-state (closed→open→half-open) for LLM provider health; prevents cascading failures |
| **TransientRetry** | `@dzipagent/core` llm | Implemented | Exponential backoff (1s→8s) for rate limits, 503s, timeouts |
| **MemorySanitizer** | `@dzipagent/memory` | Implemented | Injection detection, exfiltration detection, unicode steganography detection |
| **FrozenSnapshot** | `@dzipagent/context` | Implemented | Prompt cache optimization (75% cost reduction via Anthropic cache alignment) |
| **FeatureGenerator Fix Loop** | `apps/api` graph | Implemented | 3-tier adaptive: targeted→contextual→regenerative (model escalation to Opus) |
| **Risk Classification** | `apps/api` graph | Implemented | 4-tier (critical/sensitive/standard/cosmetic) → generation strategy directives |
| **Tool Call Limiter** | `apps/api` graph | Implemented | Force-advances phase after 20 tool calls to prevent infinite loops |

### Critical Gaps (Self-Correction Not Yet Connected)

| Gap | Impact | Priority |
|-----|--------|----------|
| StuckDetector 3-stage escalation exists in tool-loop BUT not wired into `@dzipagent/agent`-level pipeline nodes | Pipeline nodes don't benefit from stuck recovery; only direct tool-loop calls do | P0 |
| Recovery copilot has no feedback-to-memory path | Same error patterns recur across runs; recovery lessons lost | P0 |
| LLM judge scorer is placeholder (returns 1.0) in `@dzipagent/evals` | All benchmark scores meaningless — false confidence in quality | P0 |
| RunReflector score not fed back to SkillLearner or LessonPipeline | Reflection insights are ephemeral — discovered but not persisted | P1 |
| No step-level reward tracking across pipeline nodes | Can't identify which node degraded quality or compare to baselines | P1 |
| Convention extractor not auto-injected into generation prompts | ConventionExtractor + ConventionLearner exist but don't auto-enrich system prompts | P1 |
| RetrievalFeedbackHook exists but only tunes weights — no lesson extraction | Retrieval improves but doesn't generate reusable rules/lessons | P1 |
| SkillLearner identifies optimizable skills but no auto-optimization pipeline | Skills flagged for review/optimization but nothing acts on the flags | P2 |
| No trajectory calibration across runs | TraceCapture records events but no cross-run comparison or calibration | P2 |
| No multi-agent verification for critical-risk features | Risk classes gate generation strategy but not verification depth | P2 |
| CIMonitor FixLoop exists in codegen but not integrated with pipeline recovery copilot | Two separate fix systems (graph fix node + CI fix loop) don't share strategies | P2 |

---

## 2. The Five Self-Improvement Mechanisms

Based on the research (Nevo's architecture, smolagents, STeCa), a self-improving agent integrates five interlocking feedback loops. Here's how each maps to DzipAgent:

### Mechanism 1: Error Detection

**Research:** Identify when and where failures occur (failed tests, exceptions, quality violations).

**DzipAgent Current State:**
- `StuckDetector`: Detects repeated calls, error storms, idle loops — **but not wired in**
- `PipelineRuntime.classifyError`: 5-category error taxonomy (timeout, resource, build, test, generation)
- `SafetyMonitor`: Pattern scanning for prompt injection, PII leaks, unsafe outputs
- `IterationBudget.checkThresholds`: Budget warning events at configurable thresholds
- `QualityScorer.evaluate`: Multi-dimension quality scoring

**What's Missing:**
- **Semantic error detection**: Detecting when output is semantically wrong (not just syntactically broken)
- **Quality regression detection**: Comparing current output quality to historical baselines
- **Cross-node error correlation**: Understanding error chains across pipeline nodes
- **Proactive error prediction**: Using patterns to predict likely failures before they occur

**Blueprint — ErrorDetectionOrchestrator:**
```typescript
// packages/forgeagent-agent/src/self-correction/error-detector.ts

interface DetectedError {
  type: FailureType              // existing 5 categories + new semantic/regression types
  severity: 'critical' | 'degraded' | 'warning' | 'info'
  source: string                 // nodeId, toolName, or 'semantic'
  message: string
  context: Record<string, unknown>
  suggestedRecovery?: RecoveryStrategy
  correlatedErrors?: string[]    // IDs of related errors in same run
}

interface ErrorDetectionConfig {
  stuckDetector: StuckDetector
  safetyMonitor: SafetyMonitor
  qualityScorer: QualityScorer
  qualityBaseline?: QualityBaseline  // historical score averages
  enableSemanticCheck?: boolean
  enablePredictive?: boolean
}

class ErrorDetectionOrchestrator {
  // Unifies all detection sources into a single stream
  async detect(context: NodeExecutionContext): Promise<DetectedError[]> {
    const errors: DetectedError[] = []

    // 1. Stuck detection
    const stuckStatus = this.config.stuckDetector.recordIteration(context.toolCallCount)
    if (stuckStatus.stuck) errors.push(this.toDetectedError('stuck', stuckStatus))

    // 2. Safety scanning
    const safetyEvents = this.config.safetyMonitor.scanOutput(context.output)
    errors.push(...safetyEvents.map(e => this.toDetectedError('safety', e)))

    // 3. Quality regression
    if (this.config.qualityBaseline && context.output) {
      const score = await this.config.qualityScorer.evaluate(context.output)
      const baseline = this.config.qualityBaseline.getAverage(context.nodeId)
      if (score.total < baseline * 0.8) {
        errors.push({ type: 'quality_regression', severity: 'degraded', ... })
      }
    }

    // 4. Cross-node correlation
    this.correlateErrors(errors)

    return errors
  }
}
```

### Mechanism 2: Root Cause Analysis

**Research:** Diagnose underlying reasons for failure, beyond surface-level symptoms.

**DzipAgent Current State:**
- `classifyError`: Keyword-based error classification (rudimentary)
- `CausalGraph`: Tracks causal relationships in memory — **could be extended to error chains**

**What's Missing:**
- **LLM-driven root cause analysis**: Using an LLM to analyze error context and identify root causes
- **Error pattern recognition**: Detecting recurring error patterns across runs
- **Dependency-aware analysis**: Understanding which upstream failures caused downstream errors

**Blueprint — RootCauseAnalyzer:**
```typescript
// packages/forgeagent-agent/src/self-correction/root-cause-analyzer.ts

interface RootCauseReport {
  immediateError: DetectedError
  rootCause: string             // LLM-generated diagnosis
  causalChain: string[]         // ordered list of contributing factors
  affectedNodes: string[]       // pipeline nodes impacted
  similarPastErrors: MemoryEntry[]  // retrieved from error memory
  suggestedFixes: Fix[]
  confidence: number            // 0-1
}

class RootCauseAnalyzer {
  constructor(
    private llm: BaseChatModel,
    private memoryService: MemoryService,  // to retrieve past error patterns
    private causalGraph: CausalGraph,
  ) {}

  async analyze(
    error: DetectedError,
    executionTrace: ExecutionTrace,
  ): Promise<RootCauseReport> {
    // 1. Retrieve similar past errors from memory
    const pastErrors = await this.memoryService.retrieve({
      namespace: 'errors',
      query: error.message,
      limit: 5,
    })

    // 2. Build causal chain from execution trace
    const causalChain = this.causalGraph.traceBack(error.source)

    // 3. LLM-driven diagnosis
    const diagnosis = await this.llm.invoke([
      new SystemMessage('You are a root cause analyzer for code generation pipelines...'),
      new HumanMessage(this.buildDiagnosisPrompt(error, executionTrace, pastErrors, causalChain)),
    ])

    return this.parseDiagnosis(diagnosis, error)
  }
}
```

### Mechanism 3: Rule Generation and Enforcement

**Research:** Encode new behavioral constraints to prevent recurrence.

**DzipAgent Current State:**
- `ConventionExtractor`: Detects conventions from code, stores in memory with conformance checking
- `InstructionMerger`: Merges instructions from AGENTS.md files
- `GuardrailConfig`: Static blocked tools, budget limits, output filters
- `SafetyMonitor`: Pattern-based safety rules

**What's Missing:**
- **Dynamic rule generation from errors**: Auto-generating rules when errors are detected
- **Rule injection into prompts**: Automatically injecting learned rules into agent system prompts
- **Rule lifecycle management**: Versioning, confidence scoring, expiration of rules
- **Rule conflict resolution**: When two rules contradict

**Blueprint — RuleEngine:**
```typescript
// packages/forgeagent-agent/src/self-correction/rule-engine.ts

interface Rule {
  id: string
  source: 'error' | 'convention' | 'human' | 'eval'
  content: string               // natural language rule
  scope: string                 // which nodes/agents this applies to
  confidence: number            // 0-1, decays over time
  createdAt: Date
  lastApplied: Date
  successRate: number           // % of times applying this rule led to success
  conflictsWith?: string[]      // IDs of conflicting rules
}

class DynamicRuleEngine {
  constructor(
    private memoryService: MemoryService,
    private conventionExtractor: ConventionExtractor,
  ) {}

  // Generate a rule from an error + fix
  async learnFromError(error: DetectedError, fix: Fix): Promise<Rule> {
    const rule = await this.generateRule(error, fix)
    await this.memoryService.put('rules', rule.id, {
      text: rule.content,
      metadata: { scope: rule.scope, confidence: rule.confidence, source: 'error' },
    })
    return rule
  }

  // Get applicable rules for a given context
  async getRulesForContext(nodeId: string, taskType: string): Promise<Rule[]> {
    const allRules = await this.memoryService.retrieve({
      namespace: 'rules',
      query: `${nodeId} ${taskType}`,
      limit: 10,
    })
    return this.filterAndPrioritize(allRules, nodeId)
  }

  // Inject rules into system prompt
  formatForPrompt(rules: Rule[]): string {
    return rules
      .filter(r => r.confidence > 0.5)
      .map(r => `- ${r.content}`)
      .join('\n')
  }
}
```

### Mechanism 4: Memory Consolidation

**Research:** Persistently store lessons, rules, and operational knowledge across sessions.

**DzipAgent Current State:** **STRONG** — This is DzipAgent's most mature self-improvement area.
- `MemoryConsolidation`: Prunes and merges entries by namespace
- `SleepConsolidator`: Background consolidation with Arrow-based decay
- `LessonDedup`: Deduplicates similar lessons
- `MemoryHealer`: Finds contradictions, duplicates, stale records
- `StalenesPruner`: Time-based pruning
- `Provenance`: Tracks memory entry origins
- `DualStreamWriter`: Writes to both working and long-term memory
- `VersionedWorkingMemory`: Version-tracked working memory
- `SemanticConsolidation`: Semantic similarity-based merging

**What's Missing:**
- **Error-to-lesson pipeline**: Automatically converting resolved errors into persistent lessons
- **Success pattern extraction**: Learning from successful runs, not just failures
- **Cross-run consolidation**: Consolidating lessons across multiple runs for the same task type
- **Confidence decay for lessons**: Lessons lose confidence if the codebase changes significantly

**Blueprint — LessonPipeline:**
```typescript
// packages/forgeagent-memory/src/lesson-pipeline.ts

interface Lesson {
  id: string
  type: 'error_resolution' | 'successful_pattern' | 'convention' | 'optimization'
  summary: string
  details: string
  applicableContext: string[]    // task types, node IDs where this applies
  confidence: number
  evidence: {
    runId: string
    nodeId: string
    beforeScore?: number
    afterScore?: number
  }[]
}

class LessonPipeline {
  constructor(
    private memoryService: MemoryService,
    private lessonDedup: typeof dedupLessons,
    private consolidation: typeof consolidateAll,
  ) {}

  // After a successful error recovery, extract the lesson
  async extractFromRecovery(
    error: DetectedError,
    fix: Fix,
    beforeScore: number,
    afterScore: number,
  ): Promise<Lesson> {
    const lesson: Lesson = {
      type: 'error_resolution',
      summary: `When ${error.type} occurs in ${error.source}: ${fix.summary}`,
      details: fix.details,
      confidence: (afterScore - beforeScore) / afterScore,
      evidence: [{ runId: error.context.runId, nodeId: error.source, beforeScore, afterScore }],
      ...
    }

    // Check for duplicates before storing
    const existing = await this.memoryService.retrieve({
      namespace: 'lessons',
      query: lesson.summary,
      limit: 3,
    })

    if (this.isDuplicate(lesson, existing)) {
      return this.mergeWithExisting(lesson, existing[0]!)
    }

    await this.memoryService.put('lessons', lesson.id, {
      text: lesson.summary,
      metadata: lesson,
    })

    return lesson
  }

  // Extract successful patterns from high-scoring runs
  async extractFromSuccess(
    runTrace: ExecutionTrace,
    score: QualityScore,
  ): Promise<Lesson[]> {
    if (score.total < 0.85) return [] // only learn from high-quality runs

    // Identify which decisions led to high scores
    const decisions = this.extractKeyDecisions(runTrace)
    return decisions.map(d => ({
      type: 'successful_pattern',
      summary: d.description,
      confidence: score.total,
      ...
    }))
  }
}
```

### Mechanism 5: Skill Acquisition

**Research:** Expand capabilities to handle previously unhandled tasks.

**DzipAgent Current State:**
- `InstructionLoader`: Loads from AGENTS.md files — **static skill definition**
- `ContractNetManager`: Dynamic specialist selection based on capability bids
- `TopologyAnalyzer`: Dynamic topology analysis for agent networks

**What's Missing:**
- **Dynamic tool creation**: Generating new tools from successful patterns
- **Template learning**: Learning new code generation templates from successful outputs
- **Strategy adaptation**: Adjusting generation strategy based on accumulated experience

**Blueprint — SkillAcquisitionEngine:**
```typescript
// packages/forgeagent-agent/src/self-correction/skill-acquisition.ts

interface LearnedSkill {
  id: string
  name: string
  description: string
  applicableWhen: string        // condition for auto-activation
  strategy: 'tool' | 'template' | 'prompt_injection' | 'pipeline_config'
  content: string               // tool definition, template, or prompt fragment
  successRate: number
  usageCount: number
}

class SkillAcquisitionEngine {
  // After N successful uses of a pattern, crystallize it as a reusable skill
  async maybeCrystallize(
    pattern: Lesson,
    usageHistory: UsageRecord[],
  ): Promise<LearnedSkill | null> {
    if (usageHistory.length < 3) return null // need enough evidence
    if (pattern.confidence < 0.8) return null

    const avgSuccess = usageHistory.reduce((s, u) => s + (u.success ? 1 : 0), 0) / usageHistory.length
    if (avgSuccess < 0.75) return null

    return {
      name: this.generateSkillName(pattern),
      description: pattern.summary,
      applicableWhen: this.inferApplicableContext(usageHistory),
      strategy: this.inferStrategy(pattern),
      content: await this.generateSkillContent(pattern, usageHistory),
      successRate: avgSuccess,
      usageCount: usageHistory.length,
    }
  }
}
```

---

## 3. Self-Correction Strategy Taxonomy

The research identifies six self-correction strategies. Here's how each applies to DzipAgent:

### Strategy A: Intrinsic Self-Correction (Re-prompting)

**What it is:** The agent uses its own reasoning to detect and fix errors via re-prompting.

**DzipAgent applicability:** LOW for complex code generation, HIGH for simple fixes.

**Where to use:**
- Quick syntax fixes after generation
- Formatting corrections
- Simple variable renaming

**Where NOT to use:**
- Logic bugs (model can't reliably detect its own logic errors)
- Architecture decisions
- Security-critical code

**Implementation:** Already partially present in the ReAct tool loop. The model can observe tool errors and adjust. Enhancement: add a `selfReflect` step after each tool batch that explicitly asks the model to evaluate its progress.

### Strategy B: Reflection-Based Methods (Critic Pattern)

**What it is:** The agent generates an explicit critique of its own output.

**DzipAgent applicability:** HIGH — this is the highest-impact missing piece.

**Current gap:** No critic/reflection node in the generation pipeline. Code is generated single-pass.

**Detailed blueprint in [Concept 1](#4-concept-1-reflection-pattern).**

### Strategy C: Tool-Augmented Correction

**What it is:** External tools (execution, linters, tests) validate outputs.

**DzipAgent applicability:** CRITICAL — already has `QualityScorer` and `CodeReviewer` but they're not in the iterative loop.

**Detailed blueprint in [Concept 2](#5-concept-2-tool-augmented-correction).**

### Strategy D: Verification Approaches (Chain-of-Verification)

**What it is:** Structured sequential verification steps.

**DzipAgent applicability:** HIGH — maps naturally to pipeline nodes.

**Current state:** Pipeline has `validate` and `fix` nodes but they're basic. No chain-of-verification pattern.

**Enhancement:** Add explicit verification nodes between each generation stage:
```
gen_backend → verify_backend → gen_frontend → verify_frontend → gen_tests → verify_tests
```
Each verify node checks: type correctness, import resolution, API contract adherence, security patterns.

### Strategy E: Judge/Critique Models

**What it is:** Specialized LLMs act as judges scoring outputs.

**DzipAgent applicability:** HIGH — `LlmJudgeScorer` exists but returns 1.0 (placeholder).

**Detailed blueprint in [Concept 7](#10-concept-7-llm-as-a-judge).**

### Strategy F: Decomposition & Refinement

**What it is:** Complex tasks broken down and iteratively refined.

**DzipAgent applicability:** HIGH — the 16-node pipeline IS a decomposition. Enhancement is refinement loops within each stage.

**Detailed blueprint in [Concept 11](#14-concept-11-progressive-decomposition).**

---

## 4. Concept 1: Reflection Pattern — Drafter/Critic Loop

### Research Basis
The Reflection Pattern (from LangGraph/LangChain research) implements a cyclical graph: Drafter → Critic → Router → (loop or end). Deepsense.ai achieved 81.8% correctness (up from 53.8%) using this pattern.

### Current DzipAgent State
- `AgentOrchestrator.debate` exists but is for multi-agent scenarios
- No single-agent drafter/critic loop in the generation pipeline
- `CodeReviewer` exists but isn't called iteratively

### Proposed Implementation

**New module:** `packages/forgeagent-agent/src/self-correction/reflection-loop.ts`

```typescript
interface ReflectionConfig {
  maxIterations: number          // default 3
  qualityThreshold: number       // 0-1, exit when score exceeds this
  critic: BaseChatModel          // can be smaller/cheaper model
  criticPrompt: string           // evaluation criteria
  includeCodeReview: boolean     // also run static analysis
  includeTests: boolean          // also run generated tests
  costBudgetCents: number        // max spend on reflection loop
}

interface ReflectionResult {
  finalOutput: string
  iterations: number
  scores: QualityScore[]         // score per iteration
  critiques: string[]            // critic feedback per iteration
  totalCost: number
  exitReason: 'quality_met' | 'max_iterations' | 'budget_exhausted' | 'no_improvement'
}

class ReflectionLoop {
  async execute(
    task: string,
    initialDraft: string,
    config: ReflectionConfig,
  ): Promise<ReflectionResult> {
    let currentDraft = initialDraft
    const scores: QualityScore[] = []
    const critiques: string[] = []

    for (let i = 0; i < config.maxIterations; i++) {
      // 1. Critic evaluates
      const critique = await this.critique(currentDraft, task, config)
      critiques.push(critique.feedback)
      scores.push(critique.score)

      // 2. Exit if quality threshold met
      if (critique.score.total >= config.qualityThreshold) {
        return { finalOutput: currentDraft, exitReason: 'quality_met', ... }
      }

      // 3. Exit if no improvement (avoid infinite loops)
      if (i > 0 && critique.score.total <= scores[i - 1]!.total) {
        return { finalOutput: currentDraft, exitReason: 'no_improvement', ... }
      }

      // 4. Revise based on feedback
      currentDraft = await this.revise(currentDraft, critique.feedback, task)
    }

    return { finalOutput: currentDraft, exitReason: 'max_iterations', ... }
  }

  private async critique(
    draft: string,
    task: string,
    config: ReflectionConfig,
  ): Promise<{ feedback: string; score: QualityScore }> {
    const results: string[] = []

    // LLM-based critique
    const llmCritique = await config.critic.invoke([
      new SystemMessage(config.criticPrompt),
      new HumanMessage(`Task: ${task}\n\nCode:\n${draft}\n\nProvide specific, actionable feedback.`),
    ])
    results.push(llmCritique.content)

    // Optional: static code review
    if (config.includeCodeReview) {
      const review = reviewFiles([{ path: 'generated.ts', content: draft }])
      results.push(formatReviewAsMarkdown(review))
    }

    // Optional: test execution feedback
    if (config.includeTests) {
      const testResults = await this.runTests(draft)
      results.push(testResults.summary)
    }

    // Score
    const score = await this.qualityScorer.evaluate(draft)

    return {
      feedback: results.join('\n\n---\n\n'),
      score,
    }
  }
}
```

### Integration Points

1. **In the generation pipeline:** Wrap each `gen_*` node with a reflection loop:
   ```
   gen_backend → ReflectionLoop(critic=quality_scorer+code_reviewer) → extract_contract
   gen_frontend → ReflectionLoop(critic=quality_scorer+type_checker) → gen_tests
   ```

2. **Risk-gated reflection depth:**
   - `critical`: 5 iterations, strict threshold (0.9)
   - `sensitive`: 3 iterations, moderate threshold (0.8)
   - `standard`: 2 iterations, basic threshold (0.7)
   - `cosmetic`: 0 iterations (single pass)

3. **Cost optimization:** Use a cheaper model (Haiku) as critic, expensive model (Sonnet) as drafter.

### Expected Impact
Based on Deepsense.ai benchmarks: **+25-30% correctness** at 5-15x cost increase per task. With risk-gating, average cost increase is ~3-5x (only critical/sensitive features get full reflection).

---

## 5. Concept 2: Tool-Augmented Correction — Code Execution Feedback

### Research Basis
Tool-augmented correction uses external tools (code execution, linters, test runners) to provide objective feedback. This is the most reliable form of self-correction for code generation.

### Current DzipAgent State
- `QualityScorer`: Multi-dimension scoring (correctness 35%, security 25%, maintainability 15%, test coverage 15%, documentation 10%)
- `CodeReviewer`: Rule-based static analysis with severity levels
- Pipeline has `run_tests` and `validate` nodes — but they're terminal, not iterative
- No sandboxed code execution environment for generated code

### Proposed Implementation

**New module:** `packages/forgeagent-codegen/src/execution/code-executor.ts`

```typescript
interface CodeExecutionResult {
  success: boolean
  buildOutput?: { exitCode: number; stdout: string; stderr: string }
  lintOutput?: { errors: number; warnings: number; details: LintIssue[] }
  testOutput?: { passed: number; failed: number; skipped: number; failures: TestFailure[] }
  typeCheckOutput?: { errors: number; details: TypeCheckError[] }
}

interface ToolAugmentedCorrectionConfig {
  maxFixAttempts: number         // default 3
  tools: {
    typeCheck: boolean           // run tsc
    lint: boolean                // run eslint
    build: boolean               // run build
    test: boolean                // run tests if available
    securityScan: boolean        // run secret scan
  }
  sandbox: SandboxConfig         // isolation settings
}

class ToolAugmentedCorrector {
  async correctUntilPassing(
    files: GeneratedFile[],
    config: ToolAugmentedCorrectionConfig,
    agent: DzipAgent,
  ): Promise<{ files: GeneratedFile[]; iterations: number; finalResult: CodeExecutionResult }> {
    let currentFiles = files

    for (let i = 0; i < config.maxFixAttempts; i++) {
      // 1. Execute all enabled tools
      const result = await this.executeTools(currentFiles, config)

      // 2. If all pass, done
      if (this.allPassing(result, config)) {
        return { files: currentFiles, iterations: i + 1, finalResult: result }
      }

      // 3. Build fix prompt from tool outputs
      const fixPrompt = this.buildFixPrompt(currentFiles, result)

      // 4. Agent fixes the code
      const fixResponse = await agent.generate([
        new SystemMessage('You are a code fixer. Apply minimal, targeted fixes based on the tool output.'),
        new HumanMessage(fixPrompt),
      ])

      // 5. Apply fixes
      currentFiles = this.applyFixes(currentFiles, fixResponse.content)
    }

    // Return best attempt even if not fully passing
    return { files: currentFiles, iterations: config.maxFixAttempts, finalResult: await this.executeTools(currentFiles, config) }
  }

  private buildFixPrompt(files: GeneratedFile[], result: CodeExecutionResult): string {
    const sections: string[] = []

    if (result.typeCheckOutput?.errors) {
      sections.push(`## TypeScript Errors (${result.typeCheckOutput.errors})\n` +
        result.typeCheckOutput.details.map(e => `- ${e.file}:${e.line}: ${e.message}`).join('\n'))
    }

    if (result.lintOutput?.errors) {
      sections.push(`## Lint Errors (${result.lintOutput.errors})\n` +
        result.lintOutput.details.map(e => `- ${e.file}:${e.line}: [${e.ruleId}] ${e.message}`).join('\n'))
    }

    if (result.testOutput?.failed) {
      sections.push(`## Test Failures (${result.testOutput.failed})\n` +
        result.testOutput.failures.map(f => `- ${f.testName}: ${f.message}\n  ${f.stack}`).join('\n'))
    }

    return `Fix the following issues in the generated code:\n\n${sections.join('\n\n')}\n\n## Current Files\n` +
      files.map(f => `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n')
  }
}
```

### Integration with VFS (Virtual File System)

DzipAgent already has a `cow-vfs.ts` (copy-on-write VFS). The tool-augmented corrector should:
1. Write generated files to VFS
2. Run tools against VFS snapshot
3. On failure, create new VFS layer with fixes (maintaining diff history)
4. On success, commit VFS snapshot

### Integration with Pipeline

```
gen_backend → ToolAugmentedCorrector(typeCheck + lint) → extract_contract
gen_frontend → ToolAugmentedCorrector(typeCheck + lint) → gen_tests
gen_tests → ToolAugmentedCorrector(typeCheck + test execution) → validate
```

---

## 6. Concept 3: Step-Level Trajectory Calibration (STeCa)

### Research Basis
STeCa identifies suboptimal actions via step-level reward comparison, constructs calibrated trajectories using LLM-driven reflection. Key insight: **timely, step-level calibration prevents error accumulation in long-horizon tasks**.

### DzipAgent Applicability
The 16-node feature generation pipeline IS a long-horizon task. Errors in early nodes (e.g., bad plan, wrong schema) compound through later nodes. Currently there's no step-level quality tracking.

### Proposed Implementation

**New module:** `packages/forgeagent-agent/src/self-correction/trajectory-calibration.ts`

```typescript
interface StepReward {
  nodeId: string
  timestamp: Date
  qualityScore: number          // 0-1 from QualityScorer
  timeSpentMs: number
  tokenCost: number
  errorCount: number
  outputSize: number
}

interface CalibratedTrajectory {
  runId: string
  steps: StepReward[]
  totalScore: number            // aggregate quality
  isCalibrated: boolean         // was this trajectory improved via reflection?
  originalTrajectoryId?: string // if calibrated, which run was the source?
}

class TrajectoryCalibrator {
  constructor(
    private memoryService: MemoryService,
    private qualityScorer: QualityScorer,
    private llm: BaseChatModel,
  ) {}

  // Record step-level rewards during pipeline execution
  async recordStep(
    runId: string,
    nodeId: string,
    output: string,
    metrics: { timeMs: number; tokens: number; errors: number },
  ): Promise<StepReward> {
    const score = await this.qualityScorer.evaluate(output)
    const reward: StepReward = {
      nodeId,
      timestamp: new Date(),
      qualityScore: score.total,
      timeSpentMs: metrics.timeMs,
      tokenCost: metrics.tokens,
      errorCount: metrics.errors,
      outputSize: output.length,
    }

    // Store in trajectory memory
    await this.memoryService.put('trajectories', `${runId}:${nodeId}`, {
      text: `Step ${nodeId}: score=${score.total}`,
      metadata: reward,
    })

    return reward
  }

  // Compare current step against historical baselines
  async detectSuboptimal(
    currentStep: StepReward,
    taskType: string,
  ): Promise<{ isSuboptimal: boolean; baseline: number; suggestion?: string }> {
    // Retrieve historical step rewards for same node + task type
    const history = await this.memoryService.retrieve({
      namespace: 'trajectories',
      query: `${currentStep.nodeId} ${taskType}`,
      limit: 20,
    })

    if (history.length < 5) return { isSuboptimal: false, baseline: 0 } // insufficient data

    const avgScore = history.reduce((s, h) => s + (h.metadata.qualityScore as number), 0) / history.length
    const isSuboptimal = currentStep.qualityScore < avgScore * 0.85

    if (isSuboptimal) {
      const suggestion = await this.generateCalibrationSuggestion(currentStep, history)
      return { isSuboptimal: true, baseline: avgScore, suggestion }
    }

    return { isSuboptimal: false, baseline: avgScore }
  }

  // After a successful run, store the full trajectory for future comparison
  async storeSuccessfulTrajectory(
    runId: string,
    steps: StepReward[],
    overallScore: number,
  ): Promise<void> {
    if (overallScore > 0.8) {
      await this.memoryService.put('golden_trajectories', runId, {
        text: `Successful trajectory: ${steps.map(s => `${s.nodeId}=${s.qualityScore.toFixed(2)}`).join(' → ')}`,
        metadata: { steps, overallScore, timestamp: new Date() },
      })
    }
  }
}
```

### Pipeline Integration

Hook into `PipelineRuntime.executeFromNode`:
```typescript
// After each node execution, check trajectory quality
const step = await calibrator.recordStep(runId, nodeId, output, metrics)
const check = await calibrator.detectSuboptimal(step, taskType)

if (check.isSuboptimal) {
  this.emit({ type: 'pipeline:step_suboptimal', nodeId, score: step.qualityScore, baseline: check.baseline })

  // Option A: Inject calibration suggestion into next node's context
  context.calibrationHint = check.suggestion

  // Option B: Re-execute current node with reflection
  if (config.enableStepCalibration) {
    output = await reflectionLoop.execute(task, output, { maxIterations: 2 })
  }
}
```

---

## 7. Concept 4: Recovery Copilot Enhancement

### Research Basis
The Ralph Pattern uses persistent memory (progress.txt, AGENTS.md) across iterations. Each recovery attempt feeds back into shared knowledge.

### Current DzipAgent State
`PipelineRuntime.attemptRecovery` exists with:
- Error classification (5 types)
- Recovery copilot interface
- Max attempts tracking
- Event emission (attempted, succeeded, failed)

**Gap:** Recovery results don't feed back into memory. The same errors recur.

### Proposed Enhancement

```typescript
// Enhancement to existing attemptRecovery in pipeline-runtime.ts

private async attemptRecoveryEnhanced(
  nodeId: string,
  nodeType: string,
  errorMessage: string,
  runId: string,
  context: NodeExecutionContext,
): Promise<boolean> {
  // 1. EXISTING: Check eligibility and attempt budget
  // ...

  // 2. NEW: Retrieve past recovery strategies for similar errors
  const pastRecoveries = await this.lessonPipeline.retrieveSimilar(errorMessage, nodeId)

  // 3. ENHANCED: Build failure context with historical context
  const failureContext: EnhancedFailureContext = {
    ...baseFailureContext,
    pastRecoveries: pastRecoveries.map(r => ({
      strategy: r.summary,
      successRate: r.confidence,
      lastUsed: r.lastApplied,
    })),
    executionTrace: this.getRecentTrace(runId, 5), // last 5 node executions
  }

  // 4. EXISTING: Attempt recovery
  const result = await rc.copilot.recover(failureContext)

  // 5. NEW: Store recovery outcome as a lesson
  if (result.success) {
    await this.lessonPipeline.extractFromRecovery(
      { type: failureType, source: nodeId, message: errorMessage, ... },
      { summary: result.summary, strategy: result.strategy },
      0, // score before
      1, // score after (recovered)
    )
  } else {
    // Store failed recovery to avoid repeating it
    await this.memoryService.put('failed_recoveries', `${runId}:${nodeId}:${this.recoveryAttemptsUsed}`, {
      text: `Failed recovery for ${failureType} at ${nodeId}: ${result.summary}`,
      metadata: { nodeId, failureType, strategy: result.summary, timestamp: new Date() },
    })
  }

  return result.success
}
```

---

## 8. Concept 5: Stuck Detection → Active Recovery

### Research Basis
Detection without action is dead code (per NEXT_IMPROVEMENTS_AND_CONTRADICTS.md). The research emphasizes escalating recovery: restrict → inject message → abort.

### Current DzipAgent State — ALREADY IMPLEMENTED (tool-loop level)

The deep audit reveals that `tool-loop.ts` **already implements 3-stage escalating stuck recovery**:

**Stage 1: Tool Blocking** — Stuck tool is dynamically blocked via `budget.blockTool(toolName)`. Tool returns `[Tool "X" is blocked by guardrails]`. `onStuck(toolName, 1)` callback triggered.

**Stage 2: Nudge Injection** — SystemMessage injected: *"You appear to be stuck repeating the same tool call. Try a different approach or provide your final answer."* `onStuck(toolName, 2)` callback triggered.

**Stage 3: Loop Abort** — Tool loop breaks with `stopReason: 'stuck'`. Returns partial output. `onStuck(toolName, 3)` callback triggered.

**What already works:**
- StuckDetector created per `generate()` call in DzipAgent
- 3-stage escalation wired into tool-loop
- `stuckStage` counter doesn't reset (ensures escalation proceeds)
- Events emitted via `onStuck` callbacks

### Remaining Gap: Pipeline-Level Stuck Recovery

The tool-loop stuck detection works for **individual agent calls**, but the **pipeline runtime** (`PipelineRuntime.executeFromNode`) doesn't have equivalent stuck detection. A pipeline node can succeed (not stuck per tool-loop) but produce suboptimal output that causes downstream nodes to fail repeatedly.

### Proposed Enhancement: Pipeline-Level Stuck Detection

```typescript
// Enhancement to pipeline-runtime.ts

class PipelineStuckDetector {
  private nodeFailureCounts = new Map<string, number>()
  private loopDetector = new Map<string, string[]>()  // nodeId → recent output hashes

  recordNodeFailure(nodeId: string): { stuck: boolean; reason?: string } {
    const count = (this.nodeFailureCounts.get(nodeId) ?? 0) + 1
    this.nodeFailureCounts.set(nodeId, count)

    if (count >= 3) {
      return { stuck: true, reason: `Node "${nodeId}" failed ${count} times` }
    }
    return { stuck: false }
  }

  recordNodeOutput(nodeId: string, outputHash: string): { stuck: boolean; reason?: string } {
    const history = this.loopDetector.get(nodeId) ?? []
    history.push(outputHash)
    this.loopDetector.set(nodeId, history.slice(-5))

    // Detect identical outputs (node producing same thing repeatedly)
    if (history.length >= 3 && history.slice(-3).every(h => h === outputHash)) {
      return { stuck: true, reason: `Node "${nodeId}" producing identical output` }
    }
    return { stuck: false }
  }

  // Recovery: skip to next node, try alternative strategy, or abort pipeline
  suggestRecovery(nodeId: string, failureCount: number): 'retry_with_hint' | 'skip_node' | 'abort' {
    if (failureCount <= 1) return 'retry_with_hint'
    if (failureCount === 2) return 'skip_node'
    return 'abort'
  }
}
```

### Integration: Feed Stuck Events to Memory

```typescript
// When stuck is detected (either tool-loop or pipeline level):
async function onStuckDetected(event: StuckEvent): Promise<void> {
  // Store in error memory for future avoidance
  await memoryService.put('errors', `stuck:${event.nodeId}:${Date.now()}`, {
    text: `Stuck at ${event.nodeId}: ${event.reason}`,
    metadata: {
      type: 'stuck',
      nodeId: event.nodeId,
      escalationLevel: event.level,
      toolName: event.toolName,
      timestamp: new Date(),
    },
  })

  // If recovery succeeded, store as lesson
  if (event.recoverySucceeded) {
    await lessonPipeline.extractFromRecovery(event.error, event.recovery)
  }
}
```

---

## 9. Concept 6: Multi-Agent Verification & Consensus

### Research Basis
Multi-agent verification uses multiple agents to cross-verify outputs. Methods include debate, voting, consensus, and collective improvement. Research (arXiv 2502.19130) shows this reduces hallucination and improves correctness.

### Current DzipAgent State
- `AgentOrchestrator.debate`: Multi-round proposer/judge — **already implemented**
- `AgentOrchestrator.parallel`: Independent parallel execution
- `ContractNetManager`: Capability-based agent selection
- Missing: voting, consensus, and verification-specific protocols

### Proposed Enhancement: Risk-Gated Verification

```typescript
// packages/forgeagent-agent/src/self-correction/verification-protocol.ts

type VerificationStrategy = 'single' | 'debate' | 'vote' | 'consensus'

function selectVerificationStrategy(riskClass: RiskClass): VerificationStrategy {
  switch (riskClass) {
    case 'critical': return 'consensus'   // all agents must agree
    case 'sensitive': return 'debate'     // proposer/judge pattern
    case 'standard': return 'vote'        // majority vote (cheaper)
    case 'cosmetic': return 'single'      // no verification
  }
}

class VerificationProtocol {
  // Majority vote: N agents generate, pick most common answer
  async vote(
    agents: DzipAgent[],
    task: string,
    options?: { minAgreement?: number },
  ): Promise<{ result: string; agreement: number; variants: string[] }> {
    const results = await Promise.all(
      agents.map(a => a.generate([new HumanMessage(task)])),
    )

    const outputs = results.map(r => r.content)
    const clusters = this.clusterBySimilarity(outputs, 0.8) // semantic similarity clustering
    const dominant = clusters.sort((a, b) => b.length - a.length)[0]!
    const agreement = dominant.length / outputs.length

    if (agreement < (options?.minAgreement ?? 0.5)) {
      // No consensus — escalate to debate
      return this.escalateToDebate(agents, task, outputs)
    }

    return { result: dominant[0]!, agreement, variants: outputs }
  }

  // Consensus: all agents must converge through iterative refinement
  async consensus(
    agents: DzipAgent[],
    judge: DzipAgent,
    task: string,
    options?: { maxRounds?: number },
  ): Promise<{ result: string; converged: boolean; rounds: number }> {
    const maxRounds = options?.maxRounds ?? 3
    let proposals = await Promise.all(
      agents.map(a => a.generate([new HumanMessage(task)])),
    ).then(rs => rs.map(r => r.content))

    for (let round = 0; round < maxRounds; round++) {
      // Judge identifies points of agreement and disagreement
      const synthesis = await judge.generate([
        new HumanMessage(
          `Task: ${task}\n\nProposals:\n${proposals.map((p, i) => `## ${i + 1}\n${p}`).join('\n\n')}\n\n` +
          `Identify: 1) Points of agreement, 2) Points of disagreement, 3) Synthesized best answer`
        ),
      ])

      // Check convergence
      if (this.hasConverged(proposals, 0.9)) {
        return { result: synthesis.content, converged: true, rounds: round + 1 }
      }

      // Each agent refines based on synthesis
      proposals = await Promise.all(
        agents.map(a => a.generate([
          new HumanMessage(
            `Previous synthesis:\n${synthesis.content}\n\nRevise your proposal to address the points of disagreement.`
          ),
        ])),
      ).then(rs => rs.map(r => r.content))
    }

    return { result: proposals[0]!, converged: false, rounds: maxRounds }
  }
}
```

### Pipeline Integration

In the feature generation pipeline:
```typescript
// When generating backend code for a critical feature:
const riskClass = feature.riskClass // 'critical' | 'sensitive' | 'standard' | 'cosmetic'
const strategy = selectVerificationStrategy(riskClass)

switch (strategy) {
  case 'consensus':
    result = await verifier.consensus([agent1, agent2, agent3], judgeAgent, task)
    break
  case 'debate':
    result = await orchestrator.debate([agent1, agent2], judgeAgent, task, { rounds: 2 })
    break
  case 'vote':
    result = await verifier.vote([agent1, agent2, agent3], task)
    break
  case 'single':
    result = await agent1.generate([new HumanMessage(task)])
    break
}
```

---

## 10. Concept 7: LLM-as-a-Judge for Continuous Evaluation

### Research Basis
LLM-as-a-judge evaluation enables automated scoring on subjective criteria. The research warns about biases (verbosity, authority, overconfidence) and recommends calibration.

### Current DzipAgent State
- `LlmJudgeScorer` in `@dzipagent/evals` — **returns 1.0 for non-empty output (placeholder)**
- `LlmJudgeEnhanced` exists but also needs real implementation
- `BenchmarkRunner` delegates to scorer registry
- `QualityScorer` in codegen does weighted multi-dimension scoring (hardcoded, not LLM-based)

### Proposed Implementation

```typescript
// packages/forgeagent-evals/src/scorers/llm-judge-scorer.ts (REPLACE placeholder)

interface JudgeDimension {
  name: string
  description: string
  weight: number
  anchorExamples: { score: number; example: string }[] // calibration
}

const CODE_GENERATION_DIMENSIONS: JudgeDimension[] = [
  {
    name: 'correctness',
    description: 'Does the code correctly implement the specified requirements?',
    weight: 0.35,
    anchorExamples: [
      { score: 1.0, example: 'All requirements implemented, all tests pass' },
      { score: 0.5, example: 'Core logic correct but edge cases missing' },
      { score: 0.0, example: 'Fundamental logic error, tests fail' },
    ],
  },
  {
    name: 'security',
    description: 'Is the code free from security vulnerabilities (injection, XSS, auth bypass)?',
    weight: 0.25,
    anchorExamples: [/* ... */],
  },
  {
    name: 'maintainability',
    description: 'Is the code well-structured, readable, and maintainable?',
    weight: 0.15,
    anchorExamples: [/* ... */],
  },
  {
    name: 'completeness',
    description: 'Does the code include necessary error handling, types, and edge cases?',
    weight: 0.15,
    anchorExamples: [/* ... */],
  },
  {
    name: 'consistency',
    description: 'Does the code follow project conventions and patterns?',
    weight: 0.10,
    anchorExamples: [/* ... */],
  },
]

class RealLlmJudgeScorer implements Scorer {
  constructor(
    private llm: BaseChatModel,
    private dimensions: JudgeDimension[] = CODE_GENERATION_DIMENSIONS,
  ) {}

  async score(input: ScorerInput): Promise<ScorerResult> {
    const response = await this.llm.withStructuredOutput(JudgeOutputSchema).invoke([
      new SystemMessage(this.buildSystemPrompt()),
      new HumanMessage(this.buildEvalPrompt(input)),
    ])

    // Weighted aggregate
    const total = this.dimensions.reduce(
      (sum, dim) => sum + dim.weight * (response.scores[dim.name] ?? 0),
      0,
    )

    return {
      score: total,
      dimensions: response.scores,
      reasoning: response.reasoning,
      metadata: { model: this.llm.modelName, dimensions: this.dimensions.map(d => d.name) },
    }
  }

  private buildSystemPrompt(): string {
    return `You are a code quality judge. Score the following code on ${this.dimensions.length} dimensions.

For each dimension, provide a score from 0.0 to 1.0 using these calibration anchors:

${this.dimensions.map(d => `### ${d.name} (weight: ${d.weight})
${d.description}
Anchors:
${d.anchorExamples.map(a => `- ${a.score}: ${a.example}`).join('\n')}`).join('\n\n')}

Respond with JSON: { "scores": { dimension: number }, "reasoning": "brief explanation" }`
  }
}
```

### Integration: Continuous Quality Monitoring

```typescript
// After each generation pipeline run, evaluate quality and track trends
class QualityMonitor {
  async evaluateRun(
    runId: string,
    generatedFiles: GeneratedFile[],
    task: string,
  ): Promise<void> {
    const score = await this.judge.score({ input: task, output: generatedFiles })

    // Store in trajectory memory
    await this.trajectoryCalibrator.storeStepReward(runId, 'overall', score.score)

    // Compare to baseline
    const baseline = await this.getBaseline(task.taskType)
    if (score.score < baseline * 0.9) {
      this.eventBus.emit({
        type: 'quality:regression_detected',
        current: score.score,
        baseline,
        dimensions: score.dimensions,
      })
    }

    // Update baseline (rolling average)
    await this.updateBaseline(task.taskType, score.score)
  }
}
```

---

## 11. Concept 8: Memory-Driven Self-Improvement Loop

### Research Basis
The Ralph Pattern uses persistent learnings (AGENTS.md, progress.txt) to inform future iterations. Each agent instance starts fresh but inherits accumulated knowledge.

### Current DzipAgent State
**Memory system is mature** — MemoryService, consolidation, healing, provenance, conventions, causal graphs, sleep consolidation, semantic consolidation, lesson dedup, adaptive retrieval, staleness pruning.

**Gap:** Memory isn't actively used to **modify agent behavior**. Lessons are stored but not injected into prompts or used to adjust generation strategies.

### Proposed Enhancement: Active Memory Integration

```typescript
// packages/forgeagent-agent/src/self-correction/memory-integrator.ts

class MemoryDrivenImprover {
  constructor(
    private memoryService: MemoryService,
    private ruleEngine: DynamicRuleEngine,
    private conventionExtractor: ConventionExtractor,
  ) {}

  // Before a generation node runs, prepare context from memory
  async prepareContextFromMemory(
    nodeId: string,
    taskType: string,
    featureSpec: FeatureSpec,
  ): Promise<MemoryContext> {
    // 1. Retrieve applicable rules
    const rules = await this.ruleEngine.getRulesForContext(nodeId, taskType)

    // 2. Retrieve relevant lessons
    const lessons = await this.memoryService.retrieve({
      namespace: 'lessons',
      query: `${taskType} ${featureSpec.name} ${nodeId}`,
      limit: 5,
    })

    // 3. Retrieve applicable conventions
    const conventions = await this.conventionExtractor.getActiveConventions()
    const relevant = conventions.filter(c => c.category === taskType || c.techStack === featureSpec.stack)

    // 4. Retrieve past error patterns for this node
    const pastErrors = await this.memoryService.retrieve({
      namespace: 'errors',
      query: nodeId,
      limit: 3,
    })

    return {
      rules: this.ruleEngine.formatForPrompt(rules),
      lessons: lessons.map(l => `- ${l.text}`).join('\n'),
      conventions: this.conventionExtractor.formatForPrompt(relevant),
      warnings: pastErrors.map(e => `- Avoid: ${e.text}`).join('\n'),
    }
  }

  // Inject memory context into the system prompt
  formatAsSystemPromptSection(ctx: MemoryContext): string {
    const sections: string[] = []

    if (ctx.rules) {
      sections.push(`## Active Rules\n${ctx.rules}`)
    }
    if (ctx.lessons) {
      sections.push(`## Lessons from Past Runs\n${ctx.lessons}`)
    }
    if (ctx.conventions) {
      sections.push(`## Project Conventions\n${ctx.conventions}`)
    }
    if (ctx.warnings) {
      sections.push(`## Known Pitfalls\n${ctx.warnings}`)
    }

    return sections.join('\n\n')
  }

  // After a run completes, update memory with new learnings
  async postRunConsolidate(
    runId: string,
    trace: ExecutionTrace,
    overallScore: number,
  ): Promise<void> {
    // 1. Extract lessons from errors and recoveries
    for (const event of trace.events.filter(e => e.type === 'pipeline:recovery_succeeded')) {
      await this.lessonPipeline.extractFromRecovery(event.error, event.fix, 0, 1)
    }

    // 2. Extract successful patterns from high-scoring runs
    if (overallScore > 0.85) {
      await this.lessonPipeline.extractFromSuccess(trace, overallScore)
    }

    // 3. Update convention confidence based on results
    await this.conventionExtractor.consolidate()

    // 4. Run memory healing
    await healMemory(this.memoryService.getStore(), {
      autoMergeDuplicates: true,
      autoPruneStale: true,
    })

    // 5. Run lesson deduplication
    const allLessons = await this.memoryService.list('lessons')
    await dedupLessons(allLessons)
  }
}
```

### Pipeline Hook: Memory-Aware Node Execution

```typescript
// In pipeline-runtime.ts executeFromNode enhancement:

async executeFromNode(nodeId: string, context: NodeExecutionContext): Promise<NodeResult> {
  // NEW: Prepare memory context before node execution
  const memoryCtx = await this.memoryIntegrator.prepareContextFromMemory(
    nodeId,
    context.taskType,
    context.featureSpec,
  )

  // Inject into node context
  context.systemPromptAddendum = this.memoryIntegrator.formatAsSystemPromptSection(memoryCtx)

  // Execute node (existing logic)
  const result = await node.execute(context)

  return result
}
```

---

## 12. Concept 9: Convention Extraction & Auto-Enforcement

### Research Basis
Self-improving agents encode behavioral rules from experience. The convention system should be a closed loop: detect patterns → store conventions → enforce in future generation → validate compliance.

### Current DzipAgent State
`ConventionExtractor` is **well-implemented**:
- 8 heuristic rules (naming, imports, error handling, async patterns, etc.)
- LLM-based convention analysis
- Conformance checking (both heuristic and LLM-based)
- Convention storage in memory with semantic search
- Human verification support

**Gap:** Conventions aren't auto-injected into generation prompts or used in the quality gate.

### Proposed Enhancement: Convention-Driven Quality Gate

```typescript
// packages/forgeagent-codegen/src/quality/convention-gate.ts

class ConventionGate {
  constructor(
    private conventionExtractor: ConventionExtractor,
    private codeReviewer: CodeReviewer,  // existing reviewer
  ) {}

  async evaluate(
    files: GeneratedFile[],
    taskContext: { stack: string; projectId: string },
  ): Promise<ConventionGateResult> {
    // 1. Get active conventions for this stack/project
    const conventions = await this.conventionExtractor.getActiveConventions()
    const relevant = conventions.filter(c =>
      c.techStack === taskContext.stack && c.confidence > 0.7
    )

    // 2. Check conformance for each file
    const violations: ConventionViolation[] = []

    for (const file of files) {
      const conformance = await this.conventionExtractor.checkConformance(
        file.content,
        relevant,
      )

      for (const violation of conformance.violations) {
        violations.push({
          file: file.path,
          convention: violation.convention,
          description: violation.description,
          severity: violation.convention.confidence > 0.9 ? 'error' : 'warning',
          suggestion: violation.suggestion,
        })
      }
    }

    // 3. Also run standard code review
    const review = reviewFiles(files.map(f => ({ path: f.path, content: f.content })))

    return {
      passed: violations.filter(v => v.severity === 'error').length === 0,
      violations,
      codeReview: review,
      conventionsChecked: relevant.length,
    }
  }
}
```

### Auto-Learning Pipeline

```
Successful generation run → ConventionExtractor.analyzeCode(generatedFiles) → New conventions stored
→ Next generation run → Conventions injected into prompts → Convention gate validates output
→ Violations trigger targeted fixes → Fix success/failure updates convention confidence
```

---

## 13. Concept 10: Observability-Driven Self-Correction

### Research Basis
TruLens/OpenTelemetry-based tracing enables trace-based analysis, debugging, and continuous improvement. The research emphasizes instrumenting agent workflows for end-to-end visibility.

### Current DzipAgent State
- `DzipTracer` in `@dzipagent/otel`: Full OTel SDK with AsyncLocalStorage context
- `OTelBridge`: Event→metrics bridge
- `SafetyMonitor`: Pattern-based safety scanning
- `CostAttribution`: Per-agent cost tracking
- Pipeline events: `pipeline:node_start`, `pipeline:node_complete`, `pipeline:error`, `pipeline:recovery_*`

**Gap:** No feedback loop from observability data back to agent behavior.

### Proposed Enhancement: Observability-to-Correction Pipeline

```typescript
// packages/forgeagent-otel/src/correction-signals.ts

interface CorrectionSignal {
  type: 'latency_spike' | 'cost_overrun' | 'error_rate_high' | 'quality_drop' | 'safety_violation'
  severity: 'info' | 'warning' | 'critical'
  nodeId?: string
  agentId?: string
  details: Record<string, unknown>
  suggestedAction: string
}

class ObservabilityCorrectionBridge {
  private readonly thresholds = {
    latency: { warn: 30_000, critical: 60_000 },   // ms
    costPerNode: { warn: 0.50, critical: 2.00 },    // USD
    errorRate: { warn: 0.3, critical: 0.5 },         // per window
  }

  // Analyze trace data and generate correction signals
  async analyzeTrace(trace: Span[]): Promise<CorrectionSignal[]> {
    const signals: CorrectionSignal[] = []

    for (const span of trace) {
      // Latency analysis
      if (span.duration > this.thresholds.latency.critical) {
        signals.push({
          type: 'latency_spike',
          severity: 'critical',
          nodeId: span.attributes['node.id'],
          details: { duration: span.duration, expected: this.thresholds.latency.warn },
          suggestedAction: 'Consider decomposing this node or using a faster model',
        })
      }

      // Cost analysis
      const cost = span.attributes['llm.cost_cents'] as number
      if (cost > this.thresholds.costPerNode.critical * 100) {
        signals.push({
          type: 'cost_overrun',
          severity: 'critical',
          nodeId: span.attributes['node.id'],
          details: { cost, budget: this.thresholds.costPerNode.critical },
          suggestedAction: 'Switch to a cheaper model or reduce context window',
        })
      }
    }

    return signals
  }

  // Feed correction signals back into the pipeline
  async applyCorrectionSignals(
    signals: CorrectionSignal[],
    pipeline: PipelineRuntime,
  ): Promise<void> {
    for (const signal of signals.filter(s => s.severity === 'critical')) {
      switch (signal.type) {
        case 'latency_spike':
          // Auto-reduce max tokens for the slow node
          pipeline.adjustNodeConfig(signal.nodeId!, { maxTokens: Math.floor(pipeline.getNodeConfig(signal.nodeId!).maxTokens * 0.7) })
          break
        case 'cost_overrun':
          // Switch to cheaper model for that node
          pipeline.adjustNodeConfig(signal.nodeId!, { model: 'haiku' })
          break
        case 'error_rate_high':
          // Enable reflection loop for that node
          pipeline.adjustNodeConfig(signal.nodeId!, { enableReflection: true, reflectionIterations: 2 })
          break
      }
    }
  }
}
```

---

## 14. Concept 11: Progressive Decomposition & Refinement

### Research Basis
Complex tasks should be decomposed into subtasks, each refined iteratively. This modular approach supports scalability and targeted correction.

### Current DzipAgent State
- 16-node pipeline IS a decomposition
- `PlanningAgent` exists in orchestration
- `MapReduce` pattern for parallel decomposition
- Missing: dynamic decomposition based on task complexity

### Proposed Enhancement: Adaptive Decomposition

```typescript
// packages/forgeagent-agent/src/self-correction/adaptive-decomposer.ts

interface DecompositionStrategy {
  type: 'sequential' | 'parallel' | 'hierarchical'
  subtasks: Subtask[]
  estimatedComplexity: number   // 0-1
  estimatedCost: number         // cents
}

class AdaptiveDecomposer {
  constructor(
    private planner: DzipAgent,
    private complexityEstimator: ComplexityEstimator,
  ) {}

  async decompose(task: string, context: TaskContext): Promise<DecompositionStrategy> {
    // 1. Estimate complexity
    const complexity = await this.complexityEstimator.estimate(task)

    // 2. Choose decomposition strategy based on complexity
    if (complexity < 0.3) {
      return { type: 'sequential', subtasks: [{ task, refinementDepth: 1 }], ... }
    }

    if (complexity < 0.6) {
      // Moderate: decompose into 2-3 subtasks with reflection
      const plan = await this.planner.generate([
        new HumanMessage(`Decompose into 2-3 independent subtasks: ${task}`),
      ])
      return {
        type: 'parallel',
        subtasks: this.parseSubtasks(plan.content).map(s => ({
          ...s,
          refinementDepth: 2, // each subtask gets 2 reflection iterations
        })),
        ...
      }
    }

    // High complexity: hierarchical decomposition with deep refinement
    const plan = await this.planner.generate([
      new HumanMessage(`Create a hierarchical task decomposition: ${task}`),
    ])
    return {
      type: 'hierarchical',
      subtasks: this.parseHierarchicalPlan(plan.content).map(s => ({
        ...s,
        refinementDepth: 3 + Math.floor(complexity * 2), // 3-5 iterations
      })),
      ...
    }
  }
}
```

---

## 15. Concept 12: Cost-Aware Iteration Control

### Research Basis
Deepsense.ai showed 81.8% correctness at $0.61/task vs 53.8% at $0.04/task (15x cost). Self-correction needs cost/benefit analysis to avoid wasteful iteration.

### Current DzipAgent State
- `IterationBudget`: Token/cost/iteration limits with threshold warnings
- `CostAttribution` in OTel: Per-agent cost tracking
- `MemoryProfiles`: Token allocation profiles

**Gap:** No dynamic cost/benefit analysis during iteration. The budget is static.

### Proposed Enhancement: Adaptive Iteration Controller

```typescript
// packages/forgeagent-agent/src/self-correction/iteration-controller.ts

interface IterationDecision {
  shouldContinue: boolean
  reason: string
  expectedImprovementProbability: number
  expectedCostRemaining: number
}

class AdaptiveIterationController {
  private scoreHistory: number[] = []
  private costHistory: number[] = []

  decide(
    currentScore: number,
    targetScore: number,
    iterationNumber: number,
    maxIterations: number,
    costSoFar: number,
    costBudget: number,
  ): IterationDecision {
    this.scoreHistory.push(currentScore)

    // 1. Already meets target
    if (currentScore >= targetScore) {
      return { shouldContinue: false, reason: 'target_met', ... }
    }

    // 2. Budget exhausted
    if (costSoFar >= costBudget * 0.95) {
      return { shouldContinue: false, reason: 'budget_exhausted', ... }
    }

    // 3. Diminishing returns detection
    if (this.scoreHistory.length >= 3) {
      const recentImprovement = this.scoreHistory.slice(-3)
      const delta1 = recentImprovement[1]! - recentImprovement[0]!
      const delta2 = recentImprovement[2]! - recentImprovement[1]!

      // If improvement rate is declining and below threshold
      if (delta2 < delta1 * 0.5 && delta2 < 0.02) {
        return {
          shouldContinue: false,
          reason: 'diminishing_returns',
          expectedImprovementProbability: 0.2,
          ...
        }
      }
    }

    // 4. No improvement after 2 iterations
    if (this.scoreHistory.length >= 2) {
      const prev = this.scoreHistory[this.scoreHistory.length - 2]!
      if (currentScore <= prev) {
        return {
          shouldContinue: false,
          reason: 'no_improvement',
          ...
        }
      }
    }

    // 5. Cost-benefit analysis
    const avgImprovementPerIteration = this.scoreHistory.length > 1
      ? (currentScore - this.scoreHistory[0]!) / (this.scoreHistory.length - 1)
      : 0.1 // assume moderate improvement

    const avgCostPerIteration = costSoFar / Math.max(iterationNumber, 1)
    const remainingGap = targetScore - currentScore
    const estimatedIterationsNeeded = remainingGap / Math.max(avgImprovementPerIteration, 0.01)
    const estimatedCostToTarget = estimatedIterationsNeeded * avgCostPerIteration

    if (estimatedCostToTarget > costBudget - costSoFar) {
      return {
        shouldContinue: false,
        reason: 'cost_prohibitive',
        expectedCostRemaining: estimatedCostToTarget,
        ...
      }
    }

    return { shouldContinue: true, reason: 'continue', ... }
  }
}
```

---

## 16. Integration Architecture

### Unified Self-Improvement Loop

All 12 concepts connect into a single closed loop:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DzipAgent Self-Improvement Loop                  │
│                                                                     │
│  ┌──────────┐    ┌─────────────┐    ┌──────────────┐              │
│  │ Generate  │───→│   Evaluate   │───→│   Diagnose   │              │
│  │ (Drafter) │    │ (Tools+Judge)│    │ (Root Cause) │              │
│  └─────▲─────┘    └──────┬──────┘    └──────┬───────┘              │
│        │                 │                   │                      │
│        │           Pass? ├── YES ──→ Store Success Pattern          │
│        │                 │           (Lesson Pipeline)              │
│        │                 NO                  │                      │
│        │                 │                   ▼                      │
│  ┌─────┴─────┐    ┌─────┴─────┐    ┌──────────────┐              │
│  │   Revise   │◄──│  Reflect   │◄──│ Generate Rule │              │
│  │ (w/Memory) │    │  (Critic)  │    │ (Rule Engine) │              │
│  └───────────┘    └───────────┘    └──────┬───────┘              │
│                                           │                      │
│                                    ┌──────▼───────┐              │
│                                    │ Store Lesson  │              │
│                                    │ (Memory+Conv) │              │
│                                    └──────┬───────┘              │
│                                           │                      │
│                                    ┌──────▼───────┐              │
│                                    │  Consolidate  │              │
│                                    │ (Sleep/Dedup) │              │
│                                    └───────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

### Package Ownership

| Component | Package | New/Enhanced |
|-----------|---------|-------------|
| ReflectionLoop | `@dzipagent/agent` self-correction | NEW |
| ErrorDetectionOrchestrator | `@dzipagent/agent` self-correction | NEW |
| RootCauseAnalyzer | `@dzipagent/agent` self-correction | NEW |
| DynamicRuleEngine | `@dzipagent/agent` self-correction | NEW |
| TrajectoryCalibrator | `@dzipagent/agent` self-correction | NEW |
| AdaptiveIterationController | `@dzipagent/agent` self-correction | NEW |
| AdaptiveDecomposer | `@dzipagent/agent` self-correction | NEW |
| VerificationProtocol | `@dzipagent/agent` self-correction | NEW |
| SkillAcquisitionEngine | `@dzipagent/agent` self-correction | NEW |
| StuckDetector wiring | `@dzipagent/agent` tool-loop | ENHANCED |
| Recovery copilot feedback | `@dzipagent/agent` pipeline | ENHANCED |
| ToolAugmentedCorrector | `@dzipagent/codegen` execution | NEW |
| ConventionGate | `@dzipagent/codegen` quality | NEW |
| LessonPipeline | `@dzipagent/memory` | NEW |
| MemoryDrivenImprover | `@dzipagent/agent` self-correction | NEW |
| RealLlmJudgeScorer | `@dzipagent/evals` scorers | REPLACE |
| ObservabilityCorrectionBridge | `@dzipagent/otel` | NEW |
| QualityMonitor | `@dzipagent/evals` | NEW |

### New Directory Structure

```
packages/forgeagent-agent/src/self-correction/
├── index.ts
├── reflection-loop.ts          # Concept 1
├── error-detector.ts           # Mechanism 1
├── root-cause-analyzer.ts      # Mechanism 2
├── rule-engine.ts              # Mechanism 3
├── trajectory-calibration.ts   # Concept 3
├── iteration-controller.ts     # Concept 12
├── adaptive-decomposer.ts      # Concept 11
├── verification-protocol.ts    # Concept 6
├── skill-acquisition.ts        # Mechanism 5
├── memory-integrator.ts        # Concept 8
└── stuck-recovery.ts           # Concept 5

packages/forgeagent-codegen/src/execution/
├── code-executor.ts            # Concept 2
└── tool-augmented-corrector.ts # Concept 2

packages/forgeagent-codegen/src/quality/
└── convention-gate.ts          # Concept 9

packages/forgeagent-memory/src/
└── lesson-pipeline.ts          # Mechanism 4

packages/forgeagent-otel/src/
└── correction-signals.ts       # Concept 10
```

---

## 17. Implementation Roadmap

### Sprint 1: Foundation (P0 — 2 weeks)

| Task | Depends On | Effort | Impact |
|------|-----------|--------|--------|
| Pipeline-level stuck detection (Concept 5 enhancement) | None | M | HIGH — detects cross-node stuck patterns |
| ReflectionLoop core implementation (Concept 1) | None | L | HIGH — enables iterative refinement |
| Replace LlmJudgeScorer placeholder (Concept 7) | None | M | HIGH — real eval scores |
| Recovery copilot feedback to memory (Concept 4) | None | S | HIGH — stops error recurrence |
| Wire RunReflector → SkillLearner → LessonPipeline | None | M | HIGH — close the reflection loop |

**Sprint 1 Acceptance:**
- Pipeline nodes trigger stuck detection (not just tool-loop level)
- ReflectionLoop can wrap any generation node
- LlmJudgeScorer returns real scores with 5 calibrated dimensions
- Recovery successes/failures stored as lessons
- RunReflector scores feed into SkillLearner metrics and lesson extraction

### Sprint 2: Evaluation & Tools (P0-P1 — 2 weeks)

| Task | Depends On | Effort | Impact |
|------|-----------|--------|--------|
| ToolAugmentedCorrector (Concept 2) | Sprint 1 ReflectionLoop | L | CRITICAL — tool-based validation |
| TrajectoryCalibrator (Concept 3) | Sprint 1 LlmJudge | M | HIGH — step-level quality tracking |
| AdaptiveIterationController (Concept 12) | Sprint 1 ReflectionLoop | M | MEDIUM — cost-aware iteration |
| ConventionGate (Concept 9) | None | M | MEDIUM — convention enforcement |

**Sprint 2 Acceptance:**
- Generated code goes through typecheck+lint loop before proceeding
- Each pipeline node records step-level quality scores
- Reflection loops exit early on diminishing returns
- Convention violations block pipeline (for errors)

### Sprint 3: Memory & Intelligence (P1 — 2 weeks)

| Task | Depends On | Effort | Impact |
|------|-----------|--------|--------|
| LessonPipeline (Mechanism 4) | Sprint 1 recovery feedback | M | HIGH — persistent learning |
| MemoryDrivenImprover (Concept 8) | LessonPipeline | L | HIGH — memory → prompt injection |
| ErrorDetectionOrchestrator (Mechanism 1) | Sprint 1 StuckDetector | M | MEDIUM — unified error stream |
| RootCauseAnalyzer (Mechanism 2) | ErrorDetector | M | MEDIUM — intelligent diagnosis |

**Sprint 3 Acceptance:**
- Lessons auto-extracted from recoveries and successes
- Generation prompts include relevant lessons and conventions
- Error detection unified across stuck/safety/quality/semantic
- Root cause analysis produces actionable diagnostics

### Sprint 4: Advanced Patterns (P2 — 2 weeks)

| Task | Depends On | Effort | Impact |
|------|-----------|--------|--------|
| VerificationProtocol (Concept 6) | Sprint 1 ReflectionLoop | L | MEDIUM — multi-agent verification |
| DynamicRuleEngine (Mechanism 3) | Sprint 3 LessonPipeline | M | MEDIUM — auto-generated rules |
| ObservabilityCorrectionBridge (Concept 10) | Sprint 2 Trajectory | M | MEDIUM — OTel → correction signals |
| AdaptiveDecomposer (Concept 11) | None | M | LOW-MEDIUM |

### Sprint 5: Skill Acquisition & Polish (P2 — 2 weeks)

| Task | Depends On | Effort | Impact |
|------|-----------|--------|--------|
| SkillAcquisitionEngine (Mechanism 5) | Sprint 3 LessonPipeline | L | MEDIUM — crystallize patterns |
| Risk-gated verification depth | Sprint 4 VerificationProtocol | M | MEDIUM |
| Cross-run consolidation | Sprint 3 Memory | M | MEDIUM |
| End-to-end integration tests | All | L | HIGH — validate full loop |

---

## 18. Evaluation Framework

### Metrics to Track

| Metric | Baseline | Target (Sprint 5) | How to Measure |
|--------|----------|-------------------|----------------|
| Generation correctness (tests pass) | Unknown (eval placeholder) | >80% | Real LlmJudgeScorer + test execution |
| Self-correction success rate | 0% (no correction) | >60% | Recovery events / error events |
| Same-error recurrence rate | Unknown | <10% | Semantic similarity of errors across runs |
| Cost per correct generation | N/A | <$2.00 | CostAttribution + correctness |
| Average iterations to quality threshold | 1 (single pass) | <3 | ReflectionLoop metrics |
| Convention conformance rate | Unknown | >90% | ConventionGate pass rate |
| Mean time to correct | N/A | <60s per iteration | Trace latency |

### Evaluation Suite

Extend `@dzipagent/evals` benchmarks:

1. **Self-Correction Benchmark**: Deliberately introduce bugs into generated code, measure correction rate
2. **Reflection Quality Benchmark**: Compare single-pass vs N-iteration quality
3. **Memory Learning Benchmark**: Run same task type 10 times, measure quality improvement curve
4. **Cost Efficiency Benchmark**: Quality vs cost Pareto frontier
5. **Stuck Recovery Benchmark**: Deliberately trigger stuck conditions, measure recovery rate

---

## 19. Safety & Governance

### Guardrails for Self-Correction

1. **Max reflection depth**: Hard limit on nested reflection loops to prevent infinite recursion
2. **Cost ceiling per run**: Absolute max spend including all reflection iterations
3. **Rule confidence threshold**: Only enforce rules with confidence > 0.5
4. **Human-in-the-loop for new rules**: Critical rules require human verification before enforcement
5. **Rollback capability**: If a learned rule causes quality regression, auto-disable it
6. **Audit trail**: Every self-correction action logged with provenance for reproducibility

### Safety Considerations

- **Reflection can amplify biases**: If the critic model shares biases with the drafter, reflection reinforces errors. Mitigation: use different models for drafter and critic.
- **Memory poisoning**: A series of bad runs could pollute the lesson memory. Mitigation: confidence decay, human verification for high-impact lessons, staleness pruning.
- **Cost explosion**: Unbounded reflection loops can drain budgets. Mitigation: AdaptiveIterationController with diminishing-returns detection.
- **Rule conflicts**: Auto-generated rules may contradict each other. Mitigation: DynamicRuleEngine conflict detection with MemoryHealer's contradiction finder.

---

## Appendix A: Research-to-DzipAgent Mapping Summary

| Research Concept | DzipAgent Existing | DzipAgent Enhancement | Priority |
|-----------------|--------------------|-----------------------|----------|
| Reflection Pattern (Deepsense) | AgentOrchestrator.debate, RunReflector (heuristic+LLM) | ReflectionLoop per pipeline node | P0 |
| Tool-Augmented Correction | QualityScorer, CodeReviewer, ContractValidator, ImportValidator, GuardrailEngine | ToolAugmentedCorrector in iterative loop | P0 |
| STeCa Step-Level Calibration | TraceCapture (events), RunReflector (scoring) | TrajectoryCalibrator with cross-run comparison | P1 |
| Recovery Copilot (Ralph) | Full 4-step RecoveryCopilot (analyzer→strategy→rank→execute) | Recovery → Memory feedback pipeline | P0 |
| Stuck Detection → Recovery | StuckDetector + 3-stage tool-loop escalation (WIRED) | Pipeline-level stuck detection | P0 |
| Multi-Agent Verification | AgentOrchestrator.debate, ContractNet, Supervisor | VerificationProtocol (vote, consensus), risk-gated depth | P2 |
| LLM-as-a-Judge | LlmJudgeScorer (**placeholder — returns 1.0**) | Real implementation with 5 calibrated dimensions | P0 |
| Memory Consolidation | Full system (consolidation, healing, dedup, decay, staleness, semantic) | LessonPipeline (error→lesson) + prompt injection | P1 |
| Convention Enforcement | ConventionExtractor + ConventionLearner (detection + conformance) | ConventionGate in pipeline + auto-inject into prompts | P1 |
| OTel Observability | DzipTracer, OTelBridge, SafetyMonitor, CostAttribution | CorrectionBridge (OTel → adaptive actions) | P2 |
| Decomposition & Refinement | 16-node pipeline, MapReduce, DelegatingSupervisor | AdaptiveDecomposer based on complexity | P2 |
| Cost-Aware Iteration | IterationBudget (static), CascadingTimeout, fork() | AdaptiveIterationController (diminishing returns) | P1 |
| Error Detection | classifyError (5-cat), SafetyMonitor, StuckDetector, CircuitBreaker | ErrorDetectionOrchestrator (unified) | P1 |
| Root Cause Analysis | CausalGraph (memory), FailureAnalyzer (recovery copilot) | RootCauseAnalyzer (LLM-driven + cross-node) | P1 |
| Rule Generation | ConventionExtractor + ConventionLearner (heuristic + LLM) | DynamicRuleEngine (error→rule auto-generation) | P2 |
| Skill Acquisition | SkillLearner (metrics + review/optimize flags), InstructionLoader | SkillAcquisitionEngine (auto-crystallize patterns) | P2 |
| Retrieval Learning | AdaptiveRetriever (weight learning), RetrievalFeedbackHook | Lesson extraction from retrieval outcomes | P1 |
| CI Self-Correction | CIMonitor + FixLoop (codegen) | Integrate with pipeline recovery copilot | P2 |

---

## Appendix B: Key File References

### Agent Package — Self-Correction Core
| File | Role |
|------|------|
| `packages/forgeagent-agent/src/agent/dzip-agent.ts` | Main agent class, ReAct loop orchestration |
| `packages/forgeagent-agent/src/agent/tool-loop.ts` | Tool execution with 3-stage stuck escalation |
| `packages/forgeagent-agent/src/agent/tool-arg-validator.ts` | Schema validation + auto-repair of tool args |
| `packages/forgeagent-agent/src/agent/memory-profiles.ts` | Token allocation profiles (minimal/balanced/memory-heavy) |
| `packages/forgeagent-agent/src/guardrails/stuck-detector.ts` | StuckDetector: repeat calls, error storms, idle |
| `packages/forgeagent-agent/src/guardrails/iteration-budget.ts` | Budget tracking with parent/child sharing |
| `packages/forgeagent-agent/src/guardrails/cascading-timeout.ts` | Hierarchical timeouts with reserve |
| `packages/forgeagent-agent/src/reflection/run-reflector.ts` | 5-dimension heuristic + LLM scoring |
| `packages/forgeagent-agent/src/recovery/recovery-copilot.ts` | 4-step: analyze → generate strategy → rank → execute |
| `packages/forgeagent-agent/src/recovery/strategy-ranker.ts` | Composite scoring with attempt penalty |
| `packages/forgeagent-agent/src/approval/approval-gate.ts` | Human-in-the-loop for risky actions |
| `packages/forgeagent-agent/src/replay/trace-capture.ts` | Full event capture with snapshots |
| `packages/forgeagent-agent/src/replay/replay-engine.ts` | Playback with breakpoints |
| `packages/forgeagent-agent/src/pipeline/pipeline-runtime.ts` | Pipeline execution + recovery copilot + error classification |
| `packages/forgeagent-agent/src/pipeline/loop-executor.ts` | Loop nodes with max iterations |
| `packages/forgeagent-agent/src/orchestration/orchestrator.ts` | Debate, parallel, supervisor patterns |
| `packages/forgeagent-agent/src/orchestration/delegating-supervisor.ts` | Multi-agent delegation + goal decomposition |
| `packages/forgeagent-agent/src/instructions/instruction-merger.ts` | Multi-source instruction merging |

### Codegen Package — Quality & Validation
| File | Role |
|------|------|
| `packages/forgeagent-codegen/src/quality/quality-scorer.ts` | Weighted multi-dimension code scoring |
| `packages/forgeagent-codegen/src/quality/contract-validator.ts` | Backend↔Frontend API contract validation |
| `packages/forgeagent-codegen/src/review/code-reviewer.ts` | Rule-based static code review |
| `packages/forgeagent-codegen/src/validation/import-validator.ts` | Import resolution checking |
| `packages/forgeagent-codegen/src/guardrails/guardrail-engine.ts` | Architecture validation (layering, naming, security) |
| `packages/forgeagent-codegen/src/guardrails/convention-learner.ts` | Learns naming/export/import patterns from existing code |
| `packages/forgeagent-codegen/src/ci/ci-monitor.ts` | CI failure categorization |
| `packages/forgeagent-codegen/src/ci/fix-loop.ts` | Automated CI failure fix with escalating prompts |

### Memory Package — Consolidation & Learning
| File | Role |
|------|------|
| `packages/forgeagent-memory/src/memory-consolidation.ts` | 4-phase consolidation (orient/gather/consolidate/prune) |
| `packages/forgeagent-memory/src/memory-healer.ts` | Contradiction/duplicate/stale detection + auto-resolution |
| `packages/forgeagent-memory/src/lesson-dedup.ts` | Jaccard-based lesson deduplication |
| `packages/forgeagent-memory/src/convention/convention-extractor.ts` | Convention detection + LLM analysis + conformance |
| `packages/forgeagent-memory/src/sleep-consolidator.ts` | Background consolidation with Arrow decay |
| `packages/forgeagent-memory/src/staleness-pruner.ts` | Access-frequency-aware pruning |
| `packages/forgeagent-memory/src/decay-engine.ts` | Ebbinghaus forgetting curve + spaced repetition |
| `packages/forgeagent-memory/src/memory-sanitizer.ts` | Injection/exfiltration/steganography detection |
| `packages/forgeagent-memory/src/causal/causal-graph.ts` | Causal relationship tracking |
| `packages/forgeagent-memory/src/retrieval/adaptive-retriever.ts` | Intent-based weight learning + RRF fusion |
| `packages/forgeagent-memory/src/provenance/provenance-writer.ts` | Memory entry origin tracking |

### Core Package — Infrastructure
| File | Role |
|------|------|
| `packages/forgeagent-core/src/llm/circuit-breaker.ts` | 3-state provider health (closed/open/half-open) |
| `packages/forgeagent-core/src/llm/retry.ts` | Transient error detection + exponential backoff |
| `packages/forgeagent-core/src/errors/forge-error.ts` | Typed errors with `recoverable` flag + `suggestion` |
| `packages/forgeagent-core/src/skills/skill-learner.ts` | Execution metrics + optimization threshold detection |

### Evals, OTel, Server, Context
| File | Role |
|------|------|
| `packages/forgeagent-evals/src/scorers/llm-judge-scorer.ts` | LLM judge (**placeholder — returns 1.0**) |
| `packages/forgeagent-evals/src/benchmarks/benchmark-runner.ts` | Benchmark execution engine |
| `packages/forgeagent-otel/src/safety-monitor.ts` | Non-blocking pattern-based safety scanning |
| `packages/forgeagent-otel/src/otel-bridge.ts` | Event→metrics translation |
| `packages/forgeagent-server/src/runtime/retrieval-feedback-hook.ts` | Closed-loop retrieval quality → weight tuning |
| `packages/forgeagent-context/src/auto-compress.ts` | 4-phase context compression |
| `packages/forgeagent-context/src/context-transfer.ts` | Cross-intent context sharing |
| `packages/forgeagent-context/src/prompt-cache.ts` | Frozen snapshot for cache alignment |

### Feature Generation Pipeline
| File | Role |
|------|------|
| `apps/api/src/services/agent/graphs/feature-generator.graph.ts` | 16-node LangGraph graph with 3-tier fix escalation |
| `apps/api/src/services/agent/graphs/feature-generator.state.ts` | State types for pipeline |
| `apps/api/src/services/agent/tools/builder/validate-feature.tool.ts` | Validation tool (TypeScript, security, schema) |
| `apps/api/src/services/generation/validate.service.ts` | Multi-gate validation service |
| `apps/api/src/services/agent/utils/memory-consolidation.ts` | Post-publish memory consolidation |

---

## Appendix C: Related Documents

- `docs/self_correction_agent.md` — Source research on self-correcting agents
- `docs/NEXT_IMPROVEMENTS_AND_CONTRADICTS.md` — Runtime hardening roadmap (overlaps with Concepts 4, 5, 7)
- `docs/code_gen/05-generation-pipeline.md` — Current pipeline architecture
- `docs/code_gen/07-quality-security-and-evals.md` — Quality gates and scoring
- `docs/forgeagent/07-AGENT-SUBAGENT-FEATURES-ANALYSIS.md` — Agent feature gaps
- `docs/forgeagent/03-ARCHITECTURE-ANALYSIS.md` — Architecture risks
- `docs/memory_plan/08-memory-consolidation.md` — Memory consolidation design
