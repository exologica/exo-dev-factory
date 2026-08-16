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
})
