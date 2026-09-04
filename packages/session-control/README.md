# @dzupagent/session-control

Provider-neutral contracts, deterministic reducers, adapter SPI, and
provider-free conformance helpers for agent session control.

This package is a dependency-light library. It does not persist sessions,
authorize product actions, schedule work, hold provider credentials, inject
terminal input, select providers, retry, or fall back. Hosts supply those
policies and effects explicitly.

Use an `inline` execution profile for a single token-efficient request/response
without durable or supervisor machinery. Use `durable` only when the caller
needs lifecycle continuity; supervised multi-session coordination remains an
independent opt-in.

The checked-in provider-free conformance fixture is a portable, terminal
protocol trace. Its validator proves structural validity and deterministic
reduction of that trace; adapter qualification still requires the full package
conformance suite and never implies live-provider acceptance.

Provider implementations and live qualification are outside this package.
