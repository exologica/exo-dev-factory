import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TraceStore } from '../../src/domain/store.js'
import type { Trace } from '../../src/domain/trace.js'
import Database from 'better-sqlite3'

function makeTrace(startTime: string, name = 'trace', spanStatus: 'ok' | 'error' = 'ok', usage?: { promptTokens: number; completionTokens: number; totalCost?: number }): Trace {
  return {
    name,
    startTime,
    endTime: new Date(Date.parse(startTime) + 1000).toISOString(),
    spans: [
      {
        id: `span-${startTime}`,
        name: 'llm-call',
        startTime,
        endTime: new Date(Date.parse(startTime) + 500).toISOString(),
        status: spanStatus,
        usage
      }
    ]
  }
}

describe('TraceStore (in-memory)', () => {
  let store: TraceStore

  beforeEach(() => {
    store = new TraceStore()
  })

  it('adds a trace and returns its id', () => {
    const id = store.add(makeTrace('2026-08-15T10:00:00.000Z'))
    expect(typeof id).toBe('string')
    expect(store.get(id)).toBeDefined()
    expect(store.size).toBe(1)
  })

  it('preserves a provided id', () => {
    const id = store.add({ ...makeTrace('2026-08-15T10:00:00.000Z'), id: 'custom-id' })
    expect(id).toBe('custom-id')
    expect(store.get('custom-id')?.id).toBe('custom-id')
  })

  it('lists traces newest-first by startTime', () => {
    store.add(makeTrace('2026-08-15T08:00:00.000Z', 'old'))
    store.add(makeTrace('2026-08-15T12:00:00.000Z', 'new'))
    store.add(makeTrace('2026-08-15T10:00:00.000Z', 'middle'))

    const names = store.list().map((t) => t.name)
    expect(names).toEqual(['new', 'middle', 'old'])
  })

  it('returns undefined for an unknown id', () => {
    expect(store.get('missing')).toBeUndefined()
  })

  it('returns an empty list when empty', () => {
    expect(store.list()).toEqual([])
  })

  it('deletes an existing trace and reports success', () => {
    const id = store.add(makeTrace('2026-08-15T10:00:00.000Z', 'doomed'))
    expect(store.delete(id)).toBe(true)
    expect(store.get(id)).toBeUndefined()
    expect(store.list().map((t) => t.name)).toEqual([])
    expect(store.size).toBe(0)
  })

  it('reports not-found when deleting an unknown id', () => {
    store.add(makeTrace('2026-08-15T10:00:00.000Z', 'keeper'))
    expect(store.delete('no-such-id')).toBe(false)
    expect(store.size).toBe(1)
  })

  it('leaves unrelated traces intact when deleting one trace', () => {
    const first = store.add(makeTrace('2026-08-15T08:00:00.000Z', 'first'))
    const second = store.add(makeTrace('2026-08-15T09:00:00.000Z', 'second'))
    const third = store.add(makeTrace('2026-08-15T10:00:00.000Z', 'third'))

    expect(store.delete(second)).toBe(true)
    expect(store.list().map((t) => t.name)).toEqual(['third', 'first'])
    expect(store.get(first)?.name).toBe('first')
    expect(store.get(third)?.name).toBe('third')
  })

  it('paginates with limit and offset', () => {
    for (let i = 0; i < 15; i += 1) {
      store.add(makeTrace(`2026-08-15T${String(i).padStart(2, '0')}:00:00.000Z`, `trace-${i}`))
    }

    const page1 = store.list({ limit: 10 })
    expect(page1).toHaveLength(10)
    expect(page1[0]?.name).toBe('trace-14')

    const page2 = store.list({ limit: 10, offset: 10 })
    expect(page2).toHaveLength(5)
    const page1Ids = new Set(page1.map((t) => t.id))
    expect(page2.every((t) => !page1Ids.has(t.id))).toBe(true)
  })

  it('supports offset without a limit', () => {
    store.add(makeTrace('2026-08-15T08:00:00.000Z', 'first'))
    store.add(makeTrace('2026-08-15T09:00:00.000Z', 'second'))
    store.add(makeTrace('2026-08-15T10:00:00.000Z', 'third'))
    expect(store.list({ offset: 1 }).map((t) => t.name)).toEqual(['second', 'first'])
  })

  it('filters by derived trace status', () => {
    store.add(makeTrace('2026-08-15T10:00:00.000Z', 'ok-trace', 'ok'))
    store.add(makeTrace('2026-08-15T11:00:00.000Z', 'error-trace', 'error'))
    store.add(makeTrace('2026-08-15T12:00:00.000Z', 'ok-trace-2', 'ok'))

    expect(store.list({ status: 'error' }).map((t) => t.name)).toEqual(['error-trace'])
    expect(store.list({ status: 'ok' }).map((t) => t.name)).toEqual(['ok-trace-2', 'ok-trace'])
  })

  it('combines the status filter with pagination', () => {
    for (let i = 0; i < 5; i += 1) {
      store.add(makeTrace(`2026-08-15T${String(i).padStart(2, '0')}:00:00.000Z`, `ok-${i}`, 'ok'))
    }
    for (let i = 0; i < 5; i += 1) {
      store.add(makeTrace(`2026-08-15T${String(10 + i).padStart(2, '0')}:00:00.000Z`, `err-${i}`, 'error'))
    }

    const page = store.list({ limit: 3, offset: 2, status: 'error' })
    expect(page).toHaveLength(3)
    expect(page.every((t) => t.name.startsWith('err-'))).toBe(true)
  })
})

describe('TraceStore (SQLite file-backed)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exo-store-'))
    dbPath = path.join(dir, 'traces.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists traces across store re-instantiation on the same file', () => {
    const first = new TraceStore({ dbPath })
    const id = first.add(makeTrace('2026-08-15T10:00:00.000Z', 'persisted'))
    first.close()

    const second = new TraceStore({ dbPath })
    expect(second.get(id)?.name).toBe('persisted')
    expect(second.list().map((t) => t.name)).toContain('persisted')
    expect(second.size).toBe(1)
    second.close()
  })

  it('overwrites an existing id (upsert semantics)', () => {
    const store = new TraceStore({ dbPath })
    const id = store.add({ ...makeTrace('2026-08-15T10:00:00.000Z', 'first'), id: 'same' })
    expect(id).toBe('same')
    const overwritten = makeTrace('2026-08-15T11:00:00.000Z', 'second')
    store.add({ ...overwritten, id: 'same' })
    expect(store.size).toBe(1)
    expect(store.get('same')?.name).toBe('second')
    store.close()
  })

  it('round-trips the full payload including spans and attributes', () => {
    const store = new TraceStore({ dbPath })
    const withAttributes: Trace = {
      name: 'rich',
      startTime: '2026-08-15T10:00:00.000Z',
      endTime: '2026-08-15T10:00:01.000Z',
      spans: [
        {
          id: 'span-rich',
          name: 'llm-call',
          startTime: '2026-08-15T10:00:00.000Z',
          endTime: '2026-08-15T10:00:00.500Z',
          status: 'ok',
          attributes: { model: 'gpt-x', tokens: { in: 10, out: 5 } }
        }
      ]
    }
    const id = store.add(withAttributes)
    store.close()

    const reopened = new TraceStore({ dbPath })
    // The store persists the payload together with the assigned id.
    expect(reopened.get(id)).toEqual({ ...withAttributes, id })
    reopened.close()
  })

  it('starts empty on a fresh file', () => {
    const store = new TraceStore({ dbPath })
    expect(store.list()).toEqual([])
    expect(store.size).toBe(0)
    store.close()
  })

  it('backfills the status column for databases created before filtering support', () => {
    // Simulate a pre-pagination database: raw better-sqlite3 with the old schema.
    const legacy = new Database(dbPath)
    legacy.exec(`
      CREATE TABLE traces (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        startTime    TEXT NOT NULL,
        endTime      TEXT NOT NULL,
        startEpochMs INTEGER NOT NULL,
        data         TEXT NOT NULL
      )
    `)
    const legacyTrace = {
      id: 'legacy-err',
      name: 'legacy',
      startTime: '2026-08-15T10:00:00.000Z',
      endTime: '2026-08-15T10:00:01.000Z',
      spans: [
        {
          id: 's',
          name: 'x',
          startTime: '2026-08-15T10:00:00.000Z',
          endTime: '2026-08-15T10:00:00.500Z',
          status: 'error'
        }
      ]
    }
    legacy
      .prepare(
        `INSERT INTO traces (id, name, startTime, endTime, startEpochMs, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyTrace.id,
        legacyTrace.name,
        legacyTrace.startTime,
        legacyTrace.endTime,
        Date.parse(legacyTrace.startTime),
        JSON.stringify(legacyTrace),
      )
    legacy.close()

    const store = new TraceStore({ dbPath })
    expect(store.list({ status: 'error' }).map((t) => t.id)).toEqual(['legacy-err'])
    expect(store.list({ status: 'ok' })).toEqual([])
    store.close()
  })

  describe('usage field persistence', () => {
    it('persists and hydrates usage fields in spans', () => {
      const store = new TraceStore({ dbPath })
      const traceWithUsage = makeTrace('2026-08-15T10:00:00.000Z', 'usage-trace', 'ok', {
        promptTokens: 150,
        completionTokens: 75,
        totalCost: 0.00225
      })
      const id = store.add(traceWithUsage)
      store.close()

      const reopened = new TraceStore({ dbPath })
      const retrieved = reopened.get(id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.spans[0]?.usage).toEqual({
        promptTokens: 150,
        completionTokens: 75,
        totalCost: 0.00225
      })
      reopened.close()
    })

    it('persists and hydrates usage fields without totalCost', () => {
      const store = new TraceStore({ dbPath })
      const traceWithUsage = makeTrace('2026-08-15T10:00:00.000Z', 'usage-trace-no-cost', 'ok', {
        promptTokens: 150,
        completionTokens: 75
      })
      const id = store.add(traceWithUsage)
      store.close()

      const reopened = new TraceStore({ dbPath })
      const retrieved = reopened.get(id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.spans[0]?.usage).toEqual({
        promptTokens: 150,
        completionTokens: 75,
        totalCost: undefined
      })
      reopened.close()
    })

    it('persists traces without usage fields (backward compatible)', () => {
      const store = new TraceStore({ dbPath })
      const traceWithoutUsage = makeTrace('2026-08-15T10:00:00.000Z', 'no-usage-trace', 'ok')
      const id = store.add(traceWithoutUsage)
      store.close()

      const reopened = new TraceStore({ dbPath })
      const retrieved = reopened.get(id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.spans[0]?.usage).toBeUndefined()
      reopened.close()
    })

    it('round-trips usage fields through list()', () => {
      const store = new TraceStore({ dbPath })
      const traceWithUsage = makeTrace('2026-08-15T10:00:00.000Z', 'list-usage-trace', 'ok', {
        promptTokens: 200,
        completionTokens: 100,
        totalCost: 0.003
      })
      store.add(traceWithUsage)
      store.close()

      const reopened = new TraceStore({ dbPath })
      const listed = reopened.list()
      const found = listed.find((t) => t.name === 'list-usage-trace')
      expect(found).toBeDefined()
      expect(found?.spans[0]?.usage).toEqual({
        promptTokens: 200,
        completionTokens: 100,
        totalCost: 0.003
      })
      reopened.close()
    })

    it('handles mixed traces with and without usage', () => {
      const store = new TraceStore({ dbPath })
      store.add(makeTrace('2026-08-15T10:00:00.000Z', 'no-usage', 'ok'))
      store.add(makeTrace('2026-08-15T10:01:00.000Z', 'with-usage', 'ok', {
        promptTokens: 100,
        completionTokens: 50,
        totalCost: 0.0015
      }))
      store.close()

      const reopened = new TraceStore({ dbPath })
      const listed = reopened.list()
      const noUsage = listed.find((t) => t.name === 'no-usage')
      const withUsage = listed.find((t) => t.name === 'with-usage')
      expect(noUsage?.spans[0]?.usage).toBeUndefined()
      expect(withUsage?.spans[0]?.usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalCost: 0.0015
      })
      reopened.close()
    })
  })
})
