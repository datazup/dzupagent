import type {
  EvalInput,
  Scorer,
  ScorerConfig,
  ScorerResult,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Policy Compliance Scorer
// ---------------------------------------------------------------------------

export type PolicyCategory =
  | "data_privacy"
  | "legal"
  | "brand_safety"
  | "custom";

export interface PolicyRule {
  id: string;
  category: PolicyCategory;
  description: string;
  /** Patterns that indicate a VIOLATION of this rule */
  violationPatterns: Array<string | RegExp>;
  /** Weight for this rule in the aggregate. Default 1.0 */
  weight?: number;
}

export interface PolicyScorerConfig {
  id?: string;
  rules: PolicyRule[];
  caseSensitive?: boolean;
  passThreshold?: number;
}

/**
 * Scores output for compliance against a set of configurable policy rules.
 * Score 1.0 = fully compliant (no violations detected).
 * Score 0.0 = all rules violated.
 */
export function createPolicyComplianceScorer(
  config: PolicyScorerConfig
): Scorer<EvalInput> {
  const scorerId = config.id ?? `policy-compliance-${Date.now()}`;
  const caseSensitive = config.caseSensitive ?? false;
  const passThreshold = config.passThreshold ?? 1.0;

  const scorerConfig: ScorerConfig = {
    id: scorerId,
    name: "policy-compliance",
    description: `Policy compliance across ${config.rules.length} rule(s)`,
    type: "deterministic",
  };

  return {
    config: scorerConfig,

    async score(input: EvalInput): Promise<ScorerResult> {
      const startTime = Date.now();
      const text = caseSensitive ? input.output : input.output.toLowerCase();
      const scores: Array<{
        criterion: string;
        score: number;
        reasoning: string;
      }> = [];

      let totalWeight = 0;
      let weightedComplianceSum = 0;

      for (const rule of config.rules) {
        const weight = rule.weight ?? 1.0;
        totalWeight += weight;

        const matchedViolations: string[] = [];
        for (const pattern of rule.violationPatterns) {
          if (typeof pattern === "string") {
            const needle = caseSensitive ? pattern : pattern.toLowerCase();
            if (text.includes(needle)) {
              matchedViolations.push(pattern);
            }
          } else {
            if (pattern.test(text)) {
              matchedViolations.push(pattern.source);
            }
          }
        }

        const violated = matchedViolations.length > 0;
        const complianceScore = violated ? 0.0 : 1.0;
        weightedComplianceSum += complianceScore * weight;

        scores.push({
          criterion: `policy:${rule.id}`,
          score: complianceScore,
          reasoning: violated
            ? `Policy rule "${rule.id}" (${rule.category}) violated: "${matchedViolations[0]}"`
            : `Policy rule "${rule.id}" (${rule.category}) satisfied`,
        });
      }

      const aggregateScore =
        totalWeight > 0 ? weightedComplianceSum / totalWeight : 1.0;

      return {
        scorerId,
        scores,
        aggregateScore,
        passed: aggregateScore >= passThreshold,
        durationMs: Date.now() - startTime,
      };
    },
  };
}
