import {
  digest,
  reservationCore,
} from "../loop-economics-evidence/shared.js";
import type {
  LoopEconomicsEvidenceInput,
  LoopEconomicsEvidenceV1,
} from "../loop-economics-evidence/types.js";

export function materializeLoopEconomicsEvidence(
  input: LoopEconomicsEvidenceInput
): LoopEconomicsEvidenceV1 {
  const reservationBindingDigest = digest(reservationCore(input));
  const withReservationDigest = { ...input, reservationBindingDigest };
  return {
    ...withReservationDigest,
    evidenceDigest: digest(withReservationDigest),
  };
}
