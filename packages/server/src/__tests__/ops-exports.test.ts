import { describe, expect, it } from 'vitest'
import * as ops from '../ops.js'
import * as root from '../index.js'
import {
  formatDoctorReportJSON,
  IntegrationScorecard,
  ScorecardReporter,
  formatJSON,
  parseScorecardArgs,
  runDoctor,
  runScorecard,
} from '../ops.js'

describe('@dzupagent/server/ops facade', () => {
  it('re-exports the doctor helpers', () => {
    expect(runDoctor).toBeTypeOf('function')
    expect(formatDoctorReportJSON).toBeTypeOf('function')
  })

  it('re-exports the scorecard helpers', () => {
    expect(IntegrationScorecard).toBeTypeOf('function')
    expect(ScorecardReporter).toBeTypeOf('function')
    expect(formatJSON).toBeTypeOf('function')
    expect(runScorecard).toBeTypeOf('function')
    expect(parseScorecardArgs).toBeTypeOf('function')
  })

  it('re-exports every ORM-bound implementation that the root keeps as a deprecated alias', () => {
    const ormBound = [
      'PostgresRunQueue',
      'createPostgresNodeLedger',
      'PostgresFlowArtifactStore',
      'PostgresFlowApprovalStore',
      'DrizzleAdapterMetaStore',
      'DrizzleEventStore',
      'DrizzleCostAttributor',
      'DrizzleTenantRunQuota',
    ] as const
    for (const name of ormBound) {
      expect(ops[name], name).toBeTypeOf('function')
      expect(ops[name], name).toBe(root[name])
    }
  })
})
