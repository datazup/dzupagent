import type { ContinuationTransitionV1 } from "./types.js";

export type ContinuationAdmissionV1 =
  | "continue"
  | "complete"
  | "blocked"
  | "review_again"
  | "reject"
  | "host_stop"
  | "suspend";

export type ContinuationComparisonClassificationV1 =
  | "match"
  | "safer_kernel"
  | "unsafe_kernel"
  | "reviewed_difference";

/**
 * Projects a kernel transition onto the portable admission vocabulary used by
 * shadow adopters. Product-specific stop reasons remain host-owned.
 */
export function continuationTransitionAdmissionV1(
  transition: ContinuationTransitionV1
): ContinuationAdmissionV1 {
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

/**
 * Classifies one authoritative host admission against a non-authorizing kernel
 * transition. A kernel admission that bypasses a protective host outcome is
 * always unsafe; a more restrictive kernel outcome is explicitly safer rather
 * than silently treated as parity.
 */
export function classifyContinuationAdmissionsV1(
  hostAdmission: ContinuationAdmissionV1,
  kernelTransition: ContinuationTransitionV1
): ContinuationComparisonClassificationV1 {
  const kernelAdmission =
    continuationTransitionAdmissionV1(kernelTransition);
  if (hostAdmission === kernelAdmission) {
    return "match";
  }

  const hostProtectsAdmission = isNonAdmitted(hostAdmission);
  const kernelAdmits =
    kernelAdmission === "continue" || kernelAdmission === "complete";
  if (hostProtectsAdmission && kernelAdmits) {
    return "unsafe_kernel";
  }

  const hostAdmits =
    hostAdmission === "continue" || hostAdmission === "complete";
  if (
    (hostAdmits && isNonAdmitted(kernelAdmission)) ||
    (hostProtectsAdmission && isNonAdmitted(kernelAdmission))
  ) {
    return "safer_kernel";
  }

  return "reviewed_difference";
}

function isNonAdmitted(admission: ContinuationAdmissionV1): boolean {
  return (
    admission === "blocked" ||
    admission === "review_again" ||
    admission === "reject" ||
    admission === "host_stop" ||
    admission === "suspend"
  );
}
