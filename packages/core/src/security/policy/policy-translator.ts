/**
 * Zero-Trust Policy Engine — Translator
 *
 * Authoring tool that uses an LLM to translate natural-language policy
 * descriptions into PolicyRule objects, and to explain existing rules
 * in plain English. NEVER used in the enforcement path.
 */

import type { PolicyRule } from './policy-types.js'
import { ForgeError } from '../../errors/forge-error.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PolicyTranslatorConfig {
  /** LLM invocation function — takes a prompt string, returns raw text. */
  llm: (prompt: string) => Promise<string>
}

// ---------------------------------------------------------------------------
// Translation result
// ---------------------------------------------------------------------------

export interface PolicyTranslationResult {
  rule: PolicyRule
  /** 0-1 confidence score from the LLM's self-assessment. */
  confidence: number
  /** Human-readable explanation of the generated rule. */
  explanation: string
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const TRANSLATE_PROMPT = `You are a policy authoring assistant. Convert the following natural-language policy description into a JSON object with exactly this shape:

{
  "rule": {
    "id": "<kebab-case-id>",
    "effect": "allow" | "deny",
    "priority": <number 0-100>,
    "principals": { "types": [...], "ids": [...], "roles": [...] } | null,
    "actions": ["<action-pattern>", ...],
    "resources": ["<resource-pattern>", ...] | null,
    "conditions": [{ "field": "<dotted.path>", "operator": "<op>", "value": <value> }] | null,
    "description": "<human description>"
  },
  "confidence": <0.0 to 1.0>,
  "explanation": "<why this rule matches the intent>"
}

Valid operators: eq, neq, gt, gte, lt, lte, in, not_in, contains, glob, regex.
Valid principal types: agent, user, service, system.
Valid effects: allow, deny.

Respond ONLY with the JSON object. No markdown fences, no extra text.

Natural-language policy:
`

const EXPLAIN_PROMPT = `You are a policy documentation assistant. Given the following policy rule as JSON, provide a clear, concise plain-English explanation of what it does, who it applies to, and under what conditions.

Respond with ONLY the explanation text. No JSON, no markdown fences.

Policy rule:
`

// ---------------------------------------------------------------------------
// PolicyTranslator
// ---------------------------------------------------------------------------

export class PolicyTranslator {
  private readonly _llm: (prompt: string) => Promise<string>

  constructor(config: PolicyTranslatorConfig) {
    this._llm = config.llm
  }

  /**
   * Translate a natural-language description into a structured PolicyRule.
   */
  async translate(naturalLanguage: string): Promise<PolicyTranslationResult> {
    const prompt = TRANSLATE_PROMPT + naturalLanguage
    const raw = await this._llm(prompt)

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ForgeError({
        code: 'POLICY_INVALID',
        message: `PolicyTranslator: LLM returned invalid JSON: ${raw.slice(0, 200)}`,
        recoverable: true,
        suggestion: 'Retry translation or rephrase the policy description',
      })
    }

    const obj = parsed as Record<string, unknown>
    if (!obj || typeof obj !== 'object' || !('rule' in obj)) {
      throw new ForgeError({
        code: 'POLICY_INVALID',
        message: 'PolicyTranslator: LLM response missing "rule" field',
        recoverable: true,
        suggestion: 'Retry translation or rephrase the policy description',
      })
    }

    const rule = obj['rule'] as PolicyRule
    const confidence = typeof obj['confidence'] === 'number' ? obj['confidence'] : 0.5
    const explanation = typeof obj['explanation'] === 'string' ? obj['explanation'] : ''

    return { rule, confidence, explanation }
  }

  /**
   * Explain an existing PolicyRule in plain English.
   */
  async explain(rule: PolicyRule): Promise<string> {
    const prompt = EXPLAIN_PROMPT + JSON.stringify(rule, null, 2)
    const raw = await this._llm(prompt)
    return raw.trim()
  }
}
