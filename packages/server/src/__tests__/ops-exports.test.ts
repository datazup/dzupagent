import { describe, expect, it } from 'vitest'
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
})
