import { describe, expect, it } from 'vitest'
import { parseFilterExpression, getAstDepth, countAstNodes, type FilterExpr, type ComparisonExpr, type LogicalExpr, type NotExpr } from '../../src/domain/filter-parser.js'
import { evaluateFilter } from '../../src/domain/filter-evaluator.js'
import type { Trace } from '../../src/domain/trace.js'

function assertComparison(expr: FilterExpr): ComparisonExpr {
  expect(expr.type).toBe('comparison')
  return expr as ComparisonExpr
}

function assertLogical(expr: FilterExpr): LogicalExpr {
  expect(expr.type).toBe('logical')
  return expr as LogicalExpr
}

function assertNot(expr: FilterExpr): NotExpr {
  expect(expr.type).toBe('not')
  return expr as NotExpr
}

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    id: 'test-id',
    name: 'test-service',
    startTime: '2026-08-16T10:00:00.000Z',
    endTime: '2026-08-16T10:00:01.000Z',
    spans: [
      {
        id: 'span-1',
        name: 'llm-call',
        startTime: '2026-08-16T10:00:00.000Z',
        endTime: '2026-08-16T10:00:00.500Z',
        status: 'ok'
      }
    ],
    sessionId: 'session-123',
    userId: 'user-456',
    ...overrides
  }
}

describe('filter-parser', () => {
  describe('parseFilterExpression', () => {
    it('parses simple field equality', () => {
      const result = parseFilterExpression('status:error')
      expect(result.errors).toHaveLength(0)
      expect(result.ast).toBeDefined()
      const ast = assertComparison(result.ast!)
      expect(ast.op).toBe(':')
      expect(ast.left.path).toEqual(['status'])
      expect(ast.right.value).toBe('error')
    })

    it('parses numeric comparison', () => {
      const result = parseFilterExpression('duration_ms>1000')
      expect(result.errors).toHaveLength(0)
      const ast = assertComparison(result.ast!)
      expect(ast.op).toBe('>')
      expect(ast.left.path).toEqual(['duration_ms'])
      expect(ast.right.value).toBe(1000)
    })

    it('parses field with dots', () => {
      const result = parseFilterExpression('span.name:chat')
      expect(result.errors).toHaveLength(0)
      const ast = assertComparison(result.ast!)
      expect(ast.left.path).toEqual(['span', 'name'])
    })

    it('parses AND logic', () => {
      const result = parseFilterExpression('status:error AND duration_ms>5000')
      expect(result.errors).toHaveLength(0)
      const ast = assertLogical(result.ast!)
      expect(ast.op).toBe('AND')
    })

    it('parses OR logic', () => {
      const result = parseFilterExpression('service_name:chat OR service_name:api')
      expect(result.errors).toHaveLength(0)
      const ast = assertLogical(result.ast!)
      expect(ast.op).toBe('OR')
    })

    it('parses NOT logic', () => {
      const result = parseFilterExpression('NOT status:ok')
      expect(result.errors).toHaveLength(0)
      const ast = assertNot(result.ast!)
    })

    it('parses parentheses for grouping', () => {
      const result = parseFilterExpression('(service_name:chat OR service_name:api) AND status:error')
      expect(result.errors).toHaveLength(0)
      const ast = assertLogical(result.ast!)
      expect(ast.op).toBe('AND')
    })

    it('parses string literals with single quotes', () => {
      const result = parseFilterExpression("name:'my service'")
      expect(result.errors).toHaveLength(0)
      const ast = assertComparison(result.ast!)
      expect(ast.right.value).toBe('my service')
    })

    it('parses boolean literals', () => {
      const result = parseFilterExpression('span.status==true')
      expect(result.errors).toHaveLength(0)
      const ast = assertComparison(result.ast!)
      expect(ast.right.value).toBe(true)
    })

    it('parses null literals', () => {
      const result = parseFilterExpression('sessionId==null')
      expect(result.errors).toHaveLength(0)
      const ast = assertComparison(result.ast!)
      expect(ast.right.value).toBe(null)
    })

    it('parses float numbers', () => {
      const result = parseFilterExpression('usage.totalCost>0.001')
      expect(result.errors).toHaveLength(0)
      const ast = assertComparison(result.ast!)
      expect(ast.right.value).toBe(0.001)
    })

    it('parses negative numbers', () => {
      const result = parseFilterExpression('duration_ms>-100')
      expect(result.errors).toHaveLength(0)
      const ast = assertComparison(result.ast!)
      expect(ast.right.value).toBe(-100)
    })

    it('parses all comparison operators', () => {
      const ops = ['==', '!=', '>', '>=', '<', '<=', ':', '!~']
      for (const op of ops) {
        const result = parseFilterExpression(`field${op}value`)
        expect(result.errors).toHaveLength(0)
        const ast = assertComparison(result.ast!)
        expect(ast.op).toBe(op)
      }
    })

    it('handles precedence: NOT > AND > OR', () => {
      // NOT binds tightest
      let result = parseFilterExpression('NOT a:b AND c:d')
      let ast = assertLogical(result.ast!)
      expect(ast.op).toBe('AND')
      const notExpr = assertNot(ast.left)
      expect(notExpr.expr.type).toBe('comparison')

      // AND binds tighter than OR
      result = parseFilterExpression('a:b OR c:d AND e:f')
      ast = assertLogical(result.ast!)
      expect(ast.op).toBe('OR')
      const rightAnd = assertLogical(ast.right)
      expect(rightAnd.op).toBe('AND')
    })

    it('rejects invalid syntax', () => {
      const result = parseFilterExpression('status:')
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.ast).toBeNull()
    })

    it('rejects unknown operators', () => {
      const result = parseFilterExpression('status~=error')
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('rejects unmatched parentheses', () => {
      const result = parseFilterExpression('(status:error')
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('rejects empty input', () => {
      const result = parseFilterExpression('')
      expect(result.errors.length).toBeGreaterThan(0)
    })
  })

  describe('getAstDepth', () => {
    it('returns 1 for comparison', () => {
      const result = parseFilterExpression('a:b')
      expect(getAstDepth(result.ast!)).toBe(1)
    })

    it('returns depth for NOT', () => {
      const result = parseFilterExpression('NOT a:b')
      expect(getAstDepth(result.ast!)).toBe(2)
    })

    it('returns depth for nested logical', () => {
      const result = parseFilterExpression('a:b AND c:d OR e:f')
      expect(getAstDepth(result.ast!)).toBe(3)
    })
  })

  describe('countAstNodes', () => {
    it('returns 1 for comparison', () => {
      const result = parseFilterExpression('a:b')
      expect(countAstNodes(result.ast!)).toBe(1)
    })

    it('counts nodes in logical', () => {
      const result = parseFilterExpression('a:b AND c:d')
      expect(countAstNodes(result.ast!)).toBe(3)
    })
  })
})

describe('filter-evaluator', () => {
  describe('evaluateFilter', () => {
    it('matches status:error', () => {
      const trace = makeTrace({
        spans: [{ id: 's1', name: 'x', startTime: '2026-08-16T10:00:00.000Z', endTime: '2026-08-16T10:00:01.000Z', status: 'error' }]
      })
      const result = parseFilterExpression('status:error')
      console.log('DEBUG status:error trace:', trace)
      console.log('DEBUG status:error result:', evaluateFilter(result.ast!, trace))
      expect(evaluateFilter(result.ast!, trace).matches).toBe(true)
    })

    it('matches status:ok', () => {
      const trace = makeTrace()
      const result = parseFilterExpression('status:ok')
      expect(evaluateFilter(result.ast!, trace).matches).toBe(true)
    })

    it('matches sessionId', () => {
      const trace = makeTrace({ sessionId: 'session-123' })
      const result = parseFilterExpression('sessionId:session-123')
      expect(evaluateFilter(result.ast!, trace).matches).toBe(true)
    })

    it('matches userId', () => {
      const trace = makeTrace({ userId: 'user-456' })
      const result = parseFilterExpression('userId:user-456')
      expect(evaluateFilter(result.ast!, trace).matches).toBe(true)
    })

    it('matches span.name', () => {
      const trace = makeTrace({
        spans: [{ id: 's1', name: 'llm-call', startTime: '2026-08-16T10:00:00.000Z', endTime: '2026-08-16T10:00:01.000Z', status: 'ok' }]
      })
      const result = parseFilterExpression('span.name:llm-call')
      expect(evaluateFilter(result.ast!, trace).matches).toBe(true)
    })

    it('matches span.status', () => {
      const trace = makeTrace({
        spans: [{ id: 's1', name: 'x', startTime: '2026-08-16T10:00:00.000Z', endTime: '2026-08-16T10:00:01.000Z', status: 'error' }]
      })
      const result = parseFilterExpression('span.status:error')
      expect(evaluateFilter(result.ast!, trace).matches).toBe(true)
    })

    it('handles span.attributes', () => {
      const trace = makeTrace({
        spans: [{
          id: 's1',
          name: 'x',
          startTime: '2026-08-16T10:00:00.000Z',
          endTime: '2026-08-16T10:00:01.000Z',
          status: 'ok',
          attributes: { 'llm.model': 'gpt-4o', 'custom.field': 'value' }
        }]
      })
      const result = parseFilterExpression('span.attributes.llm.model:gpt-4o')
      expect(evaluateFilter(result.ast!, trace).matches).toBe(true)
    })

    it('handles grouped expressions with parentheses', () => {
      const trace = makeTrace({
        name: 'chat-service',
        spans: [{ id: 's1', name: 'x', startTime: '2026-08-16T10:00:00.000Z', endTime: '2026-08-16T10:00:01.000Z', status: 'error' }]
      })
      const result = parseFilterExpression('(name:chat OR name:api) AND status:error')
      expect(evaluateFilter(result.ast!, trace).matches).toBe(true)
    })

    it('handles complex nested expression', () => {
      const trace = makeTrace({
        name: 'chat-service',
        startTime: '2026-08-16T10:00:00.000Z',
        endTime: '2026-08-16T10:00:05.000Z',
        spans: [{ id: 's1', name: 'llm-call', startTime: '2026-08-16T10:00:00.000Z', endTime: '2026-08-16T10:00:05.000Z', status: 'error' }]
      })
      const result = parseFilterExpression('(name:chat AND duration_ms>1000) OR (status:ok AND span.name:llm-call)')
      console.log('DEBUG complex parse:', JSON.stringify(result.ast, null, 2))
      if (result.ast) {
        const evalResult = evaluateFilter(result.ast, trace)
        console.log('DEBUG complex eval:', evalResult)
      }
      expect(evaluateFilter(result.ast!, trace).matches).toBe(true)
    })
  })
})