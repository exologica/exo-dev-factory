import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TraceStore } from '../../src/domain/store.js'
import type { Trace } from '../../src/domain/trace.js'

function makeTrace(
  startTime: string,
  name = 'trace',
  spanStatus: 'ok' | 'error' = 'ok',
  usage?: { promptTokens: number; completionTokens: number; totalCost?: number },
  model?: string,
  sessionId?: string,
  userId?: string
): Trace {
  return {
    name,
    startTime,
    endTime: new Date(Date.parse(startTime) + 1000).toISOString(),
    sessionId,
    userId,
    spans: [
      {
        id: `span-${startTime}`,
        name: 'llm-call',
        startTime,
        endTime: new Date(Date.parse(startTime) + 500).toISOString(),
        status: spanStatus,
        usage,
        attributes: model ? { 'llm.model': model } : undefined
      }
    ]
  }
}

describe('TraceStore cost aggregation', () => {
  let dir: string
  let dbPath: string
  let store: TraceStore

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exo-store-cost-'))
    dbPath = path.join(dir, 'traces.db')
    store = new TraceStore({ dbPath })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('getTraceCost', () => {
    it('returns cost breakdown for trace with usage', () => {
      const trace = makeTrace(
        '2026-08-15T10:00:00.000Z',
        'cost-trace',
        'ok',
        { promptTokens: 1_000_000, completionTokens: 500_000 },
        'gpt-4o'
      )
      const id = store.add(trace)

      const cost = store.getTraceCost(id)
      expect(cost).toBeDefined()
      expect(cost?.traceId).toBe(id)
      expect(cost?.promptTokens).toBe(1_000_000)
      expect(cost?.completionTokens).toBe(500_000)
      // gpt-4o: $2.50/1M input, $10.00/1M output
      // 1M * 250/1M = 250 cents, 500K * 1000/1M = 500 cents = 750 cents = $7.50
      expect(cost?.totalCostCents).toBe(750)
      expect(cost?.totalCostDollars).toBe(7.50)
    })

    it('returns undefined for non-existent trace', () => {
      const cost = store.getTraceCost('non-existent')
      expect(cost).toBeUndefined()
    })

    it('returns zero cost for trace without usage', () => {
      const trace = makeTrace('2026-08-15T10:00:00.000Z', 'no-usage')
      const id = store.add(trace)

      const cost = store.getTraceCost(id)
      expect(cost).toBeDefined()
      expect(cost?.promptTokens).toBe(0)
      expect(cost?.completionTokens).toBe(0)
      expect(cost?.totalCostCents).toBe(0)
      expect(cost?.totalCostDollars).toBe(0)
    })

    it('uses default model when llm.model attribute missing', () => {
      const trace = makeTrace(
        '2026-08-15T10:00:00.000Z',
        'default-model',
        'ok',
        { promptTokens: 1_000_000, completionTokens: 1_000_000 }
        // no model attribute - should default to gpt-4o
      )
      const id = store.add(trace)

      const cost = store.getTraceCost(id)
      expect(cost?.totalCostCents).toBe(1250) // gpt-4o default
    })

    it('sums cost across multiple spans', () => {
      const trace: Trace = {
        name: 'multi-span',
        startTime: '2026-08-15T10:00:00.000Z',
        endTime: '2026-08-15T10:00:10.000Z',
        spans: [
          {
            id: 'span-1',
            name: 'llm-call-1',
            startTime: '2026-08-15T10:00:00.000Z',
            endTime: '2026-08-15T10:00:05.000Z',
            status: 'ok',
            usage: { promptTokens: 500_000, completionTokens: 250_000 },
            attributes: { 'llm.model': 'gpt-4o' }
          },
          {
            id: 'span-2',
            name: 'llm-call-2',
            startTime: '2026-08-15T10:00:05.000Z',
            endTime: '2026-08-15T10:00:10.000Z',
            status: 'ok',
            usage: { promptTokens: 500_000, completionTokens: 250_000 },
            attributes: { 'llm.model': 'gpt-4o' }
          }
        ]
      }
      const id = store.add(trace)

      const cost = store.getTraceCost(id)
      // Each span: 500K * 250/1M = 125 cents input, 250K * 1000/1M = 250 cents output = 375 cents
      // Two spans = 750 cents
      expect(cost?.totalCostCents).toBe(750)
    })
  })

  describe('getSessionCost', () => {
    it('aggregates cost across all traces in a session', () => {
      store.add(makeTrace('2026-08-15T10:00:00.000Z', 'trace-1', 'ok', { promptTokens: 1_000_000, completionTokens: 500_000 }, 'gpt-4o', 'session-1'))
      store.add(makeTrace('2026-08-15T11:00:00.000Z', 'trace-2', 'ok', { promptTokens: 500_000, completionTokens: 250_000 }, 'gpt-4o', 'session-1'))
      store.add(makeTrace('2026-08-15T12:00:00.000Z', 'trace-3', 'ok', { promptTokens: 2_000_000, completionTokens: 1_000_000 }, 'gpt-4o', 'session-2'))

      const cost = store.getSessionCost('session-1')
      expect(cost.sessionId).toBe('session-1')
      expect(cost.traceCount).toBe(2)
      expect(cost.promptTokens).toBe(1_500_000)
      expect(cost.completionTokens).toBe(750_000)
      // trace-1: 750 cents, trace-2: 375 cents = 1125 cents
      expect(cost.totalCostCents).toBe(1125)
      expect(cost.totalCostDollars).toBe(11.25)
    })

    it('returns zero for session with no traces', () => {
      const cost = store.getSessionCost('empty-session')
      expect(cost.sessionId).toBe('empty-session')
      expect(cost.traceCount).toBe(0)
      expect(cost.promptTokens).toBe(0)
      expect(cost.completionTokens).toBe(0)
      expect(cost.totalCostCents).toBe(0)
      expect(cost.totalCostDollars).toBe(0)
    })

    it('handles traces without usage in session', () => {
      store.add(makeTrace('2026-08-15T10:00:00.000Z', 'no-usage', 'ok', undefined, undefined, 'session-mixed'))
      store.add(makeTrace('2026-08-15T11:00:00.000Z', 'with-usage', 'ok', { promptTokens: 1_000_000, completionTokens: 500_000 }, 'gpt-4o', 'session-mixed'))

      const cost = store.getSessionCost('session-mixed')
      expect(cost.traceCount).toBe(2)
      expect(cost.promptTokens).toBe(1_000_000)
      expect(cost.completionTokens).toBe(500_000)
      expect(cost.totalCostCents).toBe(750)
    })
  })

  describe('getTimeWindowCost', () => {
    it('aggregates cost within time window', () => {
      // Use timestamps relative to now so they fall within the window
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()
      const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString()

      store.add(makeTrace(oneHourAgo, 'recent-1', 'ok', { promptTokens: 1_000_000, completionTokens: 500_000 }, 'gpt-4o'))
      store.add(makeTrace(twoHoursAgo, 'recent-2', 'ok', { promptTokens: 500_000, completionTokens: 250_000 }, 'gpt-4o'))
      store.add(makeTrace(threeHoursAgo, 'old', 'ok', { promptTokens: 2_000_000, completionTokens: 1_000_000 }, 'gpt-4o'))

      // 4-hour window should include all three traces
      const cost = store.getTimeWindowCost(4)
      expect(cost.windowHours).toBe(4)
      expect(cost.traceCount).toBe(3)
      expect(cost.promptTokens).toBe(3_500_000)
      expect(cost.completionTokens).toBe(1_750_000)
    })

    it('returns zero for window with no traces', () => {
      const cost = store.getTimeWindowCost(1)
      expect(cost.windowHours).toBe(1)
      expect(cost.traceCount).toBe(0)
      expect(cost.totalCostCents).toBe(0)
    })

    it('handles different models in window', () => {
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()

      store.add(makeTrace(oneHourAgo, 'gpt4o-trace', 'ok', { promptTokens: 1_000_000, completionTokens: 1_000_000 }, 'gpt-4o'))
      store.add(makeTrace(oneHourAgo, 'claude-trace', 'ok', { promptTokens: 1_000_000, completionTokens: 1_000_000 }, 'claude-3-5-sonnet-20241022'))

      const cost = store.getTimeWindowCost(2)
      expect(cost.traceCount).toBe(2)
      // gpt-4o: 1250 cents, claude: 1800 cents = 3050 cents
      expect(cost.totalCostCents).toBe(3050)
    })
  })

  describe('getTraceUsage', () => {
    it('returns usage breakdown for trace with usage', () => {
      const trace = makeTrace(
        '2026-08-15T10:00:00.000Z',
        'usage-trace',
        'ok',
        { promptTokens: 1_000_000, completionTokens: 500_000, totalCost: 7.50 },
        'gpt-4o'
      )
      const id = store.add(trace)

      const usage = store.getTraceUsage(id)
      expect(usage).toBeDefined()
      expect(usage?.traceId).toBe(id)
      expect(usage?.promptTokens).toBe(1_000_000)
      expect(usage?.completionTokens).toBe(500_000)
      expect(usage?.totalTokens).toBe(1_500_000)
      expect(usage?.totalCost).toBe(7.50)
      expect(usage?.spanCount).toBe(1)
    })

    it('returns undefined for non-existent trace', () => {
      const usage = store.getTraceUsage('non-existent')
      expect(usage).toBeUndefined()
    })

    it('returns zeros for trace without usage (backward compatibility)', () => {
      const trace = makeTrace('2026-08-15T10:00:00.000Z', 'no-usage')
      const id = store.add(trace)

      const usage = store.getTraceUsage(id)
      expect(usage).toBeDefined()
      expect(usage?.promptTokens).toBe(0)
      expect(usage?.completionTokens).toBe(0)
      expect(usage?.totalTokens).toBe(0)
      expect(usage?.totalCost).toBe(0)
      expect(usage?.spanCount).toBe(1)
    })

    it('sums usage across multiple spans', () => {
      const trace: Trace = {
        name: 'multi-span',
        startTime: '2026-08-15T10:00:00.000Z',
        endTime: '2026-08-15T10:00:10.000Z',
        spans: [
          {
            id: 'span-1',
            name: 'llm-call-1',
            startTime: '2026-08-15T10:00:00.000Z',
            endTime: '2026-08-15T10:00:05.000Z',
            status: 'ok',
            usage: { promptTokens: 500_000, completionTokens: 250_000, totalTokens: 750_000, totalCost: 3.75 }
          },
          {
            id: 'span-2',
            name: 'llm-call-2',
            startTime: '2026-08-15T10:00:05.000Z',
            endTime: '2026-08-15T10:00:10.000Z',
            status: 'ok',
            usage: { promptTokens: 500_000, completionTokens: 250_000, totalTokens: 750_000, totalCost: 3.75 }
          }
        ]
      }
      const id = store.add(trace)

      const usage = store.getTraceUsage(id)
      expect(usage?.promptTokens).toBe(1_000_000)
      expect(usage?.completionTokens).toBe(500_000)
      expect(usage?.totalTokens).toBe(1_500_000)
      expect(usage?.totalCost).toBe(7.50)
      expect(usage?.spanCount).toBe(2)
    })

    it('handles partial usage fields (missing totalTokens, totalCost)', () => {
      const trace: Trace = {
        name: 'partial-usage',
        startTime: '2026-08-15T10:00:00.000Z',
        endTime: '2026-08-15T10:00:10.000Z',
        spans: [
          {
            id: 'span-1',
            name: 'llm-call-1',
            startTime: '2026-08-15T10:00:00.000Z',
            endTime: '2026-08-15T10:00:05.000Z',
            status: 'ok',
            usage: { promptTokens: 100, completionTokens: 50 } // no totalTokens, no totalCost
          }
        ]
      }
      const id = store.add(trace)

      const usage = store.getTraceUsage(id)
      expect(usage?.promptTokens).toBe(100)
      expect(usage?.completionTokens).toBe(50)
      expect(usage?.totalTokens).toBe(150) // computed from prompt + completion
      expect(usage?.totalCost).toBe(0)
      expect(usage?.spanCount).toBe(1)
    })
  })

  describe('getUsageSummary', () => {
    it('aggregates usage across all traces', () => {
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()

      store.add(makeTrace(oneHourAgo, 'trace-1', 'ok', { promptTokens: 1_000_000, completionTokens: 500_000, totalCost: 7.50 }, 'gpt-4o'))
      store.add(makeTrace(twoHoursAgo, 'trace-2', 'ok', { promptTokens: 500_000, completionTokens: 250_000, totalCost: 3.75 }, 'gpt-4o'))

      const usage = store.getUsageSummary()
      expect(usage.promptTokens).toBe(1_500_000)
      expect(usage.completionTokens).toBe(750_000)
      expect(usage.totalTokens).toBe(2_250_000)
      expect(usage.totalCost).toBe(11.25)
      expect(usage.traceCount).toBe(2)
      expect(usage.spanCount).toBe(2)
    })

    it('filters by sessionId', () => {
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()

      store.add(makeTrace(oneHourAgo, 'trace-1', 'ok', { promptTokens: 1_000_000, completionTokens: 500_000, totalCost: 7.50 }, 'gpt-4o', 'session-1'))
      store.add(makeTrace(oneHourAgo, 'trace-2', 'ok', { promptTokens: 500_000, completionTokens: 250_000, totalCost: 3.75 }, 'gpt-4o', 'session-2'))

      const usage = store.getUsageSummary({ sessionId: 'session-1' })
      expect(usage.promptTokens).toBe(1_000_000)
      expect(usage.completionTokens).toBe(500_000)
      expect(usage.totalCost).toBe(7.50)
      expect(usage.traceCount).toBe(1)
      expect(usage.spanCount).toBe(1)
    })

    it('filters by userId', () => {
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()

      store.add(makeTrace(oneHourAgo, 'trace-1', 'ok', { promptTokens: 1_000_000, completionTokens: 500_000, totalCost: 7.50 }, 'gpt-4o', undefined, 'user-1'))
      store.add(makeTrace(oneHourAgo, 'trace-2', 'ok', { promptTokens: 500_000, completionTokens: 250_000, totalCost: 3.75 }, 'gpt-4o', undefined, 'user-2'))

      const usage = store.getUsageSummary({ userId: 'user-1' })
      expect(usage.promptTokens).toBe(1_000_000)
      expect(usage.traceCount).toBe(1)
    })

    it('filters by since (ISO 8601)', () => {
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()
      const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString()

      store.add(makeTrace(oneHourAgo, 'recent-1', 'ok', { promptTokens: 1_000_000, completionTokens: 500_000, totalCost: 7.50 }, 'gpt-4o'))
      store.add(makeTrace(twoHoursAgo, 'recent-2', 'ok', { promptTokens: 500_000, completionTokens: 250_000, totalCost: 3.75 }, 'gpt-4o'))
      store.add(makeTrace(threeHoursAgo, 'old', 'ok', { promptTokens: 2_000_000, completionTokens: 1_000_000, totalCost: 15.00 }, 'gpt-4o'))

      const usage = store.getUsageSummary({ since: oneHourAgo })
      expect(usage.traceCount).toBe(1)
      expect(usage.promptTokens).toBe(1_000_000)
    })

    it('filters by until (ISO 8601)', () => {
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()
      const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString()

      store.add(makeTrace(oneHourAgo, 'recent-1', 'ok', { promptTokens: 1_000_000, completionTokens: 500_000, totalCost: 7.50 }, 'gpt-4o'))
      store.add(makeTrace(twoHoursAgo, 'recent-2', 'ok', { promptTokens: 500_000, completionTokens: 250_000, totalCost: 3.75 }, 'gpt-4o'))
      store.add(makeTrace(threeHoursAgo, 'old', 'ok', { promptTokens: 2_000_000, completionTokens: 1_000_000, totalCost: 15.00 }, 'gpt-4o'))

      const usage = store.getUsageSummary({ until: twoHoursAgo })
      expect(usage.traceCount).toBe(2)
      expect(usage.promptTokens).toBe(2_500_000)
    })

    it('filters by since and until combined', () => {
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()
      const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString()

      store.add(makeTrace(oneHourAgo, 'recent-1', 'ok', { promptTokens: 1_000_000, completionTokens: 500_000, totalCost: 7.50 }, 'gpt-4o'))
      store.add(makeTrace(twoHoursAgo, 'recent-2', 'ok', { promptTokens: 500_000, completionTokens: 250_000, totalCost: 3.75 }, 'gpt-4o'))
      store.add(makeTrace(threeHoursAgo, 'old', 'ok', { promptTokens: 2_000_000, completionTokens: 1_000_000, totalCost: 15.00 }, 'gpt-4o'))

      const usage = store.getUsageSummary({ since: threeHoursAgo, until: oneHourAgo })
      expect(usage.traceCount).toBe(3)
      expect(usage.promptTokens).toBe(3_500_000)
    })

    it('returns zeros for empty result', () => {
      const usage = store.getUsageSummary({ sessionId: 'empty-session' })
      expect(usage.promptTokens).toBe(0)
      expect(usage.completionTokens).toBe(0)
      expect(usage.totalTokens).toBe(0)
      expect(usage.totalCost).toBe(0)
      expect(usage.traceCount).toBe(0)
      expect(usage.spanCount).toBe(0)
    })

    it('throws on invalid since parameter', () => {
      expect(() => store.getUsageSummary({ since: 'not-a-date' })).toThrow('invalid since parameter')
    })

    it('throws on invalid until parameter', () => {
      expect(() => store.getUsageSummary({ until: 'not-a-date' })).toThrow('invalid until parameter')
    })

    it('throws when since-until window exceeds maximum', () => {
      const now = new Date()
      const longAgo = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString() // 400 days ago
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

      expect(() => store.getUsageSummary({ since: longAgo, until: yesterday })).toThrow('exceeds maximum')
    })
  })
})