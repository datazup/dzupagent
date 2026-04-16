import { describe, it, expect, beforeEach } from 'vitest'
import {
  createRiskClassifier,
  scanForSecrets,
  redactSecrets,
  detectPII,
  redactPII,
  OutputPipeline,
  createDefaultPipeline,
  PolicyEvaluator,
  InMemoryPolicyStore,
  createSafetyMonitor,
  getBuiltInRules,
  createMemoryDefense,
  DataClassifier,
  DEFAULT_CLASSIFICATION_PATTERNS,
  DEFAULT_AUTO_APPROVE_TOOLS,
  DEFAULT_LOG_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_TOOLS,
} from '../facades/security.js'
import type {
  RiskClassifier,
  PolicySet,
  PolicyContext,
  SafetyMonitor,
} from '../facades/security.js'
import { createEventBus } from '../events/event-bus.js'

// ---------------------------------------------------------------------------
// Risk Classifier
// ---------------------------------------------------------------------------

describe('createRiskClassifier', () => {
  let classifier: RiskClassifier

  beforeEach(() => {
    classifier = createRiskClassifier()
  })

  it('classifies auto-approve tools as "auto"', () => {
    // Pick one from the default auto list
    if (DEFAULT_AUTO_APPROVE_TOOLS.length > 0) {
      const tool = DEFAULT_AUTO_APPROVE_TOOLS[0]!
      const result = classifier.classify(tool)
      expect(result.tier).toBe('auto')
      expect(result.toolName).toBe(tool)
    }
  })

  it('classifies require-approval tools as "require-approval"', () => {
    if (DEFAULT_REQUIRE_APPROVAL_TOOLS.length > 0) {
      const tool = DEFAULT_REQUIRE_APPROVAL_TOOLS[0]!
      const result = classifier.classify(tool)
      expect(result.tier).toBe('require-approval')
    }
  })

  it('falls back to default tier "log" for unknown tools', () => {
    const result = classifier.classify('totally-unknown-tool-xyz')
    expect(result.tier).toBe('log')
    expect(result.reason).toContain('unclassified')
  })

  it('accepts custom defaultTier', () => {
    const c = createRiskClassifier({ defaultTier: 'require-approval' })
    const result = c.classify('unknown-tool')
    expect(result.tier).toBe('require-approval')
  })

  it('custom classifier overrides static lookup', () => {
    const c = createRiskClassifier({
      customClassifier: (name) => name === 'my-tool' ? 'auto' : undefined,
    })
    expect(c.classify('my-tool').tier).toBe('auto')
    // Unknown falls through to default
    expect(c.classify('other').tier).toBe('log')
  })
})

// ---------------------------------------------------------------------------
// Secrets Scanner
// ---------------------------------------------------------------------------

describe('scanForSecrets', () => {
  it('detects GitHub tokens', () => {
    const content = 'my token is ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    const result = scanForSecrets(content)
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some(m => m.type === 'github-token')).toBe(true)
  })

  it('detects AWS access keys', () => {
    const content = 'key=AKIAIOSFODNN7EXAMPLE'
    const result = scanForSecrets(content)
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some(m => m.type === 'aws-access-key')).toBe(true)
  })

  it('detects connection strings', () => {
    const content = 'db_url = postgresql://user:pass@host:5432/mydb'
    const result = scanForSecrets(content)
    expect(result.hasSecrets).toBe(true)
    expect(result.matches.some(m => m.type === 'connection-string')).toBe(true)
  })

  it('returns hasSecrets=false for clean text', () => {
    const result = scanForSecrets('Hello, this is a safe sentence.')
    expect(result.hasSecrets).toBe(false)
    expect(result.matches).toHaveLength(0)
  })

  it('redacted output replaces secret values', () => {
    const content = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    const result = scanForSecrets(content)
    expect(result.redacted).toContain('[REDACTED:')
    expect(result.redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890')
  })

  it('redactSecrets convenience returns string', () => {
    const out = redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz1234567890 here')
    expect(typeof out).toBe('string')
    expect(out).toContain('[REDACTED:')
  })
})

// ---------------------------------------------------------------------------
// PII Detector
// ---------------------------------------------------------------------------

describe('detectPII', () => {
  it('detects email addresses', () => {
    const result = detectPII('contact me at john@example.com please')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some(m => m.type === 'email')).toBe(true)
  })

  it('detects SSN', () => {
    const result = detectPII('SSN: 123-45-6789')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some(m => m.type === 'ssn')).toBe(true)
  })

  it('detects IP addresses', () => {
    const result = detectPII('server at 192.168.1.100')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some(m => m.type === 'ip-address')).toBe(true)
  })

  it('returns hasPII=false for clean text', () => {
    const result = detectPII('No personal info here.')
    expect(result.hasPII).toBe(false)
  })

  it('redactPII replaces all PII', () => {
    const out = redactPII('Email john@example.com and SSN 123-45-6789')
    expect(out).toContain('[REDACTED:email]')
    expect(out).toContain('[REDACTED:ssn]')
    expect(out).not.toContain('john@example.com')
  })
})

// ---------------------------------------------------------------------------
// Output Pipeline
// ---------------------------------------------------------------------------

describe('OutputPipeline', () => {
  it('runs stages in order and reports applied stages', async () => {
    const pipeline = new OutputPipeline({
      stages: [
        { name: 'upper', process: (s) => s.toUpperCase() },
        { name: 'trim', process: (s) => s.trim() },
      ],
    })
    const result = await pipeline.process('  hello  ')
    expect(result.content).toBe('HELLO')
    expect(result.appliedStages).toContain('upper')
  })

  it('skips disabled stages', async () => {
    const pipeline = new OutputPipeline({
      stages: [
        { name: 'disabled', enabled: false, process: () => 'SHOULD NOT APPEAR' },
        { name: 'identity', process: (s) => s },
      ],
    })
    const result = await pipeline.process('original')
    expect(result.content).toBe('original')
    expect(result.appliedStages).not.toContain('disabled')
  })

  it('truncates content exceeding maxOutputLength', async () => {
    const pipeline = new OutputPipeline({
      stages: [],
      maxOutputLength: 10,
    })
    const result = await pipeline.process('a'.repeat(20))
    expect(result.truncated).toBe(true)
    expect(result.content).toContain('[TRUNCATED]')
  })

  it('reports originalLength', async () => {
    const pipeline = new OutputPipeline({ stages: [] })
    const result = await pipeline.process('test')
    expect(result.originalLength).toBe(4)
  })

  it('addStage appends dynamically', async () => {
    const pipeline = new OutputPipeline({ stages: [] })
    pipeline.addStage({ name: 'exclaim', process: (s) => s + '!' })
    const result = await pipeline.process('hello')
    expect(result.content).toBe('hello!')
  })

  it('setStageEnabled toggles a stage', async () => {
    const pipeline = new OutputPipeline({
      stages: [{ name: 'upper', process: (s) => s.toUpperCase() }],
    })
    pipeline.setStageEnabled('upper', false)
    const result = await pipeline.process('hello')
    expect(result.content).toBe('hello')
  })
})

describe('createDefaultPipeline', () => {
  it('creates a pipeline that redacts PII and secrets by default', async () => {
    const pipeline = createDefaultPipeline()
    const result = await pipeline.process('Email: john@example.com token ghp_abcdefghijklmnopqrstuvwxyz1234567890')
    expect(result.content).toContain('[REDACTED:')
  })

  it('respects enablePII=false', async () => {
    const pipeline = createDefaultPipeline({ enablePII: false })
    const result = await pipeline.process('john@example.com')
    // PII should NOT be redacted
    expect(result.content).toContain('john@example.com')
  })

  it('supports customDenyList', async () => {
    const pipeline = createDefaultPipeline({ customDenyList: ['badword'] })
    const result = await pipeline.process('This has a badword in it')
    expect(result.content).toContain('[BLOCKED]')
    expect(result.content).not.toContain('badword')
  })
})

// ---------------------------------------------------------------------------
// Policy Evaluator
// ---------------------------------------------------------------------------

describe('PolicyEvaluator', () => {
  const evaluator = new PolicyEvaluator()

  const basePolicySet: PolicySet = {
    id: 'test-policy',
    name: 'Test Policy',
    version: 1,
    rules: [
      {
        id: 'allow-read',
        effect: 'allow',
        actions: ['read'],
        priority: 10,
      },
      {
        id: 'deny-delete',
        effect: 'deny',
        actions: ['delete'],
        priority: 20,
      },
    ],
  }

  const baseContext: PolicyContext = {
    principal: { type: 'agent', id: 'agent-1' },
    action: 'read',
  }

  it('allows matched allow-rule actions', () => {
    const decision = evaluator.evaluate(basePolicySet, baseContext)
    expect(decision.effect).toBe('allow')
  })

  it('denies matched deny-rule actions (deny-overrides)', () => {
    const decision = evaluator.evaluate(basePolicySet, {
      ...baseContext,
      action: 'delete',
    })
    expect(decision.effect).toBe('deny')
    expect(decision.decidingRule?.id).toBe('deny-delete')
  })

  it('default-deny when no rules match', () => {
    const decision = evaluator.evaluate(basePolicySet, {
      ...baseContext,
      action: 'update',
    })
    expect(decision.effect).toBe('deny')
    expect(decision.matchedRules).toHaveLength(0)
  })

  it('validate detects missing fields', () => {
    const result = evaluator.validate({
      id: '',
      name: '',
      version: 'bad' as unknown as number,
      rules: [],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('validate passes for a well-formed policy set', () => {
    const result = evaluator.validate(basePolicySet)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Safety Monitor
// ---------------------------------------------------------------------------

describe('createSafetyMonitor', () => {
  it('scanContent with built-in rules returns an array', () => {
    const monitor = createSafetyMonitor()
    const violations = monitor.scanContent('normal text')
    expect(Array.isArray(violations)).toBe(true)
  })

  it('getViolations tracks history', () => {
    const monitor = createSafetyMonitor({
      replaceBuiltInRules: true,
      rules: [
        {
          id: 'test-rule',
          category: 'content_injection',
          severity: 'high',
          check: (content) => {
            if (content.includes('EVIL')) {
              return {
                ruleId: 'test-rule',
                category: 'content_injection',
                severity: 'high',
                action: 'block',
                message: 'Evil content detected',
              }
            }
            return null
          },
        },
      ],
    })
    monitor.scanContent('safe text')
    expect(monitor.getViolations()).toHaveLength(0)

    monitor.scanContent('EVIL content')
    expect(monitor.getViolations()).toHaveLength(1)
    expect(monitor.getViolations()[0]!.message).toContain('Evil')
  })

  it('dispose clears violations', () => {
    const monitor = createSafetyMonitor({
      replaceBuiltInRules: true,
      rules: [{
        id: 'r1',
        category: 'content_injection',
        severity: 'low',
        check: () => ({
          ruleId: 'r1',
          category: 'content_injection',
          severity: 'low',
          action: 'warn',
          message: 'test',
        }),
      }],
    })
    monitor.scanContent('anything')
    expect(monitor.getViolations().length).toBeGreaterThan(0)
    monitor.dispose()
    expect(monitor.getViolations()).toHaveLength(0)
  })

  it('auto-attaches to eventBus when provided in config', () => {
    const bus = createEventBus()
    const monitor = createSafetyMonitor({ eventBus: bus })
    // Should not throw — monitor is attached
    expect(monitor.getViolations()).toHaveLength(0)
    monitor.dispose()
  })
})

// ---------------------------------------------------------------------------
// Data Classifier
// ---------------------------------------------------------------------------

describe('DataClassifier', () => {
  it('classifies SSN-containing text as restricted', () => {
    const classifier = new DataClassifier()
    const result = classifier.classify('SSN is 123-45-6789')
    expect(result.level).toBe('restricted')
  })

  it('classifies API key containing text as confidential', () => {
    const classifier = new DataClassifier()
    const result = classifier.classify('api_key = abcdefghijklmnop1234')
    expect(result.level).toBe('confidential')
  })

  it('classifies clean text as public by default', () => {
    const classifier = new DataClassifier()
    const result = classifier.classify('This is a normal sentence about weather.')
    expect(result.level).toBe('public')
  })

  it('DEFAULT_CLASSIFICATION_PATTERNS is a non-empty array', () => {
    expect(Array.isArray(DEFAULT_CLASSIFICATION_PATTERNS)).toBe(true)
    expect(DEFAULT_CLASSIFICATION_PATTERNS.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Tool Permission Tiers (static arrays)
// ---------------------------------------------------------------------------

describe('tool permission tier defaults', () => {
  it('default arrays are non-empty', () => {
    expect(DEFAULT_AUTO_APPROVE_TOOLS.length).toBeGreaterThan(0)
    expect(DEFAULT_LOG_TOOLS.length).toBeGreaterThan(0)
    expect(DEFAULT_REQUIRE_APPROVAL_TOOLS.length).toBeGreaterThan(0)
  })

  it('tiers do not overlap', () => {
    const autoSet = new Set(DEFAULT_AUTO_APPROVE_TOOLS)
    const logSet = new Set(DEFAULT_LOG_TOOLS)
    const approvalSet = new Set(DEFAULT_REQUIRE_APPROVAL_TOOLS)

    for (const tool of autoSet) {
      expect(logSet.has(tool)).toBe(false)
      expect(approvalSet.has(tool)).toBe(false)
    }
    for (const tool of logSet) {
      expect(approvalSet.has(tool)).toBe(false)
    }
  })
})
