/**
 * suspended-exit-admission.ts — Stage 4 port-consumer rule (F-R2 item 6).
 *
 * First consumer of the structured port model: a suspended exit is a lowered
 * path that stops awaiting an external decision with NO continuation (e.g. an
 * approval gate without `onReject`). An unattended flow can never satisfy
 * that decision, so admission fails closed — unless the operator passes the
 * explicit `acknowledgeSuspendedExits` compile option, which downgrades the
 * denial to a warning trace. Interactive compilation is untouched: an
 * attended operator IS the external decision-maker.
 *
 * The acknowledgment is only consulted while a suspended exit exists; it is
 * an ack of a named condition, not a blanket bypass.
 *
 * @module suspended-exit-admission
 */

import type { FlowAdmissionProfile } from "./types.js";
import type { LoweredPorts } from "./lower/_shared-types.js";
import type {
  CompilationDiagnostic,
  CompilationWarning,
} from "./diagnostic-types.js";

export interface SuspendedExitAdmissionInput {
  ports: LoweredPorts;
  admissionProfile: FlowAdmissionProfile;
  /**
   * Explicit operator acknowledgment that the suspended exits are
   * intentional. Never derived from the environment — hosts must thread it
   * as a deliberate compile option.
   */
  acknowledgeSuspendedExits: boolean;
  /**
   * Maps a suspended node id to a human-readable label (typically the
   * lowered node's `name`, e.g. `approval:root.nodes[0]`) so diagnostics
   * name the authored site rather than a generated UUID.
   */
  describeNode: (nodeId: string) => string;
}

export interface SuspendedExitAdmissionDecision {
  errors: CompilationDiagnostic[];
  warnings: CompilationWarning[];
}

export function admitSuspendedExits(
  input: SuspendedExitAdmissionInput,
): SuspendedExitAdmissionDecision {
  const suspended = input.ports.suspendedExits;
  if (suspended.length === 0 || input.admissionProfile !== "unattended") {
    return { errors: [], warnings: [] };
  }

  const sites = suspended
    .map((id) => `${input.describeNode(id)} (${id})`)
    .join(", ");

  if (input.acknowledgeSuspendedExits) {
    return {
      errors: [],
      warnings: [
        {
          stage: 4,
          code: "SUSPENDED_EXIT_ACKNOWLEDGED",
          message:
            `unattended admission of ${suspended.length} suspended exit(s) ` +
            `under explicit operator acknowledgment: ${sites}`,
          nodePath: "root",
          category: "policy",
        },
      ],
    };
  }

  return {
    errors: [
      {
        stage: 4,
        code: "SUSPENDED_EXIT_UNATTENDED",
        message:
          `unattended flows fail closed: ${suspended.length} lowered path(s) ` +
          `suspend awaiting an external decision that unattended execution ` +
          `can never provide: ${sites}. Author a continuation (e.g. ` +
          `approval.on_reject) or pass the explicit ` +
          `acknowledgeSuspendedExits compile option.`,
        nodePath: "root",
        category: "policy",
      },
    ],
    warnings: [],
  };
}
