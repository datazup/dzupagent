/**
 * Fields M1.6 deliberately leaves unsourced.
 *
 * Usage parsing may only be implemented from real, redacted provider
 * transcripts (doc 09 §2). The provider-free help/version capture contains no
 * authenticated run transcript, so both inspectors retain `usageSource:
 * "unspecified"` and make the missing evidence discoverable here.
 */
export const PARTIAL_INSPECTOR_GAPS = {
  gemini: {
    usageTranscript:
      'No real redacted Gemini run transcript is admitted; usage parsing is intentionally absent.',
  },
  qwen: {
    usageTranscript:
      'No real redacted Qwen run transcript is admitted; usage parsing is intentionally absent.',
  },
} as const
