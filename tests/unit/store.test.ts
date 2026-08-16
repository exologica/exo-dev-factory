import { describe, it, expect, beforeEach } from 'vitest'
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

describe('TraceStore', () => {
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
