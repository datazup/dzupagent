/**
 * Outbound webhook notification for pending approvals.
 *
 * Extracted from `adapter-approval.ts` to keep that module under its per-file
 * ceiling (MC-5 / DZUPAGENT-CODE-L-04). This is delivery only: it holds no
 * approval state and makes no approval decision, so it reads the config it
 * needs rather than the gate.
 */
import { fetchWithOutboundUrlPolicy } from "@dzupagent/core/security";
import type { OutboundUrlSecurityPolicy } from "@dzupagent/core/security";

import { validateWebhookUrl } from "../utils/url-validator.js";
import type {
  AdapterApprovalConfig,
  ApprovalContext,
} from "./approval-types.js";

/**
 * POST an `approval_requested` notification to the configured webhook.
 *
 * A no-op when no `webhookUrl` is configured. The URL is re-validated at call
 * time, not just at construction, in case it was mutated in between.
 */
export async function notifyApprovalWebhook(
  config: AdapterApprovalConfig,
  requestId: string,
  context: ApprovalContext
): Promise<void> {
  if (!config.webhookUrl) return;

  validateWebhookUrl(config.webhookUrl, config.webhookUrlValidation);
  const urlPolicy: OutboundUrlSecurityPolicy | undefined =
    config.webhookUrlValidation;

  await fetchWithOutboundUrlPolicy(
    config.webhookUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "approval_requested",
        requestId,
        runId: context.runId,
        description: context.description,
        providerId: context.providerId,
        estimatedCostCents: context.estimatedCostCents,
        tags: context.tags,
        metadata: context.metadata,
      }),
    },
    {
      policy: urlPolicy,
      ...(config.webhookFetchImpl !== undefined
        ? { fetchImpl: config.webhookFetchImpl }
        : {}),
    }
  );
}
