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
  passed: boolean;
}

export interface FactualityEvalInput extends EvalInput {
  referenceFacts: ReferenceFact[];
}

export interface FactualityScorerConfig {
  id?: string;
  threshold?: number;
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

  async generateReport(input: FactualityEvalInput): Promise<FactualityReport> {
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
      passed: factualityScore >= this.threshold,
    };
  }

  async score(input: FactualityEvalInput): Promise<ScorerResult> {
    const startTime = Date.now();
    const report = await this.generateReport(input);

    return {
      scorerId: this.config.id,
      scores: [
        {
          criterion: 'factuality',
          score: report.factualityScore,
          reasoning: `${report.verifiedClaims.length}/${report.claimResults.length} claims verified`,
        },
        {
          criterion: 'hallucination',
          score: 1 - report.hallucinationScore,
          reasoning: `${report.unsupportedClaims.length + report.contradictedClaims.length}/${report.claimResults.length} claims unsupported or contradicted`,
        },
      ],
      aggregateScore: report.factualityScore,
      passed: report.passed,
      durationMs: Date.now() - startTime,
    };
  }
}

export const FactualityEval = FactualityScorer;
