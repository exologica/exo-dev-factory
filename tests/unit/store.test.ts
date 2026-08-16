import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TraceStore } from '../../src/domain/store.js'
import type { Trace } from '../../src/domain/trace.js'

function makeTrace(startTime: string, name = 'trace'): Trace {
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
        status: 'ok'
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
})
