# 12 -- Security & Governance

> **Created:** 2026-03-24
> **Status:** Planning
> **Priority:** P1-P2
> **Estimated Total Effort:** 76h (10 features)
> **Dependencies:** 01-Identity, 06-Observability, existing `@dzipagent/core/security/*`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Threat Model](#2-threat-model)
3. [Feature Specifications](#3-feature-specifications)
   - F1: Zero-Trust Policy Engine (P1, 16h)
   - F2: Runtime Safety Monitoring (P1, 8h)
   - F3: Compliance Audit Trail (P1, 8h)
   - F4: Memory Poisoning Defense (P1, 6h)
   - F5: Sandbox Hardening (P1, 6h)
   - F6: Cross-Agent Security (P2, 8h)
   - F7: Output Safety Filters (P1, 4h)
   - F8: Incident Response (P2, 8h)
   - F9: Data Classification (P2, 4h)
   - F10: Security Testing Framework (P2, 8h)
4. [Data Flow Diagrams](#4-data-flow-diagrams)
5. [File Structure](#5-file-structure)
6. [Testing Strategy](#6-testing-strategy)
7. [Migration Path](#7-migration-path)
8. [ADR Log](#8-adr-log)

---

## 1. Architecture Overview

### 1.1 Defense-in-Depth Layer Model

DzipAgent security is organized as concentric defense rings. Every user message, tool call, memory write, and agent response passes through multiple independent layers. A failure in any single layer does not compromise the system because the next layer catches it.

```
 Layer 0: Network & Transport
   TLS, API-key auth, rate limiting (@dzipagent/server middleware)

 Layer 1: Input Validation
   Schema validation (Zod), prompt injection scanning, PII/secret detection
   (@dzipagent/core/security, @dzipagent/memory sanitizer)

 Layer 2: Policy Enforcement  [NEW -- F1]
   Zero-trust policy engine: principal + action + resource -> allow/deny
   Deterministic evaluation, no LLM in enforcement path

 Layer 3: Runtime Monitoring  [NEW -- F2]
   Continuous behavioral monitoring during agent execution
   Anomaly detection, tool-usage pattern analysis, memory integrity checks

 Layer 4: Output Filtering    [ENHANCED -- F7]
   PII redaction, secrets scanning, harmful-content filtering
   (extends existing OutputPipeline)

 Layer 5: Audit & Compliance  [NEW -- F3]
   Immutable hash-chain audit log, retention policies, SIEM export

 Layer 6: Incident Response   [NEW -- F8]
   Automated playbook execution on security events
```

### 1.2 Security Architecture Diagram

```
                    User Request
                         |
                    [Rate Limiter]          Layer 0
                         |
                    [Auth Middleware]        Layer 0
                         |
                  +------v------+
                  | Input Scanner|          Layer 1
                  | - injection  |
                  | - PII/secrets|
                  +------+------+
                         |
                  +------v------+
                  | Policy Engine|          Layer 2
                  | evaluate(    |
                  |  principal,  |
                  |  action,     |
                  |  resource)   |
                  +------+------+
                         |  DENY --> 403 + AuditEntry
                         |  ALLOW
                         v
              +----------+----------+
              |    DzipAgent        |
              |    Tool Loop         |
              |                      |
              |  +--[Safety Monitor]-+---> DzipEventBus
              |  |  (continuous)     |     |
              |  |                   |     +-> AuditStore
              |  |  tool call ------>+---> PolicyEngine.evaluate()
              |  |                   |     |
              |  |  memory write --->+---> MemoryPoisoningDefense
              |  |                   |     |
              |  |  sandbox exec --->+---> SandboxHardening
              |  +-------------------+
              |                      |
              +----------+-----------+
                         |
                  +------v------+
                  | Output Filter|          Layer 4
                  | Pipeline     |
                  +------+------+
                         |
                  +------v------+
                  | Audit Trail  |          Layer 5
                  | (hash chain) |
                  +------+------+
                         |
                    Response to User
```

### 1.3 Invariants

These properties MUST hold at all times:

1. **Policy enforcement is deterministic** -- no LLM in the evaluation path. Policies are evaluated as pure functions over structured inputs.
2. **Audit entries are immutable** -- once written, an audit entry cannot be modified. Entries form a hash chain for tamper detection.
3. **Security failures are non-silent** -- every blocked action emits a `DzipEvent` and writes an `AuditEntry`. No security decision is swallowed.
4. **Default-deny for unknown actions** -- the policy engine denies any action not explicitly allowed by a matching policy rule.
5. **Memory writes are gated** -- all memory content passes through sanitization AND policy evaluation before persistence.
6. **Sandbox escapes are detectable** -- anomalous system calls, file access outside allowlist, or network egress attempts trigger immediate termination.

### 1.4 Package Ownership

| Component | Package | Rationale |
|-----------|---------|-----------|
| Policy types, PolicyEvaluator interface, PolicyRule | `@dzipagent/core` | Core primitive -- no I/O, pure evaluation |
| SafetyMonitor, MemoryPoisoningDefense | `@dzipagent/core` | Event-driven, stateless scanners |
| OutputFilter enhancements | `@dzipagent/core` | Extends existing `OutputPipeline` |
| DataClassification types | `@dzipagent/core` | Shared type definitions |
| AuditStore interface, InMemoryAuditStore | `@dzipagent/core` | Interface in core, in-memory for dev |
| PostgresAuditStore, audit routes | `@dzipagent/server` | Persistence implementation |
| SandboxHardening | `@dzipagent/codegen` | Extends existing `DockerSandbox` |
| CrossAgentSecurity | `@dzipagent/agent` | Agent-to-agent communication concerns |
| IncidentResponse | `@dzipagent/server` | Needs persistence and HTTP hooks |
| SecurityTestFramework | `@dzipagent/testing` | Test-time only |

---

## 2. Threat Model

### 2.1 STRIDE Analysis

| Threat Category | Asset | Threat Description | Current Mitigation | Gap | Feature |
|----------------|-------|-------------------|-------------------|-----|---------|
| **S**poofing | Agent identity | Attacker impersonates a trusted agent in multi-agent orchestration | None | No mutual authentication between agents | F6 |
| **S**poofing | API caller | Attacker uses stolen API key | API-key auth middleware | No key rotation, no scope restrictions | F1 |
| **T**ampering | Memory store | Attacker injects false facts via crafted prompts that persist to memory | `sanitizeMemoryContent()` regex patterns | No cross-reference validation, no LLM-based detection | F4 |
| **T**ampering | Audit log | Attacker modifies audit records to hide malicious activity | None (no audit log exists) | Complete gap | F3 |
| **T**ampering | Agent instructions | Prompt injection overrides system prompt via user input | 8 injection regex patterns in `memory-sanitizer.ts` | Regex-only detection misses sophisticated attacks | F2, F4 |
| **R**epudiation | Tool calls | Agent performs destructive action with no record | Event bus emits `tool:called` (ephemeral) | No persistent, tamper-evident record | F3 |
| **R**epudiation | Approval decisions | No proof of who approved a destructive action | `approval:granted` event (ephemeral) | Not persisted with integrity guarantees | F3 |
| **I**nformation Disclosure | PII in responses | Agent leaks PII from memory into responses | `OutputPipeline` with PII redaction stage | No harmful-content filter, no classification-aware redaction | F7, F9 |
| **I**nformation Disclosure | Secrets in code | Agent generates code containing hardcoded secrets | `scanForSecrets()` in output pipeline | No prevention at generation time, only post-hoc detection | F2 |
| **I**nformation Disclosure | Cross-agent memory | Agent A reads classified memory belonging to Agent B | Namespace isolation | No formal classification, no encryption at rest | F9, F6 |
| **D**enial of Service | LLM budget | Runaway agent exhausts token/cost budget | `iteration-budget.ts` guardrail | No real-time monitoring, no automatic kill on anomaly | F2 |
| **D**enial of Service | Sandbox resources | Code execution consumes all container resources | Docker `--memory`, `--cpus` limits | No OOM detection, no pooling, no seccomp | F5 |
| **E**levation of Privilege | Tool permissions | Agent escalates from `log` tier to `require-approval` tier tools | `RiskClassifier` with static tool lists | No runtime context-aware re-evaluation, no policy engine | F1 |
| **E**levation of Privilege | Sandbox escape | Malicious generated code escapes container isolation | `--security-opt=no-new-privileges`, `--read-only` | No seccomp profile, no syscall audit, no escape detection | F5 |

### 2.2 Attack Trees

#### Attack Tree 1: Memory Poisoning

```
Goal: Inject false facts into agent long-term memory
|
+-- [1] Direct injection via user message
|   +-- [1.1] Craft prompt that bypasses regex sanitizer
|   |   +-- [1.1.1] Use Unicode homoglyphs for "ignore previous"
|   |   +-- [1.1.2] Split injection across multiple messages
|   |   +-- [1.1.3] Encode payload in base64 within a "code example"
|   +-- [1.2] State false facts conversationally
|       +-- [1.2.1] "Actually, our API uses port 8080" (override real config)
|       +-- [1.2.2] Gradual truth-shifting over multiple turns
|
+-- [2] Indirect injection via tool output
|   +-- [2.1] Compromised external API returns poisoned data
|   +-- [2.2] Read file containing injected instructions
|   +-- [2.3] HTTP connector fetches page with hidden instructions
|
+-- [3] Cross-agent poisoning
    +-- [3.1] Compromised sub-agent writes to shared memory space
    +-- [3.2] Agent-as-tool returns poisoned structured output
```

**Mitigations by feature:**
- F4 (Memory Poisoning Defense): Addresses [1.1], [1.2], [2.1], [2.2] via cross-reference validation and anomaly detection
- F2 (Runtime Safety Monitor): Addresses [1.1.2] via multi-turn pattern analysis
- F6 (Cross-Agent Security): Addresses [3.1], [3.2] via message signing and capability restrictions
- F9 (Data Classification): Addresses [2.3] via classification-aware memory policies

#### Attack Tree 2: Privilege Escalation via Tool Misuse

```
Goal: Execute destructive tool without approval
|
+-- [1] Bypass risk classification
|   +-- [1.1] Invoke tool by alias not in approval list
|   +-- [1.2] Use MCP tool bridge to access unclassified external tool
|   +-- [1.3] Chain multiple log-tier tools to achieve require-approval effect
|       e.g., write_file + execute_command (if execute_command is blocked, write a script then run it)
|
+-- [2] Exploit approval gate
|   +-- [2.1] Cause approval timeout to return 'approved' (it returns 'timeout')
|   +-- [2.2] Race condition: modify plan between approval request and execution
|
+-- [3] Sandbox escape
    +-- [3.1] Exploit kernel vulnerability from inside container
    +-- [3.2] Write to tmpfs then use docker socket (if mounted)
    +-- [3.3] Side-channel via shared filesystem
```

**Mitigations:**
- F1 (Policy Engine): Addresses [1.1], [1.2], [1.3] via action-level policy evaluation with resource context
- F5 (Sandbox Hardening): Addresses [3.1], [3.2], [3.3] via seccomp, no docker socket, filesystem ACLs
- F3 (Audit Trail): Makes [2.2] detectable through immutable pre/post approval records

### 2.3 Mitigation Coverage Matrix

| Threat | F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 |
|--------|----|----|----|----|----|----|----|----|----|----|
| Prompt injection | | X | | X | | | | | | X |
| Memory poisoning | | X | | X | | X | | | X | X |
| Tool escalation | X | X | X | | | | | X | | X |
| PII leakage | | | X | | | | X | | X | X |
| Sandbox escape | | | X | | X | | | X | | X |
| Agent spoofing | X | | X | | | X | | X | | X |
| Audit tampering | | | X | | | | | X | | |
| Data exfiltration | | X | X | | X | X | X | X | X | X |

---

## 3. Feature Specifications

### F1: Zero-Trust Policy Engine (P1, 16h)

#### Rationale

The current `RiskClassifier` operates on tool names only with static lists. It cannot express policies like "agent X can only call write_file on paths matching `/workspace/**`" or "operator role can approve runs but not create agents." We need a general-purpose policy engine inspired by AWS Cedar that evaluates structured policy rules deterministically -- no LLM in the enforcement loop.

#### Design Decisions

- **JSON-based policy language** rather than a DSL. JSON is machine-readable, storable, and does not require a parser. Cedar's syntax is elegant but adds a parser dependency and learning curve. We provide an LLM-assisted natural-language-to-policy translator for authoring convenience.
- **Deny-overrides conflict resolution** following the principle of least privilege. If any applicable rule says DENY, the result is DENY regardless of ALLOW rules.
- **Policy evaluation is synchronous and pure** -- it receives a structured context object and returns a decision. No I/O, no async, no LLM calls.
- **Policies live in core as interfaces** with storage implementations in server.

#### TypeScript Interfaces

```typescript
// @dzipagent/core/src/security/policy/policy-types.ts

/**
 * Effect of a policy rule evaluation.
 * 'allow' permits the action; 'deny' blocks it.
 */
export type PolicyEffect = 'allow' | 'deny';

/**
 * A single policy rule in the zero-trust engine.
 *
 * Rules are modeled after Cedar: principal + action + resource + conditions.
 * All fields are optional filters -- omitting a field means "match any."
 *
 * @example
 * ```ts
 * // Allow operators to approve any run
 * const rule: PolicyRule = {
 *   id: 'allow-operator-approve',
 *   effect: 'allow',
 *   principal: { roles: ['operator', 'admin'] },
 *   action: { names: ['run:approve', 'run:reject'] },
 *   description: 'Operators can approve or reject runs',
 * };
 *
 * // Deny all agents from calling git_push on main branch
 * const rule2: PolicyRule = {
 *   id: 'deny-push-main',
 *   effect: 'deny',
 *   principal: { type: 'agent' },
 *   action: { names: ['tool:git_push'] },
 *   resource: { patterns: ['repo:*/branch:main'] },
 *   conditions: [],
 *   description: 'No agent may push directly to main',
 * };
 * ```
 */
export interface PolicyRule {
  /** Unique identifier for this rule */
  readonly id: string;

  /** Human-readable description of the rule's intent */
  readonly description?: string;

  /** Whether matching this rule allows or denies the action */
  readonly effect: PolicyEffect;

  /**
   * Principal filter. If omitted, matches any principal.
   * Multiple fields are AND-ed: principal must match ALL specified filters.
   */
  readonly principal?: {
    /** Match by principal type: 'user', 'agent', 'service', 'system' */
    readonly type?: PrincipalType;
    /** Match by specific principal IDs */
    readonly ids?: readonly string[];
    /** Match by role membership (any of these roles) */
    readonly roles?: readonly string[];
  };

  /**
   * Action filter. If omitted, matches any action.
   * Action names follow the pattern "domain:operation",
   * e.g., "tool:write_file", "run:approve", "memory:write", "agent:spawn".
   */
  readonly action?: {
    /** Exact action names to match (any of these) */
    readonly names?: readonly string[];
    /** Glob patterns for action names, e.g., "tool:*", "memory:*" */
    readonly patterns?: readonly string[];
  };

  /**
   * Resource filter. If omitted, matches any resource.
   * Resources are identified by URI-like strings.
   */
  readonly resource?: {
    /** Exact resource identifiers */
    readonly ids?: readonly string[];
    /** Glob patterns for resource URIs, e.g., "file:/workspace/**" */
    readonly patterns?: readonly string[];
    /** Resource type filter */
    readonly type?: string;
  };

  /**
   * Additional conditions that must ALL be true for this rule to apply.
   * Conditions are evaluated against the PolicyContext.
   */
  readonly conditions?: readonly PolicyCondition[];

  /** Priority for ordering within a PolicySet (higher = evaluated first) */
  readonly priority?: number;

  /** ISO timestamp -- when this rule was created */
  readonly createdAt?: string;

  /** ISO timestamp -- when this rule expires (undefined = never) */
  readonly expiresAt?: string;
}

/**
 * Principal types in the DzipAgent system.
 */
export type PrincipalType = 'user' | 'agent' | 'service' | 'system';

/**
 * A condition is a predicate evaluated against the PolicyContext.
 * Conditions use a simple operator-based syntax for deterministic evaluation.
 *
 * @example
 * ```ts
 * // Only during business hours
 * { field: 'context.hour', operator: 'gte', value: 9 }
 * { field: 'context.hour', operator: 'lte', value: 17 }
 *
 * // Only for files in workspace
 * { field: 'resource.path', operator: 'glob', value: '/workspace/**' }
 *
 * // Budget below threshold
 * { field: 'context.costCents', operator: 'lt', value: 500 }
 * ```
 */
export interface PolicyCondition {
  /** Dot-path into the PolicyContext, e.g., "principal.roles", "context.costCents" */
  readonly field: string;

  /** Comparison operator */
  readonly operator: ConditionOperator;

  /** Value to compare against. Must be JSON-serializable. */
  readonly value: string | number | boolean | readonly string[];
}

export type ConditionOperator =
  | 'eq'        // equals
  | 'neq'       // not equals
  | 'gt'        // greater than
  | 'gte'       // greater than or equal
  | 'lt'        // less than
  | 'lte'       // less than or equal
  | 'in'        // value is in array
  | 'not_in'    // value is not in array
  | 'contains'  // string/array contains
  | 'glob'      // glob pattern match
  | 'regex';    // regex match

/**
 * A PolicySet is a named collection of rules with metadata.
 * Multiple PolicySets can be composed -- all are evaluated and
 * deny-overrides conflict resolution applies across the union.
 */
export interface PolicySet {
  /** Unique identifier */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Description of the policy set's purpose */
  readonly description?: string;

  /** Ordered rules (evaluated top to bottom within this set) */
  readonly rules: readonly PolicyRule[];

  /** Version number for tracking changes */
  readonly version: number;

  /** Whether this policy set is active */
  readonly active: boolean;

  /** ISO timestamp */
  readonly createdAt: string;

  /** ISO timestamp */
  readonly updatedAt: string;
}

/**
 * Context provided to the policy evaluator for every decision.
 * This is the full environment the engine uses to evaluate conditions.
 */
export interface PolicyContext {
  /** Who is performing the action */
  readonly principal: {
    readonly id: string;
    readonly type: PrincipalType;
    readonly roles: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
  };

  /** What action is being performed */
  readonly action: {
    /** Canonical action name, e.g., "tool:write_file" */
    readonly name: string;
    /** Raw arguments to the action (for condition evaluation) */
    readonly args?: Readonly<Record<string, unknown>>;
  };

  /** What resource is being acted upon */
  readonly resource?: {
    readonly id?: string;
    readonly type?: string;
    readonly path?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };

  /** Environmental context */
  readonly environment?: {
    readonly timestamp?: string;
    readonly hour?: number;
    readonly agentId?: string;
    readonly runId?: string;
    readonly costCents?: number;
    readonly tokensUsed?: number;
    readonly iterationCount?: number;
  };
}

/**
 * Result of a policy evaluation.
 */
export interface PolicyDecision {
  /** Final effect after conflict resolution */
  readonly effect: PolicyEffect;

  /** All rules that matched (for audit/debugging) */
  readonly matchedRules: readonly {
    readonly ruleId: string;
    readonly policySetId: string;
    readonly effect: PolicyEffect;
  }[];

  /** The rule that determined the final decision */
  readonly decidingRule?: {
    readonly ruleId: string;
    readonly policySetId: string;
  };

  /** Reason string for logging/audit */
  readonly reason: string;

  /** Time taken for evaluation in microseconds */
  readonly evaluationTimeUs: number;
}
```

```typescript
// @dzipagent/core/src/security/policy/policy-evaluator.ts

import type {
  PolicySet,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
  PolicyCondition,
} from './policy-types.js';

/**
 * Deterministic policy evaluator.
 *
 * Evaluates a request context against a set of policy rules.
 * Uses deny-overrides conflict resolution: if ANY matching rule
 * says DENY, the decision is DENY.
 *
 * IMPORTANT: This class performs NO I/O, NO async operations,
 * and NO LLM calls. Evaluation is a pure function.
 *
 * @example
 * ```ts
 * const evaluator = new PolicyEvaluator();
 * evaluator.addPolicySet(adminPolicies);
 * evaluator.addPolicySet(agentPolicies);
 *
 * const decision = evaluator.evaluate({
 *   principal: { id: 'agent-123', type: 'agent', roles: ['codegen'] },
 *   action: { name: 'tool:write_file', args: { path: '/workspace/src/app.ts' } },
 *   resource: { type: 'file', path: '/workspace/src/app.ts' },
 * });
 *
 * if (decision.effect === 'deny') {
 *   throw new ForgeError({ code: 'POLICY_DENIED', message: decision.reason });
 * }
 * ```
 */
export interface PolicyEvaluator {
  /**
   * Add a policy set to the evaluator. Multiple sets can be active simultaneously.
   * Rules from all active sets are evaluated together with deny-overrides.
   */
  addPolicySet(policySet: PolicySet): void;

  /**
   * Remove a policy set by ID.
   */
  removePolicySet(policySetId: string): void;

  /**
   * List all active policy set IDs.
   */
  listPolicySets(): readonly string[];

  /**
   * Evaluate a request against all active policy sets.
   *
   * Evaluation algorithm:
   * 1. Collect all rules from all active policy sets
   * 2. Filter to rules whose principal/action/resource filters match the context
   * 3. For matching rules, evaluate all conditions against the context
   * 4. Collect fully-matching rules
   * 5. Apply deny-overrides: if any matching rule has effect 'deny', result is 'deny'
   * 6. If at least one matching rule has effect 'allow' and none deny, result is 'allow'
   * 7. If no rules match, result is 'deny' (default-deny)
   *
   * @param context - The request context to evaluate
   * @returns PolicyDecision with effect, matched rules, and reasoning
   */
  evaluate(context: PolicyContext): PolicyDecision;

  /**
   * Validate a policy set for structural correctness.
   * Returns a list of validation errors (empty = valid).
   */
  validate(policySet: PolicySet): readonly string[];
}
```

```typescript
// @dzipagent/core/src/security/policy/policy-store.ts

import type { PolicySet } from './policy-types.js';

/**
 * Persistence interface for policy sets.
 * InMemoryPolicyStore in core; PostgresPolicyStore in server.
 */
export interface PolicyStore {
  save(policySet: PolicySet): Promise<void>;
  get(id: string): Promise<PolicySet | null>;
  list(filter?: { active?: boolean }): Promise<PolicySet[]>;
  delete(id: string): Promise<void>;
  /** Get version history for a policy set */
  getVersions(id: string): Promise<PolicySet[]>;
}
```

```typescript
// @dzipagent/core/src/security/policy/policy-translator.ts

/**
 * LLM-assisted natural language to policy translation.
 * This is an AUTHORING tool only -- it is never in the enforcement path.
 *
 * @example
 * ```ts
 * const translator = new PolicyTranslator(modelRegistry);
 * const rule = await translator.translate(
 *   'Agents with the codegen role can write files only under /workspace/src'
 * );
 * // Returns a PolicyRule that must be reviewed and approved by a human
 * // before being added to a PolicySet.
 * ```
 */
export interface PolicyTranslator {
  /**
   * Translate a natural language description into a PolicyRule.
   * The result MUST be reviewed by a human before activation.
   * Returns the rule plus a confidence score.
   */
  translate(description: string): Promise<{
    rule: import('./policy-types.js').PolicyRule;
    confidence: number;
    explanation: string;
  }>;

  /**
   * Explain a PolicyRule in natural language for human review.
   */
  explain(rule: import('./policy-types.js').PolicyRule): Promise<string>;
}
```

#### Integration with Existing RiskClassifier

The existing `RiskClassifier` becomes a convenience layer that translates its three-tier model into `PolicyRule` objects. Consumers who want fine-grained control use the `PolicyEvaluator` directly; consumers who want the simple tier model continue using `RiskClassifier` unchanged.

```typescript
// Backward-compatible bridge:
// RiskClassifier.classify() internally calls PolicyEvaluator.evaluate()
// and maps the decision back to a RiskTier.
```

#### New ForgeErrorCode

Add to `@dzipagent/core/src/errors/error-codes.ts`:

```typescript
| 'POLICY_DENIED'           // Policy engine denied the action
| 'POLICY_INVALID'          // Policy set failed validation
```

#### New DzipEvent Types

Add to `@dzipagent/core/src/events/event-types.ts`:

```typescript
| { type: 'policy:evaluated'; action: string; effect: 'allow' | 'deny'; ruleId?: string; durationUs: number }
| { type: 'policy:denied'; action: string; principal: string; reason: string }
| { type: 'policy:set_updated'; policySetId: string; version: number }
```

---

### F2: Runtime Safety Monitoring (P1, 8h)

#### Rationale

The current security scanning is point-in-time: content is checked on write (memory sanitizer) or on output (OutputPipeline). There is no continuous monitoring during agent execution to detect behavioral anomalies like repeated tool failures suggesting escalation attempts, gradual prompt injection across multiple turns, or unusual memory access patterns.

#### TypeScript Interfaces

```typescript
// @dzipagent/core/src/security/monitor/safety-monitor.ts

import type { DzipEventBus, DzipEvent } from '../../events/index.js';

/**
 * Severity levels for safety events.
 */
export type SafetySeverity = 'info' | 'warning' | 'critical' | 'emergency';

/**
 * Action to take when a safety violation is detected.
 */
export type SafetyAction = 'log' | 'warn' | 'block' | 'kill' | 'alert';

/**
 * A safety violation detected by the monitor.
 */
export interface SafetyViolation {
  /** Unique ID for this violation */
  readonly id: string;
  /** ISO timestamp of detection */
  readonly detectedAt: string;
  /** Category of the violation */
  readonly category: SafetyCategory;
  /** Severity assessment */
  readonly severity: SafetySeverity;
  /** Recommended action */
  readonly action: SafetyAction;
  /** Human-readable description */
  readonly description: string;
  /** The content or event that triggered the violation */
  readonly evidence: {
    readonly type: 'input' | 'output' | 'tool_call' | 'memory_write' | 'behavioral';
    readonly content?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  /** Agent and run context */
  readonly context: {
    readonly agentId?: string;
    readonly runId?: string;
    readonly turnNumber?: number;
  };
}

export type SafetyCategory =
  | 'prompt_injection'
  | 'pii_leak'
  | 'secret_leak'
  | 'harmful_content'
  | 'off_topic'
  | 'tool_abuse'
  | 'escalation_attempt'
  | 'memory_poisoning'
  | 'anomalous_behavior'
  | 'rate_limit_exceeded';

/**
 * Configuration for a safety scanning rule.
 */
export interface SafetyRule {
  readonly id: string;
  readonly category: SafetyCategory;
  readonly enabled: boolean;
  readonly severity: SafetySeverity;
  readonly action: SafetyAction;
  /** Custom scanning function. Return a violation description or null if safe. */
  readonly scan: (content: string, metadata?: Record<string, unknown>) => string | null;
}

/**
 * Configuration for the SafetyMonitor.
 */
export interface SafetyMonitorConfig {
  /** Custom rules to add beyond the built-in set */
  readonly customRules?: readonly SafetyRule[];

  /** Override default severity/action for built-in categories */
  readonly overrides?: Partial<Record<SafetyCategory, {
    severity?: SafetySeverity;
    action?: SafetyAction;
    enabled?: boolean;
  }>>;

  /** Behavioral anomaly detection thresholds */
  readonly behavioral?: {
    /** Max consecutive tool failures before flagging (default: 5) */
    readonly maxConsecutiveToolFailures?: number;
    /** Max identical tool calls in a window before flagging (default: 10) */
    readonly maxRepeatedToolCalls?: number;
    /** Window size in milliseconds for repeated call detection (default: 60_000) */
    readonly windowMs?: number;
  };
}

/**
 * Runtime safety monitor that attaches to DzipEventBus and
 * continuously scans agent activity for violations.
 *
 * The monitor is passive by default (logs violations). For 'block' and 'kill'
 * actions, it emits specific events that the agent tool-loop must honor.
 *
 * @example
 * ```ts
 * const monitor = createSafetyMonitor(eventBus, {
 *   overrides: {
 *     prompt_injection: { action: 'block', severity: 'critical' },
 *     pii_leak: { action: 'warn', severity: 'warning' },
 *   },
 *   behavioral: { maxConsecutiveToolFailures: 3 },
 * });
 *
 * // Monitor automatically subscribes to relevant DzipEvents.
 * // Call dispose() when done to unsubscribe.
 * monitor.dispose();
 * ```
 */
export interface SafetyMonitor {
  /**
   * Scan arbitrary content on demand (outside the event-driven flow).
   * Used for scanning user input before it enters the agent loop.
   */
  scanContent(
    content: string,
    type: 'input' | 'output' | 'memory_write',
    context?: { agentId?: string; runId?: string },
  ): SafetyViolation[];

  /**
   * Get all violations detected in the current session.
   */
  getViolations(): readonly SafetyViolation[];

  /**
   * Get violations filtered by severity.
   */
  getViolationsBySeverity(severity: SafetySeverity): readonly SafetyViolation[];

  /**
   * Reset the violation log and behavioral tracking state.
   */
  reset(): void;

  /**
   * Unsubscribe from all DzipEventBus events.
   */
  dispose(): void;
}

/**
 * Factory function. Creates a SafetyMonitor and subscribes it to the event bus.
 */
export declare function createSafetyMonitor(
  eventBus: DzipEventBus,
  config?: SafetyMonitorConfig,
): SafetyMonitor;
```

#### New DzipEvent Types

```typescript
| { type: 'safety:violation'; violation: SafetyViolation }
| { type: 'safety:blocked'; action: string; reason: string; agentId?: string; runId?: string }
| { type: 'safety:kill_requested'; agentId: string; runId: string; reason: string }
```

#### Built-in Scanning Rules

The `createSafetyMonitor` factory registers these rules by default:

1. **Prompt injection scanner** -- extends `memory-sanitizer.ts` patterns with multi-turn detection (tracks injection fragments across consecutive messages).
2. **PII leak scanner** -- wraps existing `detectPII()` for output content.
3. **Secret leak scanner** -- wraps existing `scanForSecrets()` for output content.
4. **Tool abuse detector** -- subscribes to `tool:called` and `tool:error` events, tracks consecutive failures and repeated identical calls.
5. **Escalation detector** -- tracks sequences of denied tool calls followed by attempts with different tool names targeting the same resource.
6. **Off-topic detector** -- optional, requires LLM call (disabled by default since we avoid LLM in enforcement path; can be enabled for non-blocking `log` severity).

---

### F3: Compliance Audit Trail (P1, 8h)

#### Rationale

DzipAgent currently has no persistent, tamper-evident record of security-relevant events. The `DzipEventBus` is ephemeral. For compliance with regulations (SOC2, GDPR, HIPAA), organizations need an immutable audit trail with integrity guarantees.

#### TypeScript Interfaces

```typescript
// @dzipagent/core/src/security/audit/audit-types.ts

/**
 * An immutable audit entry in the hash-chain log.
 *
 * Each entry contains the SHA-256 hash of the previous entry,
 * forming a tamper-evident chain. If any entry is modified,
 * the chain breaks and integrity verification fails.
 */
export interface AuditEntry {
  /** UUID v7 (time-ordered) for the entry */
  readonly id: string;

  /** ISO 8601 timestamp (UTC) */
  readonly timestamp: string;

  /** SHA-256 hash of the previous entry's canonical JSON (empty string for first entry) */
  readonly previousHash: string;

  /** SHA-256 hash of this entry's canonical JSON (excluding this field itself) */
  readonly hash: string;

  /** Who performed the action */
  readonly actor: {
    readonly id: string;
    readonly type: 'user' | 'agent' | 'service' | 'system';
    readonly name?: string;
  };

  /**
   * What action was performed.
   * Uses the same domain:operation format as the policy engine.
   */
  readonly action: string;

  /** What resource was acted upon */
  readonly resource?: {
    readonly type: string;
    readonly id?: string;
    readonly path?: string;
  };

  /** Result of the action */
  readonly result: 'success' | 'denied' | 'failed' | 'blocked';

  /** Policy decision that governed this action (if applicable) */
  readonly policyDecision?: {
    readonly effect: 'allow' | 'deny';
    readonly ruleId?: string;
    readonly policySetId?: string;
  };

  /** Additional structured metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;

  /** Agent and run context */
  readonly context?: {
    readonly agentId?: string;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly traceId?: string;
  };
}

/**
 * Retention policy for audit entries.
 */
export interface RetentionPolicy {
  /** Unique name for this retention policy */
  readonly name: string;
  /** Minimum retention period in days */
  readonly retentionDays: number;
  /** Regulation this policy satisfies */
  readonly regulation?: 'GDPR' | 'SOX' | 'HIPAA' | 'SOC2' | 'custom';
  /** Action when retention expires: 'archive' moves to cold storage, 'delete' removes */
  readonly expirationAction: 'archive' | 'delete';
  /** Filter -- which audit entries this policy applies to (all if omitted) */
  readonly filter?: {
    readonly actions?: readonly string[];
    readonly actorTypes?: readonly string[];
  };
}

/**
 * Filter for searching audit entries.
 */
export interface AuditFilter {
  readonly actorId?: string;
  readonly actorType?: 'user' | 'agent' | 'service' | 'system';
  readonly action?: string;
  /** Glob pattern for action matching */
  readonly actionPattern?: string;
  readonly result?: 'success' | 'denied' | 'failed' | 'blocked';
  readonly agentId?: string;
  readonly runId?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Result of an integrity verification check.
 */
export interface IntegrityCheckResult {
  readonly valid: boolean;
  /** Total entries checked */
  readonly entriesChecked: number;
  /** Index of first broken link (undefined if valid) */
  readonly brokenAt?: number;
  /** Entry ID where chain breaks (undefined if valid) */
  readonly brokenEntryId?: string;
  /** Expected vs actual hash at break point */
  readonly expectedHash?: string;
  readonly actualHash?: string;
}
```

```typescript
// @dzipagent/core/src/security/audit/audit-store.ts

import type {
  AuditEntry,
  AuditFilter,
  RetentionPolicy,
  IntegrityCheckResult,
} from './audit-types.js';

/**
 * Persistence interface for the audit trail.
 *
 * Implementations:
 * - InMemoryAuditStore (core) -- for dev/test, entries in a plain array
 * - PostgresAuditStore (server) -- append-only table with hash chain
 *
 * IMPORTANT: Implementations MUST NOT provide update or delete operations
 * on individual entries. The only mutation is append (write) and bulk
 * cleanup via retention policy application.
 */
export interface AuditStore {
  /**
   * Append an entry to the audit trail.
   * The store implementation computes the hash chain link.
   * Throws if the entry's previousHash does not match the last entry's hash.
   */
  append(entry: Omit<AuditEntry, 'id' | 'hash' | 'previousHash'>): Promise<AuditEntry>;

  /**
   * Retrieve a single entry by ID.
   */
  get(id: string): Promise<AuditEntry | null>;

  /**
   * Search entries with filters.
   * Results are ordered by timestamp descending (newest first).
   */
  search(filter: AuditFilter): Promise<readonly AuditEntry[]>;

  /**
   * Count entries matching a filter (for pagination).
   */
  count(filter?: AuditFilter): Promise<number>;

  /**
   * Verify the integrity of the hash chain.
   * Checks that each entry's previousHash matches the preceding entry's hash.
   *
   * @param startId - Start verification from this entry (default: first entry)
   * @param endId - End verification at this entry (default: last entry)
   */
  verifyIntegrity(startId?: string, endId?: string): Promise<IntegrityCheckResult>;

  /**
   * Apply retention policies. Entries older than the retention period
   * are archived or deleted based on the policy's expirationAction.
   *
   * @returns Number of entries affected
   */
  applyRetention(policies: readonly RetentionPolicy[]): Promise<number>;

  /**
   * Export entries matching a filter in a format suitable for SIEM ingestion.
   * Returns a readable stream of newline-delimited JSON (NDJSON).
   */
  export(filter: AuditFilter): AsyncIterable<string>;

  /**
   * Get the hash of the last entry in the chain (for chain continuity).
   */
  getLastHash(): Promise<string>;
}
```

```typescript
// @dzipagent/core/src/security/audit/audit-logger.ts

import type { DzipEventBus } from '../../events/index.js';
import type { AuditStore } from './audit-store.js';

/**
 * Bridges DzipEventBus events to the AuditStore.
 *
 * Subscribes to security-relevant events and writes audit entries.
 * This is the primary integration point -- consumers create an AuditLogger
 * and it automatically captures relevant activity.
 *
 * @example
 * ```ts
 * const auditStore = new InMemoryAuditStore();
 * const logger = new AuditLogger(eventBus, auditStore);
 *
 * // All relevant DzipEvents now automatically generate audit entries.
 * // To stop logging:
 * logger.dispose();
 * ```
 */
export interface AuditLogger {
  /**
   * Write a manual audit entry (for actions not covered by DzipEvents).
   */
  record(entry: Omit<AuditEntry, 'id' | 'hash' | 'previousHash' | 'timestamp'>): Promise<void>;

  /**
   * Stop listening to DzipEventBus events.
   */
  dispose(): void;
}
```

#### Events Automatically Captured

The `AuditLogger` subscribes to these DzipEvent types and creates audit entries:

| DzipEvent | Audit Action | Result |
|-----------|-------------|--------|
| `agent:started` | `agent:start` | `success` |
| `agent:completed` | `agent:complete` | `success` |
| `agent:failed` | `agent:complete` | `failed` |
| `tool:called` | `tool:{toolName}` | `success` |
| `tool:error` | `tool:{toolName}` | `failed` |
| `policy:denied` | `{action}` | `denied` |
| `safety:violation` | `safety:violation` | `blocked` |
| `safety:blocked` | `safety:block` | `blocked` |
| `approval:requested` | `approval:request` | `success` |
| `approval:granted` | `approval:grant` | `success` |
| `approval:rejected` | `approval:reject` | `success` |
| `memory:written` | `memory:write` | `success` |
| `policy:set_updated` | `policy:update` | `success` |

#### Drizzle Schema Addition

```typescript
// @dzipagent/server -- addition to drizzle-schema.ts

export const forgeAuditEntries = pgTable('forge_audit_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  previousHash: varchar('previous_hash', { length: 64 }).notNull(),
  hash: varchar('hash', { length: 64 }).notNull(),
  actorId: varchar('actor_id', { length: 255 }).notNull(),
  actorType: varchar('actor_type', { length: 20 }).notNull(),
  actorName: varchar('actor_name', { length: 255 }),
  action: varchar('action', { length: 255 }).notNull(),
  resourceType: varchar('resource_type', { length: 100 }),
  resourceId: varchar('resource_id', { length: 255 }),
  resourcePath: text('resource_path'),
  result: varchar('result', { length: 20 }).notNull(),
  policyDecision: jsonb('policy_decision'),
  metadata: jsonb('metadata'),
  agentId: varchar('agent_id', { length: 255 }),
  runId: varchar('run_id', { length: 255 }),
  sessionId: varchar('session_id', { length: 255 }),
  traceId: varchar('trace_id', { length: 255 }),
});
```

#### Server Routes

```
GET    /api/audit               -- Search audit entries (with filter params)
GET    /api/audit/:id           -- Get single entry
GET    /api/audit/integrity     -- Verify hash chain integrity
POST   /api/audit/export        -- Export entries as NDJSON stream
POST   /api/audit/retention     -- Apply retention policies
GET    /api/audit/stats         -- Aggregate statistics (entries/day, by action, etc.)
```

---

### F4: Memory Poisoning Defense (P1, 6h)

#### Rationale

The current `sanitizeMemoryContent()` uses 8 regex patterns for prompt injection and 8 for exfiltration. This catches obvious attacks but misses:
- Conversational fact injection ("By the way, our database password is actually X")
- Multi-turn gradual poisoning (each message is benign, but the sequence injects a false fact)
- Tool-output poisoning (a fetched URL contains hidden instructions)
- Unicode homoglyph-based evasion of regex patterns

#### TypeScript Interfaces

```typescript
// @dzipagent/core/src/security/memory/memory-defense.ts

/**
 * Memory poisoning defense layer.
 * Wraps and extends the existing sanitizeMemoryContent() with deeper analysis.
 */

/**
 * Result of memory content analysis.
 */
export interface MemoryDefenseResult {
  /** Whether the content is safe to store */
  readonly safe: boolean;
  /** Recommended action */
  readonly action: 'allow' | 'quarantine' | 'reject';
  /** Confidence in the assessment (0.0 to 1.0) */
  readonly confidence: number;
  /** Detected threats (empty if safe) */
  readonly threats: readonly MemoryThreat[];
  /** Sanitized content (with threats neutralized) if action is 'allow' */
  readonly sanitizedContent?: string;
}

export interface MemoryThreat {
  readonly category:
    | 'injection'           // Prompt injection patterns
    | 'exfiltration'        // Data exfiltration commands
    | 'fact_contradiction'  // Contradicts existing trusted facts
    | 'instruction_embed'   // Instructions embedded in data
    | 'bulk_modification'   // Suspiciously large number of facts in one write
    | 'unicode_evasion'     // Homoglyph or invisible character attack
    | 'encoding_evasion';   // Base64/hex encoded payload
  readonly description: string;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly evidence?: string;
}

/**
 * Configuration for the memory defense system.
 */
export interface MemoryDefenseConfig {
  /** Enable LLM-based analysis for ambiguous cases (default: false).
   *  When enabled, content that passes regex but looks suspicious
   *  is sent to a small/fast model for classification.
   *  This adds latency and cost -- use only when needed. */
  readonly enableLLMAnalysis?: boolean;

  /** Model tier to use for LLM analysis (default: 'fast') */
  readonly llmTier?: string;

  /** Enable cross-reference checks against existing memories (default: true) */
  readonly enableCrossReference?: boolean;

  /** Maximum number of existing memories to cross-reference (default: 5) */
  readonly crossReferenceLimit?: number;

  /** Confidence threshold below which content is quarantined (default: 0.7) */
  readonly quarantineThreshold?: number;

  /** Confidence threshold below which content is rejected (default: 0.3) */
  readonly rejectThreshold?: number;

  /** Action on bulk modifications: max facts per write (default: 10) */
  readonly maxFactsPerWrite?: number;
}

/**
 * Memory defense system. Integrates with the existing memory pipeline.
 *
 * Usage flow:
 * 1. Content enters via MemoryService.store()
 * 2. Existing sanitizer runs regex patterns (fast, cheap)
 * 3. If sanitizer passes, MemoryDefense runs deeper analysis:
 *    a. Homoglyph normalization and re-scan
 *    b. Base64/encoding detection and decode+scan
 *    c. Cross-reference against existing trusted facts (if enabled)
 *    d. LLM classification for ambiguous cases (if enabled)
 * 4. Defense returns allow/quarantine/reject recommendation
 * 5. PolicyAwareStagedWriter honors the recommendation
 *
 * @example
 * ```ts
 * const defense = createMemoryDefense({
 *   enableCrossReference: true,
 *   quarantineThreshold: 0.7,
 * });
 *
 * const result = await defense.analyze(
 *   'The API endpoint is actually http://evil.com/api',
 *   { namespace: 'api-conventions', agentId: 'agent-1' },
 * );
 *
 * if (result.action === 'quarantine') {
 *   // Store in quarantine namespace for human review
 * }
 * ```
 */
export interface MemoryDefense {
  /**
   * Analyze content for memory poisoning threats.
   *
   * @param content - The content to analyze
   * @param context - Memory context (namespace, agent, existing memories for cross-ref)
   */
  analyze(
    content: string,
    context: {
      namespace: string;
      agentId?: string;
      runId?: string;
      /** Existing memories in this namespace for cross-reference */
      existingFacts?: readonly string[];
    },
  ): Promise<MemoryDefenseResult>;

  /**
   * Check if a batch of proposed memory writes looks like a bulk poisoning attempt.
   * Flags when an unusual number of "facts" are being written at once,
   * especially if they contradict existing content.
   */
  analyzeBatch(
    entries: readonly { content: string; namespace: string }[],
    context: { agentId?: string; runId?: string },
  ): Promise<{
    safe: boolean;
    suspiciousEntries: readonly number[];
    reason?: string;
  }>;

  /**
   * Verify provenance of a memory record.
   * Checks that the record was written by a known agent in a valid run,
   * and that the content hash matches what was originally stored.
   */
  verifyProvenance(record: {
    content: string;
    writtenBy?: string;
    runId?: string;
    contentHash?: string;
  }): {
    verified: boolean;
    issues: readonly string[];
  };
}

export declare function createMemoryDefense(
  config?: MemoryDefenseConfig,
): MemoryDefense;
```

#### Integration with Existing Memory Pipeline

The `MemoryDefense` slots into the existing write path:

```
User message
  -> MemoryService.store()
    -> sanitizeMemoryContent()           [existing, fast regex]
    -> MemoryDefense.analyze()           [NEW, deeper analysis]
    -> PolicyAwareStagedWriter.capture() [existing, policy check]
    -> DualStreamWriter.write()          [existing, persistence]
```

The `PolicyAwareStagedWriter` already supports `reject` and `confirm-required` actions. The `MemoryDefense.analyze()` result maps directly:
- `action: 'allow'` -> `StagedWriter.capture()` with original confidence
- `action: 'quarantine'` -> `StagedWriter.capture()` with `confidence: 0` (forces human review)
- `action: 'reject'` -> `StagedWriter` returns rejected record

#### New DzipEvent Types

```typescript
| { type: 'memory:threat_detected'; namespace: string; category: string; severity: string; agentId?: string }
| { type: 'memory:quarantined'; namespace: string; key: string; reason: string }
```

---

### F5: Sandbox Hardening (P1, 6h)

#### Rationale

The existing `DockerSandbox` applies `--network=none`, `--read-only`, `--security-opt=no-new-privileges`, and resource limits. This is a solid baseline but lacks:
- Seccomp profiles to restrict system calls
- Filesystem ACLs beyond the blanket `--read-only`
- Network egress whitelisting (currently all-or-nothing)
- OOM detection and clean recovery
- Hard kill on execution time cap (currently relies on Node.js `timeout` which may not kill all child processes)
- Escape detection telemetry

#### TypeScript Interfaces

```typescript
// @dzipagent/codegen/src/sandbox/sandbox-hardening.ts

import type { DockerSandboxConfig } from './docker-sandbox.js';
import type { ExecResult } from './sandbox-protocol.js';

/**
 * Seccomp profile definitions for sandbox isolation.
 */
export type SeccompProfile =
  | 'default'     // Docker's default seccomp (reasonable baseline)
  | 'strict'      // Minimal syscalls: read, write, open, close, stat, mmap, brk, exit
  | 'nodejs'      // Tuned for Node.js: adds clone, futex, epoll_*, pipe, socket (loopback only)
  | 'custom';     // User-provided profile path

/**
 * Filesystem access control entry.
 */
export interface FilesystemACL {
  /** Path pattern (supports globs) */
  readonly path: string;
  /** Access mode */
  readonly mode: 'read' | 'write' | 'none';
}

/**
 * Network egress rule for sandboxed execution.
 */
export interface EgressRule {
  /** Hostname or IP (supports wildcards for subdomains: *.npmjs.org) */
  readonly host: string;
  /** Port (undefined = any) */
  readonly port?: number;
  /** Protocol (default: 'tcp') */
  readonly protocol?: 'tcp' | 'udp';
}

/**
 * Extended sandbox configuration with hardening options.
 */
export interface HardenedSandboxConfig extends DockerSandboxConfig {
  /** Seccomp profile to apply (default: 'nodejs') */
  readonly seccompProfile?: SeccompProfile;

  /** Path to custom seccomp JSON profile (required when seccompProfile is 'custom') */
  readonly seccompProfilePath?: string;

  /** Filesystem ACLs beyond the default read-only root */
  readonly filesystemACLs?: readonly FilesystemACL[];

  /** Network egress whitelist. Empty array = no network (like --network=none).
   *  Undefined = no network. At least one rule required to enable networking. */
  readonly egressRules?: readonly EgressRule[];

  /** Hard kill timeout in ms. Uses SIGKILL after this period.
   *  Set independently from the soft timeout which uses SIGTERM.
   *  Default: softTimeout + 5000 */
  readonly hardKillTimeoutMs?: number;

  /** Enable OOM detection and clean recovery (default: true) */
  readonly oomDetection?: boolean;

  /** Enable escape detection heuristics (default: true) */
  readonly escapeDetection?: boolean;

  /** PID limit inside the container (default: 256) */
  readonly pidLimit?: number;

  /** Disable all capabilities (default: true, adds --cap-drop=ALL) */
  readonly dropAllCapabilities?: boolean;

  /** Specific capabilities to add back (e.g., ['NET_BIND_SERVICE']) */
  readonly addCapabilities?: readonly string[];
}

/**
 * Extended exec result with security telemetry.
 */
export interface HardenedExecResult extends ExecResult {
  /** Whether the process was OOM-killed */
  readonly oomKilled: boolean;
  /** Peak memory usage in bytes (from cgroup stats) */
  readonly peakMemoryBytes?: number;
  /** Whether escape detection triggered */
  readonly escapeAttemptDetected: boolean;
  /** Suspicious syscalls detected (empty if none) */
  readonly suspiciousSyscalls: readonly string[];
  /** Whether the hard kill was used (SIGKILL after soft timeout) */
  readonly hardKilled: boolean;
}

/**
 * Hardened sandbox that extends DockerSandbox with security features.
 *
 * @example
 * ```ts
 * const sandbox = new HardenedDockerSandbox({
 *   image: 'node:20-slim',
 *   memoryLimit: '256m',
 *   cpuLimit: '0.5',
 *   seccompProfile: 'nodejs',
 *   filesystemACLs: [
 *     { path: '/workspace/src/**', mode: 'write' },
 *     { path: '/workspace/node_modules/**', mode: 'read' },
 *     { path: '/tmp/**', mode: 'write' },
 *   ],
 *   egressRules: [], // no network
 *   pidLimit: 128,
 *   hardKillTimeoutMs: 65_000,
 * });
 *
 * const result = await sandbox.execute('npm test');
 * if (result.oomKilled) {
 *   // Handle OOM gracefully
 * }
 * if (result.escapeAttemptDetected) {
 *   // Log security incident
 * }
 * ```
 */
export interface HardenedSandbox {
  execute(command: string, options?: import('./sandbox-protocol.js').ExecOptions): Promise<HardenedExecResult>;
  uploadFiles(files: Record<string, string>): Promise<void>;
  downloadFiles(paths: string[]): Promise<Record<string, string>>;
  cleanup(): Promise<void>;
  isAvailable(): Promise<boolean>;
  /** Get container resource stats (memory, CPU, PIDs) */
  getResourceStats(): Promise<{
    memoryUsageBytes: number;
    memoryLimitBytes: number;
    cpuUsagePercent: number;
    pidCount: number;
  } | null>;
}
```

#### Seccomp Profile for Node.js

The `nodejs` seccomp profile allows the minimum syscalls needed for Node.js execution:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    { "names": ["read", "write", "open", "openat", "close", "stat", "fstat", "lstat"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["poll", "lseek", "mmap", "mprotect", "munmap", "brk"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["rt_sigaction", "rt_sigprocmask", "ioctl", "access", "pipe", "pipe2"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["dup", "dup2", "dup3", "clone", "fork", "vfork", "execve"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["exit", "exit_group", "wait4", "kill", "getpid", "getppid"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["futex", "epoll_create", "epoll_create1", "epoll_ctl", "epoll_wait"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["getcwd", "chdir", "readlink", "readlinkat", "getdents64"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["fcntl", "ftruncate", "fsync", "fdatasync", "rename", "renameat2"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["mkdir", "mkdirat", "rmdir", "unlink", "unlinkat"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["socket", "connect", "bind", "listen", "accept4"], "action": "SCMP_ACT_ALLOW", "comment": "Required for Node.js IPC and loopback" },
    { "names": ["getsockname", "getpeername", "setsockopt", "getsockopt"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["sendto", "recvfrom", "sendmsg", "recvmsg"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["clock_gettime", "clock_getres", "nanosleep", "clock_nanosleep"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["madvise", "mremap", "set_robust_list", "get_robust_list"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["arch_prctl", "set_tid_address", "prctl", "prlimit64"], "action": "SCMP_ACT_ALLOW" },
    { "names": ["getrandom", "memfd_create", "eventfd2", "timerfd_create", "timerfd_settime"], "action": "SCMP_ACT_ALLOW" }
  ]
}
```

#### Docker Flag Mapping

| Config Field | Docker Flag |
|-------------|-------------|
| `seccompProfile: 'nodejs'` | `--security-opt=seccomp=/path/to/nodejs.json` |
| `dropAllCapabilities: true` | `--cap-drop=ALL` |
| `addCapabilities: ['NET_BIND_SERVICE']` | `--cap-add=NET_BIND_SERVICE` |
| `pidLimit: 128` | `--pids-limit=128` |
| `egressRules: []` | `--network=none` |
| `egressRules: [...]` | Custom network + iptables rules via entrypoint |
| `hardKillTimeoutMs` | Two-phase: `docker stop -t {soft}` then `docker kill` |

---

### F6: Cross-Agent Security (P2, 8h)

#### Rationale

In multi-agent orchestration (supervisor-worker, debate, pipeline), agents communicate by passing messages and sharing memory. Currently there is no authentication between agents -- any agent can invoke any other agent and access any namespace. This is acceptable for single-tenant local use but dangerous in production multi-tenant deployments.

#### TypeScript Interfaces

```typescript
// @dzipagent/agent/src/security/agent-auth.ts

/**
 * Agent-to-agent authentication and message integrity.
 */

/**
 * Agent credential containing a signing key pair.
 * Generated when an agent is created. The private key stays with the agent;
 * the public key is registered in the agent registry.
 */
export interface AgentCredential {
  /** Agent ID this credential belongs to */
  readonly agentId: string;
  /** Ed25519 public key (base64url encoded) */
  readonly publicKey: string;
  /** Ed25519 private key (base64url encoded). NEVER serialized to storage or logs. */
  readonly privateKey: string;
  /** Capabilities this agent is authorized to provide */
  readonly capabilities: readonly string[];
  /** When this credential was issued */
  readonly issuedAt: string;
  /** When this credential expires */
  readonly expiresAt: string;
}

/**
 * A signed message envelope for agent-to-agent communication.
 */
export interface SignedAgentMessage<T = unknown> {
  /** Message ID (UUID v7) */
  readonly id: string;
  /** Sender agent ID */
  readonly from: string;
  /** Recipient agent ID */
  readonly to: string;
  /** Message payload */
  readonly payload: T;
  /** ISO timestamp */
  readonly timestamp: string;
  /** Nonce for replay prevention (UUID v4) */
  readonly nonce: string;
  /** Ed25519 signature of canonical JSON(id + from + to + payload + timestamp + nonce) */
  readonly signature: string;
}

/**
 * Capability-based access control for agent interactions.
 *
 * Rather than broad role-based access, each agent declares capabilities
 * it provides and capabilities it requires from other agents.
 * Communication is only allowed when the caller's request matches
 * a capability the callee advertises.
 *
 * @example
 * ```ts
 * // Agent "code-reviewer" provides "review" capability
 * // Agent "code-generator" requires "review" from "code-reviewer"
 * // Agent "code-generator" CANNOT invoke "deploy" on "code-reviewer"
 * ```
 */
export interface CapabilityGrant {
  /** The capability being granted (e.g., "review", "generate", "deploy") */
  readonly capability: string;
  /** Which agent IDs can invoke this capability (empty = any authenticated agent) */
  readonly allowedCallers?: readonly string[];
  /** Rate limit: max invocations per minute (undefined = unlimited) */
  readonly rateLimit?: number;
}

/**
 * Agent authentication service.
 */
export interface AgentAuthService {
  /**
   * Generate a new credential for an agent.
   */
  generateCredential(agentId: string, capabilities: readonly string[]): Promise<AgentCredential>;

  /**
   * Sign a message with the agent's private key.
   */
  signMessage<T>(credential: AgentCredential, to: string, payload: T): SignedAgentMessage<T>;

  /**
   * Verify a signed message. Checks:
   * 1. Signature validity (Ed25519)
   * 2. Nonce uniqueness (replay prevention -- keeps a sliding window of seen nonces)
   * 3. Timestamp freshness (reject messages older than maxAgeMs, default 60s)
   * 4. Sender's public key is registered
   *
   * @returns The verified payload, or throws ForgeError with AGENT_AUTH_FAILED
   */
  verifyMessage<T>(message: SignedAgentMessage<T>): Promise<T>;

  /**
   * Check if agent A can invoke capability X on agent B.
   */
  checkCapability(callerId: string, calleeId: string, capability: string): Promise<boolean>;

  /**
   * Register an agent's public key and capabilities.
   */
  registerAgent(agentId: string, publicKey: string, capabilities: readonly CapabilityGrant[]): Promise<void>;

  /**
   * Revoke an agent's credentials (e.g., after compromise).
   */
  revokeCredential(agentId: string): Promise<void>;
}
```

```typescript
// @dzipagent/agent/src/security/data-classification-labels.ts

/**
 * Data classification labels for cross-agent memory sharing.
 * Applied to shared memory namespaces to control which agents can access what.
 */
export interface DataLabel {
  /** Classification level */
  readonly level: import('../../core-types.js').ClassificationLevel;
  /** Owning agent or team ID */
  readonly owner: string;
  /** Agent IDs allowed to read this data (empty = follows level-based rules) */
  readonly readers?: readonly string[];
  /** Agent IDs allowed to write this data (empty = owner only) */
  readonly writers?: readonly string[];
  /** Whether this data can be shared with agents at a lower classification level */
  readonly allowDowngrade: boolean;
}
```

#### New ForgeErrorCode

```typescript
| 'AGENT_AUTH_FAILED'       // Agent authentication failed (bad signature, expired, revoked)
| 'CAPABILITY_DENIED'       // Agent lacks capability to invoke target
| 'REPLAY_DETECTED'         // Duplicate nonce detected (replay attack)
```

#### New DzipEvent Types

```typescript
| { type: 'agent:auth_failed'; callerId: string; calleeId: string; reason: string }
| { type: 'agent:capability_denied'; callerId: string; calleeId: string; capability: string }
| { type: 'agent:replay_detected'; messageId: string; nonce: string }
```

---

### F7: Output Safety Filters (P1, 4h)

#### Rationale

The existing `OutputPipeline` supports PII redaction, secrets redaction, and a content-policy deny-list. Missing capabilities:
- Code injection prevention (detect `<script>`, SQL injection patterns, etc. in agent responses destined for end users)
- Harmful content filter (configurable sensitivity for different deployment contexts)
- Filter bypass for trusted contexts (internal agent-to-agent communication does not need PII redaction)
- Per-classification-level filtering (confidential data gets stronger redaction)

#### TypeScript Interfaces

```typescript
// @dzipagent/core/src/security/output/enhanced-output-pipeline.ts

import type { SanitizationStage, OutputPipelineConfig, PipelineResult } from '../output-pipeline.js';

/**
 * Trust level for output filtering.
 * Higher trust = fewer filters applied.
 */
export type OutputTrustLevel =
  | 'untrusted'    // User-facing output: all filters active
  | 'internal'     // Agent-to-agent: skip PII/secrets redaction
  | 'system';      // System internal: skip all content filters

/**
 * Code injection patterns to detect in agent responses.
 */
export interface CodeInjectionFilter extends SanitizationStage {
  readonly name: 'code-injection';
  /** Patterns to detect. Defaults include:
   *  - <script> tags
   *  - SQL injection (UNION SELECT, DROP TABLE, etc.)
   *  - Shell injection (;, &&, ||, backticks in non-code-block contexts)
   *  - LDAP injection
   *  - XSS payloads
   */
  readonly patterns?: readonly RegExp[];
  /** Action on detection: 'redact' replaces with placeholder, 'block' returns error */
  readonly onDetection?: 'redact' | 'block';
}

/**
 * Harmful content filter configuration.
 * Uses keyword/regex detection (not LLM) for deterministic enforcement.
 */
export interface HarmfulContentFilter extends SanitizationStage {
  readonly name: 'harmful-content';
  /** Sensitivity level. Higher = more aggressive filtering. */
  readonly sensitivity?: 'low' | 'medium' | 'high';
  /** Additional custom blocked patterns */
  readonly customPatterns?: readonly RegExp[];
  /** Categories to filter */
  readonly categories?: readonly HarmfulContentCategory[];
}

export type HarmfulContentCategory =
  | 'violence'
  | 'self_harm'
  | 'hate_speech'
  | 'sexual_content'
  | 'dangerous_instructions'
  | 'illegal_activity';

/**
 * Enhanced output pipeline configuration.
 */
export interface EnhancedOutputPipelineConfig extends OutputPipelineConfig {
  /** Trust level determines which filters are active (default: 'untrusted') */
  readonly trustLevel?: OutputTrustLevel;

  /** Enable code injection filter (default: true for 'untrusted') */
  readonly enableCodeInjection?: boolean;

  /** Enable harmful content filter (default: true for 'untrusted') */
  readonly enableHarmfulContent?: boolean;

  /** Harmful content sensitivity (default: 'medium') */
  readonly harmfulContentSensitivity?: 'low' | 'medium' | 'high';

  /** Data classification level for classification-aware filtering */
  readonly classificationLevel?: import('./data-classification.js').ClassificationLevel;
}

/**
 * Enhanced pipeline result with per-filter diagnostics.
 */
export interface EnhancedPipelineResult extends PipelineResult {
  /** Per-stage diagnostics */
  readonly diagnostics: readonly {
    readonly stageName: string;
    readonly detections: number;
    readonly durationMs: number;
  }[];
  /** Trust level applied */
  readonly trustLevel: OutputTrustLevel;
  /** Whether any filter blocked the output entirely (vs. just redacting) */
  readonly blocked: boolean;
  readonly blockReason?: string;
}

/**
 * Factory for creating an enhanced output pipeline.
 *
 * @example
 * ```ts
 * // User-facing pipeline with all filters
 * const userPipeline = createEnhancedPipeline({
 *   trustLevel: 'untrusted',
 *   enableCodeInjection: true,
 *   enableHarmfulContent: true,
 *   harmfulContentSensitivity: 'high',
 * });
 *
 * // Agent-to-agent pipeline with minimal filtering
 * const internalPipeline = createEnhancedPipeline({
 *   trustLevel: 'internal',
 * });
 * ```
 */
export declare function createEnhancedPipeline(
  config?: EnhancedOutputPipelineConfig,
): OutputPipeline;
```

#### Backward Compatibility

The existing `createDefaultPipeline()` continues to work unchanged. `createEnhancedPipeline()` is additive. The `OutputPipeline` class is extended, not replaced.

---

### F8: Incident Response (P2, 8h)

#### Rationale

When a security violation is detected (F2), there is no automated response system. Human operators must manually investigate and take action. For production deployments, we need automated incident response with playbooks for common scenarios.

#### TypeScript Interfaces

```typescript
// @dzipagent/server/src/security/incident/incident-types.ts

/**
 * A security incident tracked by the incident response system.
 */
export interface SecurityIncident {
  /** UUID v7 */
  readonly id: string;

  /** Current state of the incident */
  status: IncidentStatus;

  /** Severity assessment */
  readonly severity: 'low' | 'medium' | 'high' | 'critical';

  /** Incident category */
  readonly category: IncidentCategory;

  /** Human-readable title */
  readonly title: string;

  /** Detailed description */
  readonly description: string;

  /** ISO timestamp when incident was detected */
  readonly detectedAt: string;

  /** ISO timestamp when incident was acknowledged */
  acknowledgedAt?: string;

  /** ISO timestamp when incident was resolved */
  resolvedAt?: string;

  /** The safety violation(s) that triggered this incident */
  readonly triggerViolations: readonly string[];  // SafetyViolation IDs

  /** Affected resources */
  readonly affectedResources: readonly {
    readonly type: 'agent' | 'run' | 'memory_namespace' | 'api_key' | 'sandbox';
    readonly id: string;
  }[];

  /** Actions taken (automated and manual) */
  readonly actions: IncidentAction[];

  /** Root cause analysis (filled in during resolution) */
  rootCause?: string;

  /** Audit entry IDs related to this incident */
  readonly auditEntryIds: readonly string[];

  /** Metadata */
  readonly metadata?: Record<string, unknown>;
}

export type IncidentStatus = 'detected' | 'acknowledged' | 'investigating' | 'mitigated' | 'resolved' | 'closed';

export type IncidentCategory =
  | 'prompt_injection'
  | 'data_breach'
  | 'privilege_escalation'
  | 'sandbox_escape'
  | 'memory_poisoning'
  | 'agent_compromise'
  | 'rate_limit_abuse'
  | 'policy_violation';

/**
 * An action taken in response to an incident.
 */
export interface IncidentAction {
  readonly id: string;
  readonly type: IncidentActionType;
  readonly description: string;
  readonly executedAt: string;
  readonly executedBy: 'system' | string;  // 'system' for automated, user ID for manual
  readonly success: boolean;
  readonly error?: string;
}

export type IncidentActionType =
  | 'kill_agent'
  | 'revoke_credential'
  | 'quarantine_memory'
  | 'block_ip'
  | 'disable_api_key'
  | 'notify_admin'
  | 'snapshot_state'
  | 'rollback_memory'
  | 'escalate'
  | 'custom';

/**
 * A playbook defines automated response actions for a category of incidents.
 */
export interface IncidentPlaybook {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Which incident categories trigger this playbook */
  readonly triggerCategories: readonly IncidentCategory[];
  /** Minimum severity to trigger (default: 'medium') */
  readonly minSeverity: 'low' | 'medium' | 'high' | 'critical';
  /** Actions to execute in order */
  readonly actions: readonly PlaybookAction[];
  /** Whether to auto-execute or require human confirmation (default: false) */
  readonly autoExecute: boolean;
}

export interface PlaybookAction {
  readonly type: IncidentActionType;
  readonly config?: Record<string, unknown>;
  /** Delay in ms before executing this action (for escalation chains) */
  readonly delayMs?: number;
  /** Only execute if previous actions succeeded */
  readonly requiresPreviousSuccess?: boolean;
}
```

```typescript
// @dzipagent/server/src/security/incident/incident-manager.ts

import type { SecurityIncident, IncidentPlaybook, IncidentStatus, IncidentAction } from './incident-types.js';
import type { DzipEventBus } from '@dzipagent/core';
import type { AuditStore } from '@dzipagent/core';

/**
 * Incident response manager.
 *
 * Subscribes to safety:violation events from DzipEventBus,
 * creates SecurityIncident records, and executes playbooks.
 *
 * Lives in @dzipagent/server because it requires persistence
 * and may need to make HTTP calls (notifications, webhook alerts).
 *
 * @example
 * ```ts
 * const manager = new IncidentManager({
 *   eventBus,
 *   auditStore,
 *   incidentStore,
 *   playbooks: [
 *     {
 *       id: 'sandbox-escape-response',
 *       name: 'Sandbox Escape Response',
 *       triggerCategories: ['sandbox_escape'],
 *       minSeverity: 'high',
 *       autoExecute: true,
 *       actions: [
 *         { type: 'kill_agent' },
 *         { type: 'snapshot_state' },
 *         { type: 'notify_admin', config: { channel: '#security-alerts' } },
 *       ],
 *     },
 *   ],
 *   notificationWebhook: 'https://hooks.slack.com/...',
 * });
 * ```
 */
export interface IncidentManager {
  /** Get an incident by ID */
  getIncident(id: string): Promise<SecurityIncident | null>;

  /** List incidents with optional filters */
  listIncidents(filter?: {
    status?: IncidentStatus;
    category?: string;
    severity?: string;
    limit?: number;
  }): Promise<readonly SecurityIncident[]>;

  /** Manually acknowledge an incident */
  acknowledge(incidentId: string, acknowledgedBy: string): Promise<void>;

  /** Add a manual action to an incident */
  addAction(incidentId: string, action: Omit<IncidentAction, 'id' | 'executedAt'>): Promise<void>;

  /** Resolve an incident with root cause */
  resolve(incidentId: string, rootCause: string, resolvedBy: string): Promise<void>;

  /** Register a playbook */
  registerPlaybook(playbook: IncidentPlaybook): void;

  /** Execute a playbook manually against an incident */
  executePlaybook(incidentId: string, playbookId: string): Promise<void>;

  /** Stop listening to events */
  dispose(): void;
}
```

#### Server Routes

```
GET    /api/incidents            -- List incidents
GET    /api/incidents/:id        -- Get incident details
POST   /api/incidents/:id/ack    -- Acknowledge an incident
POST   /api/incidents/:id/action -- Add manual action
POST   /api/incidents/:id/resolve -- Resolve with root cause
GET    /api/playbooks            -- List playbooks
POST   /api/playbooks            -- Register a playbook
POST   /api/incidents/:id/playbook/:playbookId -- Execute playbook
```

---

### F9: Data Classification (P2, 4h)

#### Rationale

Not all data is equal. Agent memories containing API credentials need stronger protection than memories about code style preferences. A formal classification system enables classification-aware access control, encryption requirements, and output filtering.

#### TypeScript Interfaces

```typescript
// @dzipagent/core/src/security/classification/data-classification.ts

/**
 * Data classification levels, ordered from least to most sensitive.
 */
export type ClassificationLevel =
  | 'public'        // Can be shared with anyone, including external systems
  | 'internal'      // Shared within the organization but not externally
  | 'confidential'  // Restricted to specific agents/roles; contains business-sensitive data
  | 'restricted';   // Highest sensitivity; PII, secrets, credentials; encrypted at rest

/**
 * Classification metadata attached to a memory record or data flow.
 */
export interface ClassificationLabel {
  /** Classification level */
  readonly level: ClassificationLevel;
  /** When the classification was assigned */
  readonly classifiedAt: string;
  /** How the classification was determined */
  readonly classifiedBy: 'auto' | 'manual' | string;
  /** Reason for the classification */
  readonly reason?: string;
  /** Override: allow specific agents to access despite classification */
  readonly exemptions?: readonly string[];
}

/**
 * Rules for auto-classifying content based on its characteristics.
 */
export interface ClassificationRule {
  readonly id: string;
  readonly level: ClassificationLevel;
  /** Content patterns that trigger this classification (any match) */
  readonly patterns: readonly RegExp[];
  /** Namespace patterns that always get this classification */
  readonly namespacePatterns?: readonly string[];
  /** Priority (higher = overrides lower-priority rules) */
  readonly priority: number;
}

/**
 * Security requirements per classification level.
 */
export interface ClassificationPolicy {
  readonly level: ClassificationLevel;
  /** Whether data at this level must be encrypted at rest */
  readonly encryptAtRest: boolean;
  /** Whether data at this level must be encrypted in transit */
  readonly encryptInTransit: boolean;
  /** Minimum role required to access data at this level */
  readonly minimumRole: 'viewer' | 'operator' | 'admin';
  /** Whether audit logging is required for access to data at this level */
  readonly auditRequired: boolean;
  /** Retention period in days (undefined = no limit) */
  readonly retentionDays?: number;
  /** Output filter strength for responses containing this data */
  readonly outputFilterStrength: 'none' | 'standard' | 'strict';
}

/**
 * Data classifier that assigns classification labels to content.
 *
 * @example
 * ```ts
 * const classifier = createDataClassifier({
 *   rules: [
 *     { id: 'pii', level: 'restricted', patterns: [/\b\d{3}-\d{2}-\d{4}\b/], priority: 100 },
 *     { id: 'api-keys', level: 'restricted', patterns: [/\bsk-[a-zA-Z0-9]{48}\b/], priority: 100 },
 *     { id: 'internal-apis', level: 'confidential', namespacePatterns: ['api-*'], priority: 50 },
 *   ],
 *   defaultLevel: 'internal',
 * });
 *
 * const label = classifier.classify('User SSN is 123-45-6789', 'user-data');
 * // label.level === 'restricted'
 * ```
 */
export interface DataClassifier {
  /**
   * Classify content and return a label.
   * Evaluates all rules and returns the highest-priority matching level.
   */
  classify(content: string, namespace?: string): ClassificationLabel;

  /**
   * Check if a principal can access data at a given classification level.
   */
  canAccess(
    principalRoles: readonly string[],
    level: ClassificationLevel,
    exemptions?: readonly string[],
  ): boolean;

  /**
   * Get the security policy for a classification level.
   */
  getPolicy(level: ClassificationLevel): ClassificationPolicy;
}

export declare function createDataClassifier(config: {
  rules: readonly ClassificationRule[];
  defaultLevel?: ClassificationLevel;
  policies?: Partial<Record<ClassificationLevel, Partial<ClassificationPolicy>>>;
}): DataClassifier;
```

#### Default Classification Policies

| Level | Encrypt at Rest | Encrypt in Transit | Min Role | Audit Required | Output Filter |
|-------|----------------|-------------------|----------|---------------|---------------|
| `public` | No | No | `viewer` | No | `none` |
| `internal` | No | Yes | `viewer` | No | `standard` |
| `confidential` | Yes | Yes | `operator` | Yes | `standard` |
| `restricted` | Yes | Yes | `admin` | Yes | `strict` |

---

### F10: Security Testing Framework (P2, 8h)

#### Rationale

Security features are only as strong as the tests that validate them. We need adversarial test suites that actively try to break DzipAgent's security layers, plus regression tests to prevent security regressions in CI.

#### TypeScript Interfaces

```typescript
// @dzipagent/testing/src/security/security-test-suite.ts

/**
 * A security test case that attempts to exploit a specific vulnerability.
 */
export interface SecurityTestCase {
  readonly id: string;
  readonly name: string;
  readonly category: SecurityTestCategory;
  /** Description of the attack being simulated */
  readonly description: string;
  /** The attack payload or scenario */
  readonly attack: SecurityAttack;
  /** Expected behavior: the system should block/detect/quarantine */
  readonly expectedResult: SecurityTestExpectation;
}

export type SecurityTestCategory =
  | 'prompt_injection'
  | 'memory_poisoning'
  | 'privilege_escalation'
  | 'sandbox_escape'
  | 'cross_agent_attack'
  | 'data_exfiltration'
  | 'output_manipulation'
  | 'policy_bypass';

export interface SecurityAttack {
  readonly type: 'message' | 'tool_call' | 'memory_write' | 'agent_message' | 'code_execution';
  /** The payload content */
  readonly payload: string;
  /** Additional context (tool args, namespace, etc.) */
  readonly context?: Record<string, unknown>;
  /** Multiple-step attacks: sequence of payloads */
  readonly sequence?: readonly { payload: string; delay?: number }[];
}

export interface SecurityTestExpectation {
  /** Should the attack be blocked? */
  readonly blocked: boolean;
  /** Should a safety violation be detected? */
  readonly violationDetected: boolean;
  /** Expected violation category (if detected) */
  readonly expectedCategory?: string;
  /** Should an audit entry be created? */
  readonly auditEntryCreated: boolean;
  /** Should an incident be created? */
  readonly incidentCreated?: boolean;
  /** Expected minimum severity if violation detected */
  readonly minSeverity?: 'info' | 'warning' | 'critical' | 'emergency';
}

/**
 * Security test runner that executes test cases against a DzipAgent instance.
 *
 * @example
 * ```ts
 * const runner = new SecurityTestRunner({
 *   agent: testAgent,
 *   eventBus,
 *   auditStore,
 *   safetyMonitor,
 * });
 *
 * // Run built-in prompt injection test suite
 * const results = await runner.runSuite('prompt_injection');
 *
 * // Run all suites
 * const allResults = await runner.runAll();
 *
 * // Assert no regressions
 * expect(allResults.every(r => r.passed)).toBe(true);
 * ```
 */
export interface SecurityTestRunner {
  /**
   * Run all test cases in a specific category.
   */
  runSuite(category: SecurityTestCategory): Promise<readonly SecurityTestResult[]>;

  /**
   * Run all security test suites.
   */
  runAll(): Promise<readonly SecurityTestResult[]>;

  /**
   * Run a single test case.
   */
  runTest(testCase: SecurityTestCase): Promise<SecurityTestResult>;

  /**
   * Add custom test cases.
   */
  addTestCases(cases: readonly SecurityTestCase[]): void;

  /**
   * Generate a security test report.
   */
  generateReport(results: readonly SecurityTestResult[]): SecurityTestReport;
}

export interface SecurityTestResult {
  readonly testId: string;
  readonly testName: string;
  readonly category: SecurityTestCategory;
  readonly passed: boolean;
  readonly durationMs: number;
  /** What actually happened */
  readonly actual: {
    readonly blocked: boolean;
    readonly violationDetected: boolean;
    readonly violationCategory?: string;
    readonly auditEntryCreated: boolean;
    readonly incidentCreated: boolean;
    readonly severity?: string;
  };
  /** Diff from expected (empty if passed) */
  readonly failures: readonly string[];
}

export interface SecurityTestReport {
  readonly timestamp: string;
  readonly totalTests: number;
  readonly passed: number;
  readonly failed: number;
  readonly byCategory: Record<SecurityTestCategory, { total: number; passed: number; failed: number }>;
  readonly regressions: readonly string[];  // Test IDs that previously passed but now fail
  readonly results: readonly SecurityTestResult[];
}
```

#### Built-in Test Suites

**Prompt Injection Suite** (30+ test cases):
- Direct injection: "ignore previous instructions"
- Indirect injection: instructions hidden in fetched content
- Multilingual injection (non-English instructions)
- Unicode homoglyph evasion
- Base64-encoded payloads
- Split injection across multiple turns
- Persona hijacking: "you are now a..."
- Context manipulation: "the system prompt says..."

**Memory Poisoning Suite** (20+ test cases):
- Direct fact injection
- Gradual truth-shifting sequences
- Contradicting existing trusted facts
- Bulk fact injection
- Invisible Unicode in memory content
- Tool-output-based poisoning

**Privilege Escalation Suite** (15+ test cases):
- Invoking require-approval tools directly
- Tool aliasing to bypass classification
- Chaining safe tools to achieve unsafe effect
- MCP tool bridge bypass attempts
- Policy condition evasion

**Cross-Agent Attack Suite** (10+ test cases):
- Spoofed agent messages (wrong signature)
- Replay attacks (duplicate nonce)
- Capability escalation (invoke unauthorized capability)
- Cross-namespace memory access

---

## 4. Data Flow Diagrams

### 4.1 Policy Evaluation Flow

```
Caller (user/agent/system)
  |
  v
[Build PolicyContext]
  principal: { id, type, roles }
  action: { name, args }
  resource: { id, type, path }
  environment: { timestamp, costCents, ... }
  |
  v
[PolicyEvaluator.evaluate(context)]
  |
  +---> For each PolicySet:
  |       For each Rule in set:
  |         1. Match principal filter?  ---NO---> skip
  |         2. Match action filter?     ---NO---> skip
  |         3. Match resource filter?   ---NO---> skip
  |         4. All conditions true?     ---NO---> skip
  |         5. Rule matches -> collect { ruleId, setId, effect }
  |
  +---> Apply deny-overrides:
  |       Any DENY match? --> effect = 'deny'
  |       Any ALLOW match? --> effect = 'allow'
  |       No matches? --> effect = 'deny' (default-deny)
  |
  v
[PolicyDecision]
  |
  +--> emit DzipEvent: policy:evaluated
  |
  +--> if DENY: emit policy:denied
  |              write AuditEntry(result: 'denied')
  |              throw ForgeError(POLICY_DENIED)
  |
  +--> if ALLOW: write AuditEntry(result: 'success')
                 proceed with action
```

### 4.2 Audit Trail Write Flow

```
Security-relevant event occurs
  |
  v
[AuditLogger receives DzipEvent]
  |
  v
[Build AuditEntry]
  actor, action, resource, result, metadata, context
  |
  v
[AuditStore.getLastHash()]
  |
  v
[Compute hash chain]
  previousHash = lastEntry.hash (or "" for first)
  payload = canonical JSON of (timestamp, actor, action, resource, result, ...)
  hash = SHA-256(previousHash + payload)
  |
  v
[AuditStore.append(entry)]
  |
  +--> PostgresAuditStore: INSERT into forge_audit_entries
  |    (append-only, no UPDATE/DELETE on individual rows)
  |
  +--> InMemoryAuditStore: push to array
  |
  v
[Return AuditEntry with id, hash, previousHash]
```

### 4.3 Safety Monitoring Pipeline

```
DzipEventBus
  |
  +---> tool:called ---------> [Tool Abuse Detector]
  |                              - Track consecutive failures
  |                              - Track repeated identical calls
  |                              - Track denied-then-retry patterns
  |
  +---> tool:error ----------> [Escalation Detector]
  |                              - Denied tool -> different tool -> same resource?
  |
  +---> memory:written ------> [Memory Integrity Scanner]
  |                              - Run content through MemoryDefense.analyze()
  |
  +---> agent:started -------> [Session Tracker]
  |     agent:completed         - Track per-agent behavioral baselines
  |
  +---> (direct call) -------> [Input/Output Scanner]
  |     scanContent()            - Prompt injection patterns
  |                              - PII/secrets detection
  |                              - Harmful content matching
  |
  +---> All violations ------> [SafetyViolation]
                                  |
                                  +--> emit safety:violation
                                  |
                                  +--> if action == 'block':
                                  |      emit safety:blocked
                                  |
                                  +--> if action == 'kill':
                                         emit safety:kill_requested
```

### 4.4 Incident Response Flow

```
safety:violation event
  |
  v
[IncidentManager]
  |
  +--> Assess severity
  |    (from SafetyViolation.severity)
  |
  +--> Create SecurityIncident
  |    status: 'detected'
  |    write to IncidentStore
  |
  +--> Match Playbooks
  |    (by category + minSeverity)
  |
  +--> For each matching playbook:
       |
       +--> if autoExecute:
       |      Execute actions sequentially:
       |        kill_agent -> snapshot_state -> notify_admin
       |      Record each IncidentAction
       |      Update incident status -> 'mitigated'
       |
       +--> if !autoExecute:
              emit incident:pending_action
              Wait for human via:
                POST /api/incidents/:id/playbook/:playbookId
```

---

## 5. File Structure

### Extensions to `@dzipagent/core/src/security/`

```
core/src/security/
  index.ts                          # MODIFY: add new exports
  secrets-scanner.ts                # existing, no changes
  pii-detector.ts                   # existing, no changes
  output-pipeline.ts                # existing, no changes
  risk-classifier.ts                # MODIFY: bridge to PolicyEvaluator
  tool-permission-tiers.ts          # existing, no changes
  policy/                           # NEW directory
    index.ts
    policy-types.ts                 # PolicyRule, PolicySet, PolicyContext, PolicyDecision
    policy-evaluator.ts             # PolicyEvaluator implementation (~200 LOC)
    policy-store.ts                 # PolicyStore interface
    in-memory-policy-store.ts       # InMemoryPolicyStore (~60 LOC)
    policy-translator.ts            # PolicyTranslator interface (impl in server)
    condition-evaluator.ts          # Pure-function condition matching (~120 LOC)
  monitor/                          # NEW directory
    index.ts
    safety-monitor.ts               # SafetyMonitor implementation (~250 LOC)
    safety-types.ts                 # SafetyViolation, SafetyRule, etc.
    builtin-rules.ts                # Default scanning rules (~150 LOC)
    behavioral-tracker.ts           # Tool-usage pattern tracking (~100 LOC)
  audit/                            # NEW directory
    index.ts
    audit-types.ts                  # AuditEntry, RetentionPolicy, etc.
    audit-store.ts                  # AuditStore interface
    audit-logger.ts                 # AuditLogger (event bus -> audit store) (~120 LOC)
    in-memory-audit-store.ts        # InMemoryAuditStore (~100 LOC)
    hash-chain.ts                   # SHA-256 hash chain utilities (~40 LOC)
  classification/                   # NEW directory
    index.ts
    data-classification.ts          # ClassificationLevel, DataClassifier, etc.
    default-rules.ts                # Built-in classification rules (~60 LOC)
  memory/                           # NEW directory
    index.ts
    memory-defense.ts               # MemoryDefense implementation (~200 LOC)
    homoglyph-normalizer.ts         # Unicode normalization for evasion detection (~80 LOC)
    encoding-detector.ts            # Base64/hex payload detection (~60 LOC)
  output/                           # NEW directory
    index.ts
    enhanced-output-pipeline.ts     # EnhancedOutputPipeline factory (~120 LOC)
    code-injection-filter.ts        # Code injection detection (~80 LOC)
    harmful-content-filter.ts       # Harmful content regex matching (~100 LOC)
```

### Extensions to `@dzipagent/codegen/src/sandbox/`

```
codegen/src/sandbox/
  sandbox-protocol.ts               # existing, no changes
  docker-sandbox.ts                 # existing, no changes
  mock-sandbox.ts                   # existing, no changes
  hardened-sandbox.ts               # NEW: HardenedDockerSandbox (~300 LOC)
  seccomp-profiles/                 # NEW directory
    default.json
    strict.json
    nodejs.json
  escape-detector.ts                # NEW: Heuristic escape detection (~80 LOC)
```

### Extensions to `@dzipagent/agent/src/`

```
agent/src/security/                 # NEW directory
  index.ts
  agent-auth.ts                     # AgentAuthService implementation (~200 LOC)
  data-classification-labels.ts     # DataLabel for cross-agent sharing (~30 LOC)
```

### Extensions to `@dzipagent/server/src/`

```
server/src/
  persistence/
    drizzle-schema.ts               # MODIFY: add forge_audit_entries, forge_incidents tables
    postgres-audit-store.ts          # NEW: PostgresAuditStore (~150 LOC)
    postgres-incident-store.ts       # NEW: PostgresIncidentStore (~120 LOC)
    postgres-policy-store.ts         # NEW: PostgresPolicyStore (~100 LOC)
  routes/
    audit.ts                         # NEW: Audit API routes (~80 LOC)
    incidents.ts                     # NEW: Incident API routes (~100 LOC)
    policies.ts                      # NEW: Policy management routes (~80 LOC)
  security/
    incident/
      incident-types.ts              # SecurityIncident, IncidentPlaybook types
      incident-manager.ts            # IncidentManager implementation (~250 LOC)
      default-playbooks.ts           # Built-in playbooks (~60 LOC)
    policy-translator-impl.ts        # LLM-based PolicyTranslator (~120 LOC)
```

### Extensions to `@dzipagent/testing/src/`

```
testing/src/security/               # NEW directory
  index.ts
  security-test-suite.ts            # SecurityTestRunner implementation (~200 LOC)
  test-cases/
    prompt-injection.ts              # 30+ test cases (~300 LOC)
    memory-poisoning.ts              # 20+ test cases (~200 LOC)
    privilege-escalation.ts          # 15+ test cases (~150 LOC)
    cross-agent.ts                   # 10+ test cases (~100 LOC)
    sandbox-escape.ts                # 10+ test cases (~100 LOC)
```

### Total New Code Estimate

| Area | Files | ~LOC |
|------|-------|------|
| Policy Engine (core) | 7 | ~580 |
| Safety Monitor (core) | 5 | ~500 |
| Audit Trail (core + server) | 9 | ~590 |
| Memory Defense (core) | 4 | ~340 |
| Sandbox Hardening (codegen) | 4 | ~380 |
| Cross-Agent Security (agent) | 3 | ~230 |
| Output Filters (core) | 4 | ~300 |
| Incident Response (server) | 5 | ~530 |
| Data Classification (core) | 3 | ~160 |
| Security Tests (testing) | 7 | ~1,050 |
| **Total** | **~51 files** | **~4,660 LOC** |

---

## 6. Testing Strategy

### 6.1 Unit Tests

Every security component gets comprehensive unit tests:

| Component | Test Focus | Min Coverage |
|-----------|-----------|-------------|
| PolicyEvaluator | Rule matching, condition evaluation, deny-overrides, default-deny, expired rules | 95% |
| ConditionEvaluator | Every operator (eq, neq, gt, gte, lt, lte, in, not_in, contains, glob, regex) | 100% |
| SafetyMonitor | Each built-in rule, behavioral tracking, event subscription/unsubscription | 90% |
| AuditStore (InMemory) | Append, search, integrity verification, retention, export | 95% |
| HashChain | Chain creation, integrity verification, tamper detection | 100% |
| MemoryDefense | Homoglyph normalization, encoding detection, cross-reference, batch analysis | 90% |
| DataClassifier | Rule matching, priority ordering, access control, policy lookup | 95% |
| HardenedSandbox | Docker flag generation, OOM detection, config validation | 85% |
| AgentAuthService | Key generation, signing, verification, replay detection, capability checks | 95% |
| OutputFilters | Code injection patterns, harmful content patterns, trust-level filtering | 90% |

### 6.2 Adversarial Testing

The `SecurityTestRunner` (F10) is the primary adversarial testing tool. It runs in CI as part of the test suite:

```yaml
# .github/workflows/security-tests.yml
name: Security Tests
on: [push, pull_request]
jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run test:security
      - run: npm run test:security:report
        if: always()
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: security-report
          path: reports/security-test-report.json
```

### 6.3 Performance Impact Testing

Security features add overhead. We measure and enforce budgets:

| Security Layer | Max Latency Budget | Measurement |
|---------------|-------------------|-------------|
| Policy evaluation (per call) | < 1ms | Benchmark in unit tests |
| Safety monitor input scan | < 5ms | Benchmark per 1K chars |
| Safety monitor output scan | < 5ms | Benchmark per 1K chars |
| Memory defense analysis (no LLM) | < 10ms | Benchmark per memory write |
| Memory defense analysis (with LLM) | < 500ms | Benchmark with mock model |
| Audit entry write (InMemory) | < 0.1ms | Benchmark |
| Audit entry write (Postgres) | < 5ms | Integration test |
| Output pipeline (all filters) | < 10ms | Benchmark per 10K chars |

### 6.4 Integration Tests

- **End-to-end policy enforcement**: Create agent with policies, attempt blocked action, verify denial + audit entry + event emission.
- **Audit chain integrity**: Write 1000 entries, verify integrity, tamper with one entry, verify integrity fails at correct position.
- **Safety monitor + incident response**: Trigger a safety violation, verify incident creation, verify playbook execution.
- **Memory defense + staged writer**: Write poisoned content, verify quarantine, verify human review flow.
- **Cross-agent auth**: Two agents communicate with signed messages, verify signature validation, test replay rejection.

### 6.5 Regression Tracking

The security test report includes a `regressions` field that compares results against a baseline file (`security-baseline.json`). If a test that previously passed now fails, the CI pipeline fails with a clear regression report. This prevents accidental security regressions during development.

---

## 7. Migration Path

### Phase 1 (Weeks 1-2): Core Security Primitives

**No breaking changes.** All additions are new exports from `@dzipagent/core/security`.

1. Implement `PolicyEvaluator` and `PolicyRule` types (F1 core)
2. Implement `InMemoryPolicyStore` (F1 storage)
3. Implement `SafetyMonitor` and built-in rules (F2)
4. Implement `AuditStore` interface and `InMemoryAuditStore` (F3 core)
5. Implement `AuditLogger` event-bus bridge (F3 integration)
6. Implement `MemoryDefense` without LLM analysis (F4 core)

**Adoption**: Consumers opt-in by creating a `PolicyEvaluator` and/or `SafetyMonitor`. Existing code works unchanged.

### Phase 2 (Weeks 3-4): Server Integration

7. Add `PostgresAuditStore` to `@dzipagent/server` (F3 server)
8. Add audit, policy, and incident routes (F3, F1, F8 server)
9. Implement `IncidentManager` and default playbooks (F8)
10. Implement `DataClassifier` (F9)
11. Implement enhanced output filters (F7)

### Phase 3 (Weeks 5-6): Advanced Features

12. Implement `HardenedDockerSandbox` (F5)
13. Implement `AgentAuthService` with Ed25519 signing (F6)
14. Implement `PolicyTranslator` with LLM-assisted authoring (F1 server)
15. Add LLM-based analysis mode to `MemoryDefense` (F4 advanced)
16. Implement `SecurityTestRunner` and all built-in test suites (F10)

### Backward Compatibility

- `RiskClassifier` continues to work unchanged. The `PolicyEvaluator` is an additional layer, not a replacement. Consumers who want the simple three-tier model keep using `RiskClassifier`.
- `OutputPipeline` and `createDefaultPipeline()` are unchanged. `createEnhancedPipeline()` is additive.
- `sanitizeMemoryContent()` continues to work as the fast first-pass check. `MemoryDefense` is an additional deeper analysis layer.
- `DockerSandbox` is not modified. `HardenedDockerSandbox` is a new class that extends it.
- No existing exports are removed or renamed.

---

## 8. ADR Log

### ADR-SEC-001: JSON-Based Policy Language

**Status:** Proposed

**Context:** We need a policy definition format for the zero-trust engine. Options considered: (A) Cedar language with parser, (B) Rego/OPA integration, (C) Custom JSON-based rules.

**Decision:** JSON-based rules (option C). Cedar is well-designed but adds a parser dependency and learning curve. OPA requires a separate sidecar process. JSON rules are machine-readable, storable in any database, manipulable with standard tools, and validated with Zod schemas. For human authoring, we provide an LLM-assisted translator (F1) that converts natural language to JSON rules.

**Consequences:**
- Positive: No new parser dependency, trivial serialization, Zod validation, LLM-assisted authoring.
- Negative: Less expressive than Cedar (no entity hierarchies, no template slots). If complex policies are needed in the future, we may need to revisit.
- Risk: JSON rules may become unwieldy at scale (100+ rules). Mitigated by PolicySets with priority ordering.

### ADR-SEC-002: Deny-Overrides Conflict Resolution

**Status:** Proposed

**Context:** When multiple policy rules match a request, we need a conflict resolution strategy. Options: (A) Deny-overrides (any DENY wins), (B) Allow-overrides (any ALLOW wins), (C) Priority-based (highest-priority rule wins).

**Decision:** Deny-overrides (option A). This follows the principle of least privilege and matches AWS IAM and Cedar semantics. If any rule explicitly denies an action, it cannot be overridden by an ALLOW rule. This prevents accidental over-permissioning.

**Consequences:**
- Positive: Safest default. Prevents "ALLOW *" rules from accidentally overriding security-critical denials.
- Negative: Can be surprising when adding a new DENY rule blocks something that was previously allowed by a different PolicySet. Mitigated by the `PolicyDecision.matchedRules` field which shows exactly which rules applied.

### ADR-SEC-003: Hash-Chain Audit Trail

**Status:** Proposed

**Context:** The audit trail needs tamper-evidence. Options: (A) Simple append-only log, (B) Hash chain (each entry links to previous), (C) Merkle tree, (D) External blockchain.

**Decision:** Hash chain (option B). A hash chain provides tamper-evidence with minimal complexity. Each entry includes the SHA-256 hash of the previous entry, forming a verifiable chain. Merkle trees add complexity without proportional benefit for sequential logs. External blockchain adds operational burden and latency.

**Consequences:**
- Positive: Tamper-evident, simple to implement, fast to verify (O(n) sequential scan), no external dependencies.
- Negative: Single-chain means integrity verification is O(n). For very large audit logs (millions of entries), verification may take seconds. Mitigated by supporting range-based verification (startId to endId) and periodic checkpointing.
- Risk: Hash chain breaks if entries are written concurrently without serialization. The `AuditStore.append()` implementation MUST serialize writes (use database row-level locking in PostgresAuditStore).

### ADR-SEC-004: No LLM in Policy Enforcement

**Status:** Proposed

**Context:** LLMs could provide more nuanced policy evaluation (e.g., "does this tool call seem reasonable given the conversation?"). However, LLMs are non-deterministic, add latency, and can themselves be manipulated.

**Decision:** Policy enforcement is strictly deterministic with no LLM involvement. LLMs are used only for policy authoring (natural language to JSON translation) and for optional memory defense analysis (F4, disabled by default). The enforcement path is: structured context in, boolean decision out, computed by pure functions.

**Consequences:**
- Positive: Deterministic, fast (sub-millisecond), cannot be prompt-injected, auditable, testable.
- Negative: Less nuanced than LLM-based evaluation. May produce false positives/negatives for edge cases.
- Risk: Operators may need many fine-grained rules to express complex policies. Mitigated by condition operators (glob, regex) and the LLM-assisted authoring tool.

### ADR-SEC-005: Ed25519 for Agent Authentication

**Status:** Proposed

**Context:** Cross-agent messages need signing for integrity and authentication. Options: (A) HMAC with shared secret, (B) Ed25519 signatures, (C) mTLS certificates.

**Decision:** Ed25519 signatures (option B). Each agent gets a key pair at creation time. The private key is used to sign messages; the public key is registered in the agent registry for verification. Ed25519 is fast (sign: ~60us, verify: ~150us), has small keys (32 bytes), and does not require a shared secret or certificate authority.

**Consequences:**
- Positive: No shared secrets to manage, fast, small keys, widely supported (Node.js `crypto.sign`/`crypto.verify` with Ed25519).
- Negative: Key management complexity (generation, distribution, rotation, revocation). Mitigated by the `AgentAuthService` which handles the lifecycle.
- Risk: Private key exposure compromises the agent identity. Mitigated by never serializing private keys to storage and by the `revokeCredential()` method for emergency response.
