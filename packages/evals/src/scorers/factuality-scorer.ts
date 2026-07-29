import type {
  EvalInput,
  Scorer,
  ScorerConfig,
  ScorerResult,
} from '../types.js';

export type FactualityClaimStatus = 'verified' | 'unsupported' | 'contradicted';

export interface FactualityClaim {
  id: string;
  text: string;
}

export interface ReferenceFact {
  id: string;
  text: string;
}

export interface FactualityClaimResult {
  claim: FactualityClaim;
  status: FactualityClaimStatus;
  matchedFactIds: string[];
  confidence: number;
  reasoning: string;
}

export interface FactualityReport {
  claims: FactualityClaim[];
  referenceFacts: ReferenceFact[];
  claimResults: FactualityClaimResult[];
  verifiedClaims: FactualityClaimResult[];
  unsupportedClaims: FactualityClaimResult[];
  contradictedClaims: FactualityClaimResult[];
  hallucinationScore: number;
  factualityScore: number;
  /**
   * Whether claim verification actually ran.
   *
   * `false` means no `extractClaims` / `verifyClaims` hook was configured, so
   * the scores below describe nothing that was measured. Distinct from "ran and
   * found no claims", which is a real result and reports `true`.
   */
  verificationPerformed: boolean;
  passed: boolean;
}

export interface FactualityEvalInput extends EvalInput {
  referenceFacts: ReferenceFact[];
}

export interface FactualityScorerConfig {
  id?: string;
  threshold?: number;
  /**
   * Hooks that perform the actual verification.
   *
   * At least one is required for the scorer to measure anything. With neither,
   * no claim is ever extracted or checked, and the scorer reports
   * `verificationPerformed: false` with `passed: false` rather than a vacuous
   * perfect score.
   */
  extractClaims?: (
    output: string,
    input: FactualityEvalInput,
  ) => FactualityClaim[] | Promise<FactualityClaim[]>;
  verifyClaims?: (
    claims: FactualityClaim[],
    referenceFacts: ReferenceFact[],
    input: FactualityEvalInput,
  ) => FactualityClaimResult[] | Promise<FactualityClaimResult[]>;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export class FactualityScorer implements Scorer<FactualityEvalInput> {
  readonly config: ScorerConfig;

  private readonly threshold: number;
  private readonly extractClaimsHook:
    | FactualityScorerConfig['extractClaims']
    | undefined;
  private readonly verifyClaimsHook:
    | FactualityScorerConfig['verifyClaims']
    | undefined;

  constructor(config: FactualityScorerConfig = {}) {
    this.threshold = config.threshold ?? 1;
    this.extractClaimsHook = config.extractClaims;
    this.verifyClaimsHook = config.verifyClaims;
    this.config = {
      id: config.id ?? 'factuality',
      name: 'factuality',
      description: 'Scores factuality from extracted claims and reference facts',
      type: 'deterministic',
      threshold: this.threshold,
    };
  }

  async extractClaims(input: FactualityEvalInput): Promise<FactualityClaim[]> {
    if (!this.extractClaimsHook) return [];
    return this.extractClaimsHook(input.output, input);
  }

  async verifyClaims(
    claims: FactualityClaim[],
    referenceFacts: ReferenceFact[],
    input: FactualityEvalInput,
  ): Promise<FactualityClaimResult[]> {
    if (!this.verifyClaimsHook) return [];
    return this.verifyClaimsHook(claims, referenceFacts, input);
  }

  scoreHallucination(claimResults: FactualityClaimResult[]): number {
    if (claimResults.length === 0) return 0;

    const hallucinatedCount = claimResults.filter((result) =>
      result.status === 'unsupported' || result.status === 'contradicted'
    ).length;

    return clamp01(hallucinatedCount / claimResults.length);
  }

  /**
   * Whether this scorer can verify anything at all.
   *
   * Both hooks are optional, and with neither configured `extractClaims` and
   * `verifyClaims` return `[]` — which `scoreHallucination` reads as "zero
   * hallucinations" and turns into a factuality score of 1.0. A scorer built as
   * `new FactualityScorer({ threshold: 1 })` would therefore report a PERFECT,
   * PASSING score having checked nothing: the strictest possible threshold is
   * the one that fails open the hardest.
   *
   * This is the same hazard as a judge scoring 0.0 on its own failure, mirrored:
   * an unperformed check must never be reported as a check that succeeded.
   */
  private get canVerify(): boolean {
    return (
      this.extractClaimsHook !== undefined || this.verifyClaimsHook !== undefined
    );
  }

  async generateReport(input: FactualityEvalInput): Promise<FactualityReport> {
    // Deliberately keyed on the HOOKS being absent, not on the RESULTS being
    // empty. A wired scorer that legitimately finds no factual claims in the
    // output did perform verification and still scores 1.0.
    if (!this.canVerify) {
      return {
        claims: [],
        referenceFacts: input.referenceFacts,
        claimResults: [],
        verifiedClaims: [],
        unsupportedClaims: [],
        contradictedClaims: [],
        // Not 0.0 either: the output is not known to be hallucinated, it is
        // simply unmeasured. The scores are meaningless here and
        // `verificationPerformed: false` is the field that says so; `passed`
        // is false because an unverified output must not clear a factuality
        // gate.
        hallucinationScore: 0,
        factualityScore: 0,
        verificationPerformed: false,
        passed: false,
      };
    }

    const claims = await this.extractClaims(input);
    const claimResults = await this.verifyClaims(claims, input.referenceFacts, input);
    const verifiedClaims = claimResults.filter((result) => result.status === 'verified');
    const unsupportedClaims = claimResults.filter((result) => result.status === 'unsupported');
    const contradictedClaims = claimResults.filter((result) => result.status === 'contradicted');
    const hallucinationScore = this.scoreHallucination(claimResults);
    const factualityScore = clamp01(1 - hallucinationScore);

    return {
      claims,
      referenceFacts: input.referenceFacts,
      claimResults,
      verifiedClaims,
      unsupportedClaims,
      contradictedClaims,
      hallucinationScore,
      factualityScore,
      verificationPerformed: true,
      passed: factualityScore >= this.threshold,
    };
  }

  async score(input: FactualityEvalInput): Promise<ScorerResult> {
    const startTime = Date.now();
    const report = await this.generateReport(input);

    // "0/0 claims verified" reads like a clean result; say plainly that no
    // verification was configured so a report reader is not misled.
    const unverifiedNote = 'no extractClaims/verifyClaims hook configured — nothing was verified';

    return {
      scorerId: this.config.id,
      scores: [
        {
          criterion: 'factuality',
          score: report.factualityScore,
          reasoning: report.verificationPerformed
            ? `${report.verifiedClaims.length}/${report.claimResults.length} claims verified`
            : unverifiedNote,
        },
        {
          criterion: 'hallucination',
          score: report.verificationPerformed ? 1 - report.hallucinationScore : 0,
          reasoning: report.verificationPerformed
            ? `${report.unsupportedClaims.length + report.contradictedClaims.length}/${report.claimResults.length} claims unsupported or contradicted`
            : unverifiedNote,
        },
      ],
      aggregateScore: report.factualityScore,
      passed: report.passed,
      durationMs: Date.now() - startTime,
    };
  }
}

export const FactualityEval = FactualityScorer;
