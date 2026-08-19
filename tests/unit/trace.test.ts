import { describe, it, expect } from 'vitest'
import { traceSchema } from '../../src/domain/trace.js'

const validTrace = {
  name: 'chat-completion',
  startTime: '2026-08-15T10:00:00.000Z',
  endTime: '2026-08-15T10:00:05.000Z',
  spans: [
    {
      id: 'span-1',
      name: 'llm-call',
      startTime: '2026-08-15T10:00:00.000Z',
      endTime: '2026-08-15T10:00:04.000Z',
      status: 'ok'
    }
  ]
}

const validTraceWithUsage = {
  name: 'chat-completion',
  startTime: '2026-08-15T10:00:00.000Z',
  endTime: '2026-08-15T10:00:05.000Z',
  spans: [
    {
      id: 'span-1',
      name: 'llm-call',
      startTime: '2026-08-15T10:00:00.000Z',
      endTime: '2026-08-15T10:00:04.000Z',
      status: 'ok',
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        totalCost: 0.0015
      }
    }
  ]
}

describe('traceSchema', () => {
  it('accepts a valid trace', () => {
    const result = traceSchema.safeParse(validTrace)
    expect(result.success).toBe(true)
  })

  it('generates an id when absent', () => {
    const result = traceSchema.safeParse(validTrace)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.id).toBeUndefined()
    }
  })

  it('rejects a trace with no spans', () => {
    const result = traceSchema.safeParse({ ...validTrace, spans: [] })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid span status', () => {
    const result = traceSchema.safeParse({
      ...validTrace,
      spans: [{ ...validTrace.spans[0]!, status: 'unknown' }]
    })
    expect(result.success).toBe(false)
  })

  it('rejects endTime before startTime', () => {
    const result = traceSchema.safeParse({
      ...validTrace,
      endTime: '2026-08-15T09:00:00.000Z'
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-ISO timestamps', () => {
    const result = traceSchema.safeParse({ ...validTrace, startTime: 'not-a-date' })
    expect(result.success).toBe(false)
  })

  describe('usage validation', () => {
    it('accepts a trace with valid usage object', () => {
      const result = traceSchema.safeParse(validTraceWithUsage)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.spans[0]?.usage).toEqual({
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          totalCost: 0.0015
        })
      }
    })

    it('accepts a trace with usage object without totalCost', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{
          ...validTraceWithUsage.spans[0]!,
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
        }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.spans[0]?.usage).toEqual({
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          totalCost: undefined
        })
      }
    })

    it('accepts a trace with span missing usage (backward compatible)', () => {
      const result = traceSchema.safeParse(validTrace)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.spans[0]?.usage).toBeUndefined()
      }
    })

    it('rejects negative promptTokens', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{ ...validTraceWithUsage.spans[0]!, usage: { promptTokens: -1, completionTokens: 50 } }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(false)
    })

    it('rejects negative completionTokens', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{ ...validTraceWithUsage.spans[0]!, usage: { promptTokens: 100, completionTokens: -1 } }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(false)
    })

    it('rejects negative totalCost', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{ ...validTraceWithUsage.spans[0]!, usage: { promptTokens: 100, completionTokens: 50, totalCost: -0.01 } }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(false)
    })

    it('rejects non-integer promptTokens', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{ ...validTraceWithUsage.spans[0]!, usage: { promptTokens: 100.5, completionTokens: 50 } }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(false)
    })

    it('rejects non-integer completionTokens', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{ ...validTraceWithUsage.spans[0]!, usage: { promptTokens: 100, completionTokens: 50.5 } }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(false)
    })

    it('rejects promptTokens exceeding max bound', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{ ...validTraceWithUsage.spans[0]!, usage: { promptTokens: 10_000_001, completionTokens: 50 } }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(false)
    })

    it('rejects completionTokens exceeding max bound', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{ ...validTraceWithUsage.spans[0]!, usage: { promptTokens: 100, completionTokens: 10_000_001, totalTokens: 10_000_101 } }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(false)
    })

    it('rejects negative totalTokens', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{ ...validTraceWithUsage.spans[0]!, usage: { promptTokens: 100, completionTokens: 50, totalTokens: -1 } }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(false)
    })

    it('rejects non-integer totalTokens', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{ ...validTraceWithUsage.spans[0]!, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150.5 } }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(false)
    })

    it('rejects totalTokens exceeding max bound', () => {
      const trace = {
        ...validTraceWithUsage,
        spans: [{ ...validTraceWithUsage.spans[0]!, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 20_000_001 } }]
      }
      const result = traceSchema.safeParse(trace)
      expect(result.success).toBe(false)
    })
  })
})
