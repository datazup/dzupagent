// Thin composition root for the safety scorer family.
// The four independent per-category scorer builders live in leaf modules under
// ./safety-scorer/ (refusal, harmful-content, policy-compliance, combined).
// This root re-exports the EXACT public surface — zero behavior change.

export {
  createRefusalScorer,
  type RefusalScorerConfig,
} from "./safety-scorer/refusal.js";

export {
  createHarmfulContentScorer,
  type HarmfulCategory,
  type HarmfulCategoryConfig,
  type HarmfulContentScorerConfig,
} from "./safety-scorer/harmful-content.js";

export {
  createPolicyComplianceScorer,
  type PolicyCategory,
  type PolicyRule,
  type PolicyScorerConfig,
} from "./safety-scorer/policy-compliance.js";

export {
  createSafetyScorer,
  type SafetyScorerConfig,
  type SafetyScorerWeights,
} from "./safety-scorer/combined.js";
