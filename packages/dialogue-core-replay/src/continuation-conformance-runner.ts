import {
  canonicalizeContinuationValueV1,
  evaluateContinuationTransitionV1,
  hashContinuationValueV1,
  type ContinuationTransitionV1,
} from "@dzupagent/dialogue-core/continuation/v1";

import type {
  ContinuationComparisonClassificationV1,
  ContinuationLegacyObservationV1,
} from "./continuation-conformance.js";
import { validateContinuationConformanceFixtureSetV1 } from "./continuation-conformance-validation.js";

export const CONTINUATION_CONFORMANCE_REPORT_SCHEMA_V1 =
  "dzupagent/continuation-conformance-report/v1" as const;

export interface ContinuationConformanceCaseResultV1 {
  readonly caseId: string;
  readonly family: "scripts_historical" | "codev" | "adversarial";
  readonly transitionMatches: boolean;
  readonly classificationMatches: boolean;
  readonly comparisonClassification: ContinuationComparisonClassificationV1;
  readonly passed: boolean;
}

export interface ContinuationConformanceReportV1 {
  readonly schema: typeof CONTINUATION_CONFORMANCE_REPORT_SCHEMA_V1;
  readonly fixtureSetId: string;
  readonly fixtureSetDigest: `sha256:${string}`;
  readonly passed: boolean;
  readonly safetyGatePassed: boolean;
  readonly adoptionReady: boolean;
  readonly counts: {
    readonly total: number;
    readonly passed: number;
    readonly scriptsHistorical: number;
    readonly codev: number;
    readonly adversarial: number;
    readonly unsafeKernel: number;
    readonly saferKernel: number;
    readonly reviewedDifference: number;
    readonly pendingDivergenceApprovals: number;
  };
  readonly cases: readonly ContinuationConformanceCaseResultV1[];
}

export function classifyContinuationComparisonV1(
  legacy: ContinuationLegacyObservationV1 | undefined,
  transition: ContinuationTransitionV1
): ContinuationComparisonClassificationV1 {
  if (legacy === undefined) {
    return "match";
  }

  const kernelAdmission = transitionAdmission(transition);
  if (legacy.admittedTransition === kernelAdmission) {
    return "match";
  }

  const legacyProtectsAdmission = isNonAdmitted(
    legacy.admittedTransition
  );
  const kernelAdmits =
    kernelAdmission === "continue" || kernelAdmission === "complete";
  if (legacyProtectsAdmission && kernelAdmits) {
    return "unsafe_kernel";
  }

  const legacyAdmits =
    legacy.admittedTransition === "continue" ||
    legacy.admittedTransition === "complete";
  if (
    (legacyAdmits && isNonAdmitted(kernelAdmission)) ||
    (legacyProtectsAdmission && isNonAdmitted(kernelAdmission))
  ) {
    return "safer_kernel";
  }

  return "reviewed_difference";
}

export function runContinuationConformanceV1(
  fixtureValue: unknown
): ContinuationConformanceReportV1 {
  const fixture =
    validateContinuationConformanceFixtureSetV1(fixtureValue);
  const results: ContinuationConformanceCaseResultV1[] =
    fixture.cases.map((item) => {
      const actualTransition = evaluateContinuationTransitionV1(
        item.input
      );
      const transitionMatches =
        canonicalizeContinuationValueV1(actualTransition) ===
        canonicalizeContinuationValueV1(
          item.expected.kernelTransition
        );
      const comparisonClassification =
        classifyContinuationComparisonV1(
          item.expected.legacy,
          actualTransition
        );
      const classificationMatches =
        comparisonClassification ===
        item.expected.comparisonClassification;

      return {
        caseId: item.caseId,
        family: item.family,
        transitionMatches,
        classificationMatches,
        comparisonClassification,
        passed: transitionMatches && classificationMatches,
      };
    });

  const countFamily = (
    family: ContinuationConformanceCaseResultV1["family"]
  ) => results.filter((item) => item.family === family).length;
  const countClassification = (
    classification: ContinuationComparisonClassificationV1
  ) =>
    results.filter(
      (item) => item.comparisonClassification === classification
    ).length;
  const pendingDivergenceApprovals =
    fixture.divergenceLedger.filter(
      (entry) => entry.reviewStatus !== "approved"
    ).length;
  const unsafeKernel = countClassification("unsafe_kernel");
  const passedCount = results.filter((item) => item.passed).length;
  const safetyGatePassed =
    passedCount === results.length && unsafeKernel === 0;
  const adoptionReady =
    safetyGatePassed &&
    fixture.publicationReview.reviewStatus === "approved" &&
    pendingDivergenceApprovals === 0;

  return {
    schema: CONTINUATION_CONFORMANCE_REPORT_SCHEMA_V1,
    fixtureSetId: fixture.fixtureSetId,
    fixtureSetDigest: hashContinuationValueV1(fixture),
    passed: safetyGatePassed,
    safetyGatePassed,
    adoptionReady,
    counts: {
      total: results.length,
      passed: passedCount,
      scriptsHistorical: countFamily("scripts_historical"),
      codev: countFamily("codev"),
      adversarial: countFamily("adversarial"),
      unsafeKernel,
      saferKernel: countClassification("safer_kernel"),
      reviewedDifference: countClassification("reviewed_difference"),
      pendingDivergenceApprovals,
    },
    cases: results,
  };
}

function transitionAdmission(
  transition: ContinuationTransitionV1
): ContinuationLegacyObservationV1["admittedTransition"] {
  switch (transition.action) {
    case "continue":
      return "continue";
    case "suspend":
      return "suspend";
    case "review_again":
      return "review_again";
    case "reject":
      return "reject";
    case "stop":
      if (transition.reason === "complete") {
        return "complete";
      }
      if (
        transition.reason === "blocked" ||
        transition.reason === "stuck"
      ) {
        return "blocked";
      }
      return "host_stop";
  }
}

function isNonAdmitted(
  transition: ContinuationLegacyObservationV1["admittedTransition"]
): boolean {
  return (
    transition === "blocked" ||
    transition === "review_again" ||
    transition === "reject" ||
    transition === "host_stop" ||
    transition === "suspend"
  );
}
