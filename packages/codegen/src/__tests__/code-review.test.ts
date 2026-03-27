import { describe, it, expect } from 'vitest'
import {
  reviewFiles,
  reviewDiff,
  formatReviewAsMarkdown,
  type CodeReviewConfig,
} from '../review/code-reviewer.js'
import { BUILTIN_RULES } from '../review/review-rules.js'
import {
  extractEndpoints,
  extractAPICalls,
  validateContracts,
} from '../quality/contract-validator.js'

// ---------------------------------------------------------------------------
// BUILTIN_RULES
// ---------------------------------------------------------------------------

describe('BUILTIN_RULES', () => {
  it('should have rules for all categories', () => {
    const categories = new Set(BUILTIN_RULES.map(r => r.category))
    expect(categories).toContain('security')
    expect(categories).toContain('bug')
    expect(categories).toContain('performance')
    expect(categories).toContain('style')
    expect(categories).toContain('best-practice')
  })

  it('should have unique rule IDs', () => {
    const ids = BUILTIN_RULES.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('should have at least 15 rules', () => {
    expect(BUILTIN_RULES.length).toBeGreaterThanOrEqual(15)
  })
})

// ---------------------------------------------------------------------------
// reviewFiles
// ---------------------------------------------------------------------------

describe('reviewFiles', () => {
  it('should detect eval() usage as critical', () => {
    const files = {
      'src/handler.ts': `const result = eval(userInput)`,
    }

    const result = reviewFiles(files)
    const evalComment = result.comments.find(c => c.ruleId === 'SEC-001')
    expect(evalComment).toBeDefined()
    expect(evalComment!.severity).toBe('critical')
    expect(evalComment!.category).toBe('security')
    expect(evalComment!.file).toBe('src/handler.ts')
    expect(evalComment!.line).toBe(1)
  })

  it('should detect innerHTML assignment as warning', () => {
    const files = {
      'src/ui.ts': `element.innerHTML = userContent`,
    }

    const result = reviewFiles(files)
    const comment = result.comments.find(c => c.ruleId === 'SEC-002')
    expect(comment).toBeDefined()
    expect(comment!.severity).toBe('warning')
  })

  it('should detect hardcoded passwords', () => {
    const files = {
      'src/config.ts': `const password = "supersecret123"`,
    }

    const result = reviewFiles(files)
    const comment = result.comments.find(c => c.ruleId === 'SEC-003')
    expect(comment).toBeDefined()
    expect(comment!.severity).toBe('critical')
  })

  it('should detect SQL concatenation vulnerability', () => {
    const files = {
      'src/db.ts': 'const q = query(`SELECT * FROM users WHERE id = ${userId}`)',
    }

    const result = reviewFiles(files)
    const comment = result.comments.find(c => c.ruleId === 'SEC-005')
    expect(comment).toBeDefined()
    expect(comment!.severity).toBe('critical')
  })

  it('should detect empty catch blocks', () => {
    const files = {
      'src/handler.ts': `try { doSomething() } catch (e) {}`,
    }

    const result = reviewFiles(files)
    const comment = result.comments.find(c => c.ruleId === 'BUG-002')
    expect(comment).toBeDefined()
  })

  it('should detect console.log usage', () => {
    const files = {
      'src/service.ts': `console.log('debug info')`,
    }

    const result = reviewFiles(files)
    const comment = result.comments.find(c => c.ruleId === 'BUG-003')
    expect(comment).toBeDefined()
    expect(comment!.severity).toBe('suggestion')
  })

  it('should detect TODO/FIXME markers', () => {
    const files = {
      'src/service.ts': `// TODO: implement this properly`,
    }

    const result = reviewFiles(files)
    const comment = result.comments.find(c => c.ruleId === 'BUG-004')
    expect(comment).toBeDefined()
  })

  it('should detect JSON.parse(JSON.stringify(...)) pattern', () => {
    const files = {
      'src/utils.ts': `const clone = JSON.parse(JSON.stringify(obj))`,
    }

    const result = reviewFiles(files)
    const comment = result.comments.find(c => c.ruleId === 'PERF-002')
    expect(comment).toBeDefined()
    expect(comment!.category).toBe('performance')
  })

  it('should detect any type usage', () => {
    const files = {
      'src/service.ts': `function handle(x: any) {}`,
    }

    const result = reviewFiles(files)
    const comment = result.comments.find(c => c.ruleId === 'BP-001')
    expect(comment).toBeDefined()
    expect(comment!.category).toBe('best-practice')
  })

  it('should report no issues for clean code', () => {
    const files = {
      'src/service.ts': `import { Logger } from './logger'

const logger = new Logger()

function processItem(item: string): string {
  logger.info('Processing', { item })
  return item.toUpperCase()
}`,
    }

    const result = reviewFiles(files)
    // May still catch style rules; verify no critical/warning
    const criticalOrWarning = result.comments.filter(
      c => c.severity === 'critical' || c.severity === 'warning',
    )
    expect(criticalOrWarning).toHaveLength(0)
  })

  it('should sort comments by severity (critical first)', () => {
    const files = {
      'src/bad.ts': `console.log('debug')
const result = eval(input)`,
    }

    const result = reviewFiles(files)
    if (result.comments.length >= 2) {
      const severityOrder = { critical: 0, warning: 1, suggestion: 2 }
      for (let i = 1; i < result.comments.length; i++) {
        expect(
          severityOrder[result.comments[i]!.severity],
        ).toBeGreaterThanOrEqual(
          severityOrder[result.comments[i - 1]!.severity],
        )
      }
    }
  })

  describe('configuration', () => {
    it('should respect disabledRules', () => {
      const files = {
        'src/handler.ts': `const result = eval(userInput)`,
      }

      const result = reviewFiles(files, { disabledRules: ['SEC-001'] })
      expect(result.comments.find(c => c.ruleId === 'SEC-001')).toBeUndefined()
    })

    it('should apply custom rules', () => {
      const files = {
        'src/handler.ts': `await sleep(5000)`,
      }

      const config: CodeReviewConfig = {
        customRules: [{
          id: 'CUSTOM-001',
          name: 'no-sleep',
          category: 'performance',
          severity: 'warning',
          pattern: /\bsleep\s*\(/,
          description: 'Avoid sleep() in production code.',
          suggestion: 'Use event-driven patterns instead.',
        }],
      }

      const result = reviewFiles(files, config)
      const comment = result.comments.find(c => c.ruleId === 'CUSTOM-001')
      expect(comment).toBeDefined()
      expect(comment!.suggestion).toBe('Use event-driven patterns instead.')
    })

    it('should filter files by includePatterns', () => {
      const files = {
        'src/a.ts': `console.log('debug')`,
        'lib/b.ts': `console.log('debug')`,
      }

      const result = reviewFiles(files, { includePatterns: ['src/*'] })
      expect(result.comments.every(c => c.file.startsWith('src/'))).toBe(true)
    })

    it('should exclude files by excludePatterns', () => {
      const files = {
        'src/a.ts': `console.log('debug')`,
        'vendor/b.ts': `console.log('debug')`,
      }

      const result = reviewFiles(files, { excludePatterns: ['vendor/*'] })
      expect(result.comments.every(c => !c.file.startsWith('vendor/'))).toBe(true)
    })

    it('should filter by minSeverity', () => {
      const files = {
        'src/mixed.ts': `const result = eval(input)
console.log('debug')`,
      }

      const result = reviewFiles(files, { minSeverity: 'critical' })
      expect(result.comments.every(c => c.severity === 'critical')).toBe(true)
    })
  })

  describe('summary', () => {
    it('should produce accurate summary counts', () => {
      const files = {
        'src/mixed.ts': `const result = eval(input)
element.innerHTML = content
console.log('debug')`,
      }

      const result = reviewFiles(files)

      expect(result.summary.totalIssues).toBe(result.comments.length)
      expect(result.summary.critical + result.summary.warnings + result.summary.suggestions)
        .toBe(result.summary.totalIssues)
    })

    it('should track category counts', () => {
      const files = {
        'src/sec.ts': `const result = eval(input)`,
      }

      const result = reviewFiles(files)
      expect(result.summary.categoryCounts.security).toBeGreaterThan(0)
    })
  })
})

// ---------------------------------------------------------------------------
// reviewDiff
// ---------------------------------------------------------------------------

describe('reviewDiff', () => {
  it('should only review added lines (lines starting with +)', () => {
    const diff = `@@ -1,3 +1,5 @@
 const x = 1
+const result = eval(input)
+console.log('debug')
 const y = 2
-const old = removed`

    const comments = reviewDiff('src/handler.ts', diff)
    // Should find eval and console.log issues
    expect(comments.some(c => c.ruleId === 'SEC-001')).toBe(true)
    expect(comments.some(c => c.ruleId === 'BUG-003')).toBe(true)
  })

  it('should track correct line numbers from hunk headers', () => {
    const diff = `@@ -10,3 +15,4 @@
 const x = 1
+const result = eval(input)
 const y = 2`

    const comments = reviewDiff('src/handler.ts', diff)
    const evalComment = comments.find(c => c.ruleId === 'SEC-001')
    expect(evalComment).toBeDefined()
    // Hunk starts at line 15, context line 16, added line 16 (incremented before push)
    expect(evalComment!.line).toBe(16)
  })

  it('should return empty for clean diff', () => {
    const diff = `@@ -1,3 +1,4 @@
 const x = 1
+const y = 2
 const z = 3`

    const comments = reviewDiff('src/clean.ts', diff)
    // 'const y = 2' is clean code
    const criticalOrWarning = comments.filter(
      c => c.severity === 'critical' || c.severity === 'warning',
    )
    expect(criticalOrWarning).toHaveLength(0)
  })

  it('should respect excludePatterns', () => {
    const diff = `@@ -1,1 +1,2 @@
+const result = eval(input)`

    const comments = reviewDiff('vendor/lib.ts', diff, { excludePatterns: ['vendor/*'] })
    expect(comments).toHaveLength(0)
  })

  it('should handle multiple hunks', () => {
    const diff = `@@ -1,3 +1,4 @@
 const x = 1
+const a = eval('code1')
 const y = 2
@@ -10,3 +11,4 @@
 const z = 3
+const b = eval('code2')
 const w = 4`

    const comments = reviewDiff('src/handler.ts', diff)
    const evalComments = comments.filter(c => c.ruleId === 'SEC-001')
    expect(evalComments).toHaveLength(2)
  })

  it('should skip --- and +++ header lines', () => {
    const diff = `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,1 +1,2 @@
+const result = eval(input)`

    const comments = reviewDiff('src/file.ts', diff)
    // Should not crash on header lines, and should find the eval
    expect(comments.some(c => c.ruleId === 'SEC-001')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// formatReviewAsMarkdown
// ---------------------------------------------------------------------------

describe('formatReviewAsMarkdown', () => {
  it('should report no issues found for empty results', () => {
    const result = reviewFiles({})
    const markdown = formatReviewAsMarkdown(result)
    expect(markdown).toContain('No issues found')
  })

  it('should format issues grouped by file', () => {
    const files = {
      'src/a.ts': `const result = eval(input)`,
      'src/b.ts': `element.innerHTML = content`,
    }

    const result = reviewFiles(files)
    const markdown = formatReviewAsMarkdown(result)

    expect(markdown).toContain('Code Review Summary')
    expect(markdown).toContain('### src/a.ts')
    expect(markdown).toContain('### src/b.ts')
    expect(markdown).toContain('[CRITICAL]')
  })

  it('should include severity icons', () => {
    const files = {
      'src/mixed.ts': `const result = eval(input)
element.innerHTML = x
console.log('debug')`,
    }

    const result = reviewFiles(files)
    const markdown = formatReviewAsMarkdown(result)

    expect(markdown).toContain('[CRITICAL]')
    expect(markdown).toContain('[WARNING]')
  })

  it('should include code snippets', () => {
    const files = {
      'src/handler.ts': `const result = eval(input)`,
    }

    const result = reviewFiles(files)
    const markdown = formatReviewAsMarkdown(result)

    expect(markdown).toContain('```')
    expect(markdown).toContain('eval')
  })

  it('should include suggestions when available', () => {
    const files = {
      'src/handler.ts': `const result = eval(input)`,
    }

    const result = reviewFiles(files)
    const markdown = formatReviewAsMarkdown(result)

    // SEC-001 has a suggestion
    expect(markdown).toContain('>')
  })

  it('should show summary counts', () => {
    const files = {
      'src/handler.ts': `const result = eval(input)`,
    }

    const result = reviewFiles(files)
    const markdown = formatReviewAsMarkdown(result)

    expect(markdown).toContain('Critical:')
    expect(markdown).toContain('Warnings:')
    expect(markdown).toContain('Suggestions:')
  })
})

// ---------------------------------------------------------------------------
// Contract Validator
// ---------------------------------------------------------------------------

describe('Contract Validator', () => {
  describe('extractEndpoints', () => {
    it('should extract Express-style route definitions', () => {
      const files = {
        'src/routes.ts': `router.get('/api/users', handler)
router.post('/api/users', createHandler)
app.put('/api/users/:id', updateHandler)
app.delete('/api/users/:id', deleteHandler)`,
      }

      const endpoints = extractEndpoints(files)
      expect(endpoints).toHaveLength(4)
      expect(endpoints.map(e => e.method)).toEqual(['GET', 'POST', 'PUT', 'DELETE'])
    })

    it('should capture file and line information', () => {
      const files = {
        'src/routes.ts': `// setup
router.get('/api/health', handler)`,
      }

      const endpoints = extractEndpoints(files)
      expect(endpoints[0]!.file).toBe('src/routes.ts')
      expect(endpoints[0]!.line).toBe(2)
    })

    it('should return empty for files with no routes', () => {
      const files = {
        'src/utils.ts': `export function helper() {}`,
      }

      expect(extractEndpoints(files)).toHaveLength(0)
    })
  })

  describe('extractAPICalls', () => {
    it('should extract axios-style API calls', () => {
      const files = {
        'src/api.ts': `const users = await axios.get('/api/users')
await api.post('/api/users', data)`,
      }

      const calls = extractAPICalls(files)
      expect(calls).toHaveLength(2)
      expect(calls[0]!.method).toBe('GET')
      expect(calls[1]!.method).toBe('POST')
    })

    it('should extract fetch() calls with default GET method', () => {
      const files = {
        'src/api.ts': `const response = await fetch('/api/users')`,
      }

      const calls = extractAPICalls(files)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.method).toBe('GET')
    })

    it('should extract fetch() calls with explicit method', () => {
      const files = {
        'src/api.ts': `const response = await fetch('/api/users', {
  method: 'POST',
  body: JSON.stringify(data)
})`,
      }

      const calls = extractAPICalls(files)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.method).toBe('POST')
    })
  })

  describe('validateContracts', () => {
    it('should pass when all calls match endpoints', () => {
      const backend = {
        'src/routes.ts': `router.get('/api/users', handler)
router.post('/api/users', createHandler)`,
      }
      const frontend = {
        'src/api.ts': `axios.get('/api/users')
api.post('/api/users', data)`,
      }

      const result = validateContracts(backend, frontend)
      expect(result.valid).toBe(true)
    })

    it('should detect unmatched frontend calls', () => {
      const backend = {
        'src/routes.ts': `router.get('/api/users', handler)`,
      }
      const frontend = {
        'src/api.ts': `axios.get('/api/users')
axios.get('/api/posts')`,
      }

      const result = validateContracts(backend, frontend)
      expect(result.valid).toBe(false)
      expect(result.issues.some(i => i.type === 'unmatched-call')).toBe(true)
      expect(result.issues.some(i => i.description.includes('/api/posts'))).toBe(true)
    })

    it('should detect method mismatches', () => {
      const backend = {
        'src/routes.ts': `router.get('/api/users', handler)`,
      }
      const frontend = {
        'src/api.ts': `api.post('/api/users', data)`,
      }

      const result = validateContracts(backend, frontend)
      expect(result.valid).toBe(false)
      expect(result.issues.some(i => i.type === 'method-mismatch')).toBe(true)
    })

    it('should report unmatched endpoints as informational (not invalid)', () => {
      const backend = {
        'src/routes.ts': `router.get('/api/users', handler)
router.get('/api/health', healthHandler)`,
      }
      const frontend = {
        'src/api.ts': `axios.get('/api/users')`,
      }

      const result = validateContracts(backend, frontend)
      // valid because there are no unmatched calls or method mismatches
      expect(result.valid).toBe(true)
      // But there should be an unmatched-endpoint issue
      expect(result.issues.some(i => i.type === 'unmatched-endpoint')).toBe(true)
    })

    it('should handle empty file sets', () => {
      const result = validateContracts({}, {})
      expect(result.valid).toBe(true)
      expect(result.issues).toHaveLength(0)
    })

    it('should normalize paths (trailing slash, case)', () => {
      const backend = {
        'src/routes.ts': `router.get('/api/Users/', handler)`,
      }
      const frontend = {
        'src/api.ts': `axios.get('/api/users')`,
      }

      const result = validateContracts(backend, frontend)
      // Path normalization should make these match
      expect(result.valid).toBe(true)
    })
  })
})
