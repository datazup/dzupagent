/**
 * Policy-aware staged writer — integrates WritePolicy checks into the
 * StagedWriter pipeline so that PII, secrets, and other sensitive content
 * cannot bypass policy evaluation via high-confidence auto-promotion.
 */

import { StagedWriter, type StagedWriterConfig, type StagedRecord } from './staged-writer.js'
import { composePolicies, type WritePolicy } from './write-policy.js'

export interface PolicyAwareStagedWriterConfig extends StagedWriterConfig {
  /** Write policies to evaluate before staging */
  policies: WritePolicy[]
}

export class PolicyAwareStagedWriter extends StagedWriter {
  private readonly composedPolicy: WritePolicy

  constructor(config: PolicyAwareStagedWriterConfig) {
    super(config)
    this.composedPolicy = composePolicies(...config.policies)
  }

  override capture(
    record: Omit<StagedRecord, 'stage' | 'createdAt'>,
  ): StagedRecord {
    const action = this.composedPolicy.evaluate(record.value)

    if (action === 'reject') {
      // Return a rejected record without entering the normal staging pipeline.
      const rejected: StagedRecord = {
        ...record,
        stage: 'rejected',
        createdAt: Date.now(),
      }
      return rejected
    }

    if (action === 'confirm-required') {
      // Override confidence to 0 so auto-promote and auto-confirm never fire.
      return super.capture({ ...record, confidence: 0 })
    }

    // 'auto' — proceed with original confidence
    return super.capture(record)
  }
}
