import { describe, it } from 'vitest'

/**
 * COVERAGE GAP — deliberately empty suite.
 *
 * This file previously held 38 `it()` blocks (712 lines) exercising a
 * `CalendarConnector` class DEFINED INSIDE THIS TEST FILE. A repo-wide grep for
 * `CalendarConnector` returns only this path: no such connector has ever
 * shipped in `packages/connectors/src`. The tests asserted event CRUD, RSVP
 * handling and conflict detection against a fixture that existed nowhere else,
 * so they could never fail and never covered product code.
 *
 * The shipped connectors are: http, database, notion, sql, slack, webhook,
 * github. If a calendar connector is implemented later, write its tests
 * against the exported class and delete this marker.
 *
 * Removed 2026-07-27. See the RateLimiter precedent for the same pathology
 * caught in @dzupagent/core.
 */
describe.skip('CalendarConnector (not implemented — no production symbol exists)', () => {
  it('has no tests because the feature does not ship', () => {})
})
