import { describe, it, expect } from 'vitest'
import { quickSyntaxCheck } from '../tools/lint-validator.js'

describe('quickSyntaxCheck', () => {
  it('returns valid for well-formed TypeScript', () => {
    const content = `
export function greet(name: string): string {
  if (name === 'world') {
    return 'Hello, World!'
  }
  return \`Hello, \${name}!\`
}
`
    const result = quickSyntaxCheck('src/greet.ts', content)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('detects unclosed braces', () => {
    const content = `
function broken() {
  if (true) {
    console.log('missing close')
`
    const result = quickSyntaxCheck('src/broken.ts', content)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('unclosed brace'))).toBe(true)
  })

  it('detects extra closing bracket', () => {
    const content = `const arr = [1, 2, 3]]`
    const result = quickSyntaxCheck('src/extra.ts', content)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('Unexpected closing bracket'))).toBe(true)
  })

  it('detects unclosed parentheses', () => {
    const content = `const x = add(1, 2`
    const result = quickSyntaxCheck('src/paren.ts', content)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('unclosed paren'))).toBe(true)
  })

  it('detects unterminated block comment', () => {
    const content = `/* this comment never ends\nconst x = 1;`
    const result = quickSyntaxCheck('src/comment.ts', content)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('block comment'))).toBe(true)
  })

  it('ignores braces inside strings', () => {
    const content = `const s = "{ not a real brace }"\nconst t = '[ also not ]'\n`
    const result = quickSyntaxCheck('src/strings.ts', content)
    expect(result.valid).toBe(true)
  })

  it('ignores braces inside template literals', () => {
    const content = 'const s = `template with ${expr} and { brace }`\n'
    const result = quickSyntaxCheck('src/template.ts', content)
    expect(result.valid).toBe(true)
  })

  it('ignores braces in line comments', () => {
    const content = `const x = 1 // { this is a comment }\n`
    const result = quickSyntaxCheck('src/linecomment.ts', content)
    expect(result.valid).toBe(true)
  })

  it('ignores braces in block comments', () => {
    const content = `/* { not real } */\nconst x = 1\n`
    const result = quickSyntaxCheck('src/blockcomment.ts', content)
    expect(result.valid).toBe(true)
  })

  it('skips non-TS/JS files', () => {
    const result = quickSyntaxCheck('README.md', '{{{{ broken }}}')
    expect(result.valid).toBe(true)
  })
})
