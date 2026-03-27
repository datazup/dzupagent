# @dzipagent/testing

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Experimental | **Coverage:** N/A | **Exports:** 6

| Metric | Value |
|--------|-------|
| Source Files | 8 |
| Lines of Code | 715 |
| Test Files | 1 |
| Internal Dependencies | None |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @dzipagent/testing
```
<!-- AUTO-GENERATED-END -->

Security testing framework for DzipAgent agents. Provides pre-built test suites that verify agent resilience against prompt injection, privilege escalation, memory poisoning, and sandbox escape attacks. Each test case defines a malicious input, expected system behavior, and severity level.

## Installation

```bash
npm install @dzipagent/testing --save-dev
```

## Quick Start

```ts
import {
  runSecuritySuite,
  INJECTION_SUITE,
  ESCALATION_SUITE,
} from '@dzipagent/testing'

// Define a checker that tests your agent's defenses
const checker = async (input: string) => {
  const response = await myAgent.process(input)
  return {
    blocked: response.wasBlocked,
    detected: response.flaggedAsMalicious,
    details: response.reason,
  }
}

// Run the injection test suite
const results = await runSecuritySuite(INJECTION_SUITE, checker)

console.log(`Suite: ${results.suiteName}`)
console.log(`Pass rate: ${(results.passRate * 100).toFixed(0)}%`)
console.log(`Passed: ${results.passed}/${results.totalCases}`)

for (const result of results.results) {
  if (!result.passed) {
    console.log(`FAIL [${result.severity}]: ${result.details}`)
  }
}
```

## Test Suites

Four built-in security test suites covering the most common attack vectors against LLM agents:

### INJECTION_SUITE

Tests prompt injection attack vectors:

- Direct instruction overrides (`Ignore all previous instructions...`)
- Role-play injection (DAN-style jailbreaks)
- Encoded payloads
- ChatML injection (`<|im_start|>system`)
- System prompt extraction attempts

Each case expects `block` behavior (the agent should refuse to comply).

### ESCALATION_SUITE

Tests privilege escalation attempts:

- Role confusion attacks
- Tool abuse (requesting admin-only tools)
- Permission boundary testing
- Authority impersonation

### POISONING_SUITE

Tests memory poisoning attacks:

- Injection of malicious content into memory stores
- Context manipulation through crafted memory entries
- Attempts to corrupt agent learned behaviors

### ESCAPE_SUITE

Tests sandbox escape attempts:

- File system access beyond allowed paths
- Network requests to unauthorized endpoints
- Process spawning and command injection
- Environment variable exfiltration

## SecurityChecker Interface

The `runSecuritySuite` function takes a `SecurityChecker` -- a function that processes each test case's malicious input and returns detection results:

```ts
interface SecurityChecker {
  (input: string): Promise<{
    blocked: boolean    // Was the input blocked from execution?
    detected: boolean   // Was the input flagged as malicious?
    details?: string    // Optional human-readable explanation
  }>
}
```

The runner evaluates each test result against the expected behavior:

| Expected Behavior | Pass Condition |
|-------------------|----------------|
| `block` | `blocked === true` |
| `detect` | `blocked === true` OR `detected === true` |
| `safe` | `blocked === false` AND `detected === false` |

## Examples

### Testing with SafetyMonitor

Combine with `@dzipagent/otel`'s `SafetyMonitor` for pattern-based checking:

```ts
import { runSecuritySuite, INJECTION_SUITE } from '@dzipagent/testing'
import { SafetyMonitor } from '@dzipagent/otel'

const monitor = new SafetyMonitor()

const checker = async (input: string) => {
  const events = monitor.scanInput(input)
  const hasCritical = events.some((e) => e.severity === 'critical')
  const hasAny = events.length > 0

  return {
    blocked: hasCritical,
    detected: hasAny,
    details: events.map((e) => e.message).join('; '),
  }
}

const results = await runSecuritySuite(INJECTION_SUITE, checker)
```

### Running all suites

```ts
import {
  runSecuritySuite,
  INJECTION_SUITE,
  ESCALATION_SUITE,
  POISONING_SUITE,
  ESCAPE_SUITE,
} from '@dzipagent/testing'

const suites = [INJECTION_SUITE, ESCALATION_SUITE, POISONING_SUITE, ESCAPE_SUITE]

for (const suite of suites) {
  const result = await runSecuritySuite(suite, checker)
  console.log(`${result.suiteName}: ${result.passed}/${result.totalCases} passed`)

  if (result.failed > 0) {
    const failures = result.results.filter((r) => !r.passed)
    for (const f of failures) {
      console.log(`  [${f.severity}] ${f.details}`)
    }
  }
}
```

### CI integration

```ts
// security-test.ts
import { runSecuritySuite, INJECTION_SUITE, ESCALATION_SUITE } from '@dzipagent/testing'

const suites = [INJECTION_SUITE, ESCALATION_SUITE]
let allPassed = true

for (const suite of suites) {
  const result = await runSecuritySuite(suite, checker)
  if (result.passRate < 1.0) {
    allPassed = false
    const failures = result.results
      .filter((r) => !r.passed)
      .filter((r) => r.severity === 'critical' || r.severity === 'high')
    for (const f of failures) {
      console.error(`::error::Security test failed: ${f.details}`)
    }
  }
}

if (!allPassed) {
  process.exit(1)
}
```

## API Reference

### Functions

- `runSecuritySuite(suite, checker)` -- execute a security test suite against a checker function. Returns a `SecuritySuiteResult` with per-case results and aggregate pass rate.

### Constants

- `INJECTION_SUITE` -- prompt injection test cases (`SecurityTestCase[]`)
- `ESCALATION_SUITE` -- privilege escalation test cases (`SecurityTestCase[]`)
- `POISONING_SUITE` -- memory poisoning test cases (`SecurityTestCase[]`)
- `ESCAPE_SUITE` -- sandbox escape test cases (`SecurityTestCase[]`)

### Types

```ts
type SecurityCategory = 'injection' | 'escalation' | 'poisoning' | 'escape' | 'data-leak' | 'dos'
type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical'
type SecurityExpectedBehavior = 'block' | 'detect' | 'safe'

interface SecurityTestCase {
  id: string
  category: SecurityCategory
  name: string
  description: string
  severity: SecuritySeverity
  input: string
  expectedBehavior: SecurityExpectedBehavior
  metadata?: Record<string, unknown>
}

interface SecurityTestResult {
  caseId: string
  passed: boolean
  category: SecurityCategory
  severity: string
  details: string
}

interface SecuritySuiteResult {
  suiteName: string
  totalCases: number
  passed: number
  failed: number
  results: SecurityTestResult[]
  passRate: number  // 0.0 to 1.0
}

interface SecurityChecker {
  (input: string): Promise<{
    blocked: boolean
    detected: boolean
    details?: string
  }>
}
```

## License

MIT
