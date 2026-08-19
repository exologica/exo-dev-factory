import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TraceStore } from '../../src/domain/store.js'

// Use a throwaway temp SQLite file for the whole integration suite so the
// app under test behaves like a durable deployment without touching the
// repository or any real data directory.
const dbDir = mkdtempSync(path.join(tmpdir(), 'exo-dev-factory-api-'))
const dbPath = path.join(dbDir, 'traces.db')
process.env.TRACE_DB_PATH = dbPath

// Dynamic import so TRACE_DB_PATH is set before the app module evaluates its
// store construction.
const { app } = await import('../../src/server/index.js')

const validTrace = {
  name: 'ingest',
  startTime: '2026-08-16T10:00:00.000Z',
  endTime: '2026-08-16T10:00:01.000Z',
  spans: [
    {
      id: 'span-1',
      name: 'parse',
      startTime: '2026-08-16T10:00:00.000Z',
      endTime: '2026-08-16T10:00:00.500Z',
      status: 'ok'
    }
  ]
}

let server: ServerType | undefined
let baseUrl = ''

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
  rmSync(dbDir, { recursive: true, force: true })
})

describe('trace API over real HTTP', () => {
  it('accepts a valid trace and returns 201 with an id', async () => {
    const res = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validTrace)
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    expect(body.id).toBeTypeOf('string')
  })

  it('lists stored traces', async () => {
    const res = await fetch(`${baseUrl}/api/traces`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { id: string }[]; pagination: { total: number } }
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.pagination.total).toBeGreaterThan(0)
  })

  it('returns a trace by id', async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validTrace)
      })
    ).json()) as { id: string }
    const res = await fetch(`${baseUrl}/api/traces/${created.id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string }
    expect(body.name).toBe('ingest')
  })

  it('returns 404 for an unknown trace id', async () => {
    const res = await fetch(`${baseUrl}/api/traces/no-such-id`)
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for a schema-invalid trace', async () => {
    const res = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no-timestamps' })
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`)
    expect(res.status).toBe(404)
  })

  it('keeps traces after the store is re-instantiated from the same DB file', async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validTrace)
      })
    ).json()) as { id: string }

    // Simulates a server restart: a brand-new store opened on the same file
    // must still see the trace ingested over HTTP by the previous process.
    const restarted = new TraceStore({ dbPath })
    expect(restarted.get(created.id)).toBeDefined()
    expect(restarted.get(created.id)?.name).toBe('ingest')
    expect(restarted.list().some((t) => t.id === created.id)).toBe(true)
    restarted.close()
  })
})

describe('trace API list pagination and filtering', () => {
  function seedTrace(
    startTime: string,
    name: string,
    spanStatus: 'ok' | 'error' = 'ok',
    usage?: { promptTokens: number; completionTokens: number; totalTokens?: number; totalCost?: number }
  ) {
    return fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        startTime,
        endTime: new Date(Date.parse(startTime) + 1000).toISOString(),
        spans: [
          {
            id: `span-${name}`,
            name: 'parse',
            startTime,
            endTime: new Date(Date.parse(startTime) + 500).toISOString(),
            status: spanStatus,
            usage: usage ? { ...usage, totalTokens: usage.totalTokens ?? (usage.promptTokens + usage.completionTokens) } : undefined
          }
        ]
      })
    })
  }

  it('paginates GET /api/traces with limit and offset', async () => {
    for (let i = 0; i < 15; i += 1) {
      await seedTrace(`2026-08-16T12:${String(i).padStart(2, '0')}:00.000Z`, `page-${i}`)
    }

    const page1Res = await fetch(`${baseUrl}/api/traces?limit=10`)
    expect(page1Res.status).toBe(200)
    const page1Body = (await page1Res.json()) as { data: { id: string; name: string }[]; pagination: { total: number; page: number; limit: number } }
    expect(page1Body.data).toHaveLength(10)
    expect(page1Body.data[0]?.name).toBe('page-14')
    expect(page1Body.pagination.page).toBe(1)
    expect(page1Body.pagination.limit).toBe(10)

    // The suite shares one DB file, so other tests may have seeded traces too.
    // Expected remainder is the true total minus the first page.
    const allRes = await fetch(`${baseUrl}/api/traces`)
    const allBody = (await allRes.json()) as { data: { id: string; name: string }[]; pagination: { total: number } }
    const page2Res = await fetch(`${baseUrl}/api/traces?limit=10&offset=10`)
    expect(page2Res.status).toBe(200)
    const page2Body = (await page2Res.json()) as { data: { id: string; name: string }[]; pagination: { total: number; page: number; limit: number } }
    expect(page2Body.data).toHaveLength(allBody.pagination.total - 10)
    const page1Ids = new Set(page1Body.data.map((t) => t.id))
    expect(page2Body.data.every((t) => !page1Ids.has(t.id))).toBe(true)
  })

  it('filters GET /api/traces by derived status', async () => {
    await seedTrace('2026-08-16T13:00:00.000Z', 'ok-filtered')
    await seedTrace('2026-08-16T13:01:00.000Z', 'err-a', 'error')
    await seedTrace('2026-08-16T13:02:00.000Z', 'err-b', 'error')

    const res = await fetch(`${baseUrl}/api/traces?status=error`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(2)
    expect(body.data.map((t) => t.name).sort()).toEqual(['err-a', 'err-b'])
    expect(body.pagination.total).toBe(2)
  })

  it('returns 400 when limit exceeds maximum', async () => {
    for (let i = 0; i < 120; i += 1) {
      await seedTrace(`2026-08-16T14:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`, `bulk-${i}`)
    }

    const res = await fetch(`${baseUrl}/api/traces?limit=9999`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('100')
  })

  it('returns 400 for invalid pagination parameters', async () => {
    const res = await fetch(`${baseUrl}/api/traces?limit=abc&offset=-3&status=bogus`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBeDefined()
  })

  it('returns 400 when limit is zero', async () => {
    const res = await fetch(`${baseUrl}/api/traces?limit=0`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('positive')
  })

  it('returns 400 when limit is 101 (exceeds max)', async () => {
    const res = await fetch(`${baseUrl}/api/traces?limit=101`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('100')
  })

  it('returns 400 when limit is 1000 (exceeds max)', async () => {
    const res = await fetch(`${baseUrl}/api/traces?limit=1000`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('100')
  })

  it('returns 400 when offset is negative', async () => {
    const res = await fetch(`${baseUrl}/api/traces?offset=-1`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('non-negative')
  })

  it('returns 400 when offset is negative (larger magnitude)', async () => {
    const res = await fetch(`${baseUrl}/api/traces?offset=-100`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('non-negative')
  })

  it('returns 200 with empty array when offset exceeds total count', async () => {
    const allRes = await fetch(`${baseUrl}/api/traces`)
    const allBody = (await allRes.json()) as { pagination: { total: number } }
    const totalBefore = allBody.pagination.total
    
    await seedTrace('2026-08-16T15:00:00.000Z', 'single-trace-offset-test')
    
    const res = await fetch(`${baseUrl}/api/traces?offset=999999`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[]; pagination: { total: number } }
    expect(body.data).toHaveLength(0)
    expect(body.pagination.total).toBe(totalBefore + 1)
  })

  it('validates limit boundary enforcement (1, 100, 101, 1000)', async () => {
    await seedTrace('2026-08-16T15:00:00.000Z', 'trace-limit-boundary-test')

    // limit=1 should work
    const res1 = await fetch(`${baseUrl}/api/traces?limit=1`)
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as { data: unknown[]; pagination: { limit: number } }
    expect(body1.pagination.limit).toBe(1)

    // limit=100 should work
    const res100 = await fetch(`${baseUrl}/api/traces?limit=100`)
    expect(res100.status).toBe(200)
    const body100 = (await res100.json()) as { data: unknown[]; pagination: { limit: number } }
    expect(body100.pagination.limit).toBe(100)

    // limit=101 should fail
    const res101 = await fetch(`${baseUrl}/api/traces?limit=101`)
    expect(res101.status).toBe(400)

    // limit=1000 should fail
    const res1000 = await fetch(`${baseUrl}/api/traces?limit=1000`)
    expect(res1000.status).toBe(400)
  })

  it('validates offset boundary (-1, 0, 1, beyond total)', async () => {
    await seedTrace('2026-08-16T15:00:00.000Z', 'trace-offset-boundary-test')

    // offset=-1 should fail
    const resNeg1 = await fetch(`${baseUrl}/api/traces?offset=-1`)
    expect(resNeg1.status).toBe(400)

    // offset=0 should work
    const res0 = await fetch(`${baseUrl}/api/traces?offset=0`)
    expect(res0.status).toBe(200)

    // offset=1 should work (returns at least the other traces, not just our new one)
    const res1 = await fetch(`${baseUrl}/api/traces?offset=1`)
    expect(res1.status).toBe(200)

    // offset=999999 should work (returns empty)
    const resBig = await fetch(`${baseUrl}/api/traces?offset=999999`)
    expect(resBig.status).toBe(200)
    const bodyBig = (await resBig.json()) as { data: unknown[]; pagination: { total: number } }
    expect(bodyBig.data).toHaveLength(0)
  })

  it('pagination works with all filter combinations in isolation', async () => {
    const now = new Date()
    const t1 = new Date(now.getTime() + 1000).toISOString()
    const t2 = new Date(now.getTime() + 2000).toISOString()
    const t3 = new Date(now.getTime() + 3000).toISOString()
    await seedTrace(t1, 'filter-isolation-service-a', 'ok')
    await seedTrace(t2, 'filter-isolation-service-b', 'error')
    await seedTrace(t3, 'filter-isolation-service-c', 'ok')

    // status=ok
    let res = await fetch(`${baseUrl}/api/traces?status=ok&limit=10`)
    expect(res.status).toBe(200)
    let body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.pagination.total).toBeGreaterThanOrEqual(2)
    expect(body.data.some((t) => t.name === 'filter-isolation-service-a')).toBe(true)
    expect(body.data.some((t) => t.name === 'filter-isolation-service-c')).toBe(true)

    // status=error
    res = await fetch(`${baseUrl}/api/traces?status=error&limit=10`)
    expect(res.status).toBe(200)
    body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.pagination.total).toBeGreaterThanOrEqual(1)
    expect(body.data.some((t) => t.name === 'filter-isolation-service-b')).toBe(true)

    // serviceName
    res = await fetch(`${baseUrl}/api/traces?serviceName=filter-isolation-service-a&limit=10`)
    expect(res.status).toBe(200)
    body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.pagination.total).toBe(1)
    expect(body.data[0]?.name).toBe('filter-isolation-service-a')

    // sort
    res = await fetch(`${baseUrl}/api/traces?sort=startTime:asc&limit=10`)
    expect(res.status).toBe(200)
    body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.pagination.total).toBeGreaterThanOrEqual(3)
  })

  it('pagination works with all filters combined', async () => {
    await seedTrace('2026-08-16T15:00:00.000Z', 'service-x', 'ok')
    await seedTrace('2026-08-16T15:01:00.000Z', 'service-y', 'error')
    await seedTrace('2026-08-16T15:02:00.000Z', 'service-z', 'ok')

    const res = await fetch(`${baseUrl}/api/traces?status=ok&serviceName=service-x&limit=10&sort=startTime:desc`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.pagination.total).toBe(1)
    expect(body.data[0]?.name).toBe('service-x')
  })

  it('page boundary consistency - no duplicate/missing items across pages', async () => {
    // Use a unique serviceName (trace name) to isolate these 25 traces from existing DB data
    const testService = 'page-boundary-consistency-test'
    for (let i = 0; i < 25; i += 1) {
      await fetch(`${baseUrl}/api/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: testService,
          startTime: `2026-08-16T16:${String(i).padStart(2, '0')}:00.000Z`,
          endTime: new Date(Date.parse(`2026-08-16T16:${String(i).padStart(2, '0')}:00.000Z`) + 1000).toISOString(),
          spans: [
            {
              id: `span-page-trace-${i}`,
              name: `page-trace-${i}`,
              startTime: `2026-08-16T16:${String(i).padStart(2, '0')}:00.000Z`,
              endTime: new Date(Date.parse(`2026-08-16T16:${String(i).padStart(2, '0')}:00.000Z`) + 500).toISOString(),
              status: 'ok'
            }
          ]
        })
      })
    }

    const page1Res = await fetch(`${baseUrl}/api/traces?limit=10&offset=0&serviceName=${testService}`)
    expect(page1Res.status).toBe(200)
    const page1 = (await page1Res.json()) as { data: { id: string; name: string; spans: { name: string }[] }[]; pagination: { total: number } }
    expect(page1.data).toHaveLength(10)

    const page2Res = await fetch(`${baseUrl}/api/traces?limit=10&offset=10&serviceName=${testService}`)
    expect(page2Res.status).toBe(200)
    const page2 = (await page2Res.json()) as { data: { id: string; name: string; spans: { name: string }[] }[]; pagination: { total: number } }
    expect(page2.data).toHaveLength(10)

    const page3Res = await fetch(`${baseUrl}/api/traces?limit=10&offset=20&serviceName=${testService}`)
    expect(page3Res.status).toBe(200)
    const page3 = (await page3Res.json()) as { data: { id: string; name: string; spans: { name: string }[] }[]; pagination: { total: number } }
    expect(page3.data).toHaveLength(5)

    // Verify no duplicates across pages
    const allIds = [...page1.data, ...page2.data, ...page3.data].map((t) => t.id)
    const uniqueIds = new Set(allIds)
    expect(uniqueIds.size).toBe(25)

    // Verify page 1 has newest (span name page-trace-24), page 3 has oldest (span name page-trace-0)
    expect(page1.data[0]?.spans[0]?.name).toBe('page-trace-24')
    expect(page3.data[page3.data.length - 1]?.spans[0]?.name).toBe('page-trace-0')
  })
})

describe('trace API usage fields', () => {
  async function seedTraceWithUsage(name: string, usage?: { promptTokens: number; completionTokens: number; totalTokens?: number; totalCost?: number }, serviceName = 'usage-test') {
    const res = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: serviceName,
        startTime: '2026-08-16T15:00:00.000Z',
        endTime: '2026-08-16T15:00:01.000Z',
        spans: [
          {
            id: `span-${name}`,
            name: 'llm-call',
            startTime: '2026-08-16T15:00:00.000Z',
            endTime: '2026-08-16T15:00:00.500Z',
            status: 'ok',
            usage
          }
        ]
      })
    })
    return ((await res.json()) as { id: string }).id
  }

  it('accepts a trace with usage fields and returns 201', async () => {
    const res = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'usage-ingest',
        startTime: '2026-08-16T16:00:00.000Z',
        endTime: '2026-08-16T16:00:01.000Z',
        spans: [
          {
            id: 'span-usage',
            name: 'llm-call',
            startTime: '2026-08-16T16:00:00.000Z',
            endTime: '2026-08-16T16:00:00.500Z',
            status: 'ok',
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, totalCost: 0.0015 }
          }
        ]
      })
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    expect(body.id).toBeTypeOf('string')
  })

  it('round-trips usage fields via GET /api/traces/:id', async () => {
    const id = await seedTraceWithUsage('round-trip', { promptTokens: 200, completionTokens: 100, totalTokens: 300, totalCost: 0.003 }, 'usage-round-trip')
    const res = await fetch(`${baseUrl}/api/traces/${id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { spans: Array<{ usage?: { promptTokens: number; completionTokens: number; totalTokens?: number; totalCost?: number } }> }
    expect(body.spans[0]?.usage).toEqual({ promptTokens: 200, completionTokens: 100, totalTokens: 300, totalCost: 0.003 })
  })

  it('round-trips usage fields via GET /api/traces list', async () => {
    await seedTraceWithUsage('list-round-trip', { promptTokens: 150, completionTokens: 75, totalTokens: 225, totalCost: 0.00225 }, 'usage-list-round-trip')
    const res = await fetch(`${baseUrl}/api/traces?serviceName=usage-list-round-trip`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ spans: Array<{ name: string; usage?: { promptTokens: number; completionTokens: number; totalTokens?: number; totalCost?: number } }> }>; pagination: { total: number } }
    const found = body.data.find((t) => t.spans[0]?.name === 'llm-call')
    expect(found).toBeDefined()
    expect(found?.spans[0]?.usage).toEqual({ promptTokens: 150, completionTokens: 75, totalTokens: 225, totalCost: 0.00225 })
  })

  it('round-trips usage without totalCost', async () => {
    const id = await seedTraceWithUsage('no-cost', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'usage-no-cost')
    const res = await fetch(`${baseUrl}/api/traces/${id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { spans: Array<{ usage?: { promptTokens: number; completionTokens: number; totalTokens?: number; totalCost?: number } }> }
    expect(body.spans[0]?.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150, totalCost: undefined })
  })

  it('handles mixed traces with and without usage in list', async () => {
    await seedTraceWithUsage('mixed-no-usage', undefined, 'usage-mixed')
    await seedTraceWithUsage('mixed-with-usage', { promptTokens: 300, completionTokens: 150, totalTokens: 450, totalCost: 0.0045 }, 'usage-mixed')
    const res = await fetch(`${baseUrl}/api/traces?serviceName=usage-mixed`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ spans: Array<{ usage?: { promptTokens: number; completionTokens: number; totalTokens?: number; totalCost?: number } }> }>; pagination: { total: number } }
    const noUsage = body.data.find((t) => t.spans[0]?.usage === undefined)
    const withUsage = body.data.find((t) => t.spans[0]?.usage !== undefined)
    expect(noUsage).toBeDefined()
    expect(withUsage).toBeDefined()
    expect(noUsage?.spans[0]?.usage).toBeUndefined()
    expect(withUsage?.spans[0]?.usage).toEqual({ promptTokens: 300, completionTokens: 150, totalTokens: 450, totalCost: 0.0045 })
  })

  it('rejects invalid usage fields (negative promptTokens)', async () => {
    const res = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'invalid-usage',
        startTime: '2026-08-16T16:00:00.000Z',
        endTime: '2026-08-16T16:00:01.000Z',
        spans: [
          {
            id: 'span-invalid',
            name: 'llm-call',
            startTime: '2026-08-16T16:00:00.000Z',
            endTime: '2026-08-16T16:00:00.500Z',
            status: 'ok',
            usage: { promptTokens: -1, completionTokens: 50 }
          }
        ]
      })
    })
    expect(res.status).toBe(400)
  })

  it('rejects invalid usage fields (non-integer tokens)', async () => {
    const res = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'invalid-usage',
        startTime: '2026-08-16T16:00:00.000Z',
        endTime: '2026-08-16T16:00:01.000Z',
        spans: [
          {
            id: 'span-invalid',
            name: 'llm-call',
            startTime: '2026-08-16T16:00:00.000Z',
            endTime: '2026-08-16T16:00:00.500Z',
            status: 'ok',
            usage: { promptTokens: 100.5, completionTokens: 50 }
          }
        ]
      })
    })
    expect(res.status).toBe(400)
  })
})

describe('trace API deletion', () => {
  async function seedTrace(name: string) {
    const res = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        startTime: '2026-08-16T15:00:00.000Z',
        endTime: '2026-08-16T15:00:01.000Z',
        spans: [
          {
            id: `span-${name}`,
            name: 'parse',
            startTime: '2026-08-16T15:00:00.000Z',
            endTime: '2026-08-16T15:00:00.500Z',
            status: 'ok'
          }
        ]
      })
    })
    return ((await res.json()) as { id: string }).id
  }

  it('deletes an existing trace and removes it from list and get', async () => {
    const id = await seedTrace('doomed')

    const del = await fetch(`${baseUrl}/api/traces/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)

    const listRes = await fetch(`${baseUrl}/api/traces`)
    const listBody = (await listRes.json()) as { data: { id: string }[]; pagination: { total: number } }
    expect(listBody.data.some((t) => t.id === id)).toBe(false)

    const byId = await fetch(`${baseUrl}/api/traces/${id}`)
    expect(byId.status).toBe(404)
  })

  it('returns 404 when deleting an unknown trace id', async () => {
    const res = await fetch(`${baseUrl}/api/traces/no-such-id`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('leaves other traces intact when deleting one', async () => {
    const keeper = await seedTrace('keeper')
    const doomed = await seedTrace('doomed-2')

    const del = await fetch(`${baseUrl}/api/traces/${doomed}`, { method: 'DELETE' })
    expect(del.status).toBe(204)

    const byId = await fetch(`${baseUrl}/api/traces/${keeper}`)
    expect(byId.status).toBe(200)
  })
})

describe('OpenAI chat completions proxy', () => {
  const mockOpenAIResponse = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1723833600,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  }

  const mockErrorResponse = {
    error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  }

  const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
  const originalFetch = global.fetch

  function makeProxyRequest(body: unknown, authHeader = 'Bearer test-key') {
    return fetch(`${baseUrl}/v1/proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify(body)
    })
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === OPENAI_URL) {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockOpenAIResponse) }),
          json: () => Promise.resolve(mockOpenAIResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 401 when Authorization header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing or invalid Authorization header')
  })

  it('returns 401 when Authorization header is not Bearer', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic invalid' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: '{not json'
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid JSON body')
  })

  it('forwards request to OpenAI and returns response with trace on success', async () => {
    const res = await makeProxyRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockOpenAIResponse)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('gpt-4o')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('openai')
    expect(proxyTrace?.spans[0]?.usage?.promptTokens).toBe(10)
    expect(proxyTrace?.spans[0]?.usage?.completionTokens).toBe(5)
    expect(typeof proxyTrace?.spans[0]?.usage?.totalCost).toBe('number')

    expect(proxyTrace?.spans[0]?.attributes?.['authorization']).toBeUndefined()
  })

  it('creates error trace when upstream fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === OPENAI_URL) {
        return {
          ok: false,
          status: 429,
          clone: () => ({ json: () => Promise.resolve(mockErrorResponse) }),
          json: () => Promise.resolve(mockErrorResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await makeProxyRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(429)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['llm.model']).toBe('unknown')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('openai')
    expect(errorTrace?.spans[0]?.attributes?.['http.status']).toBe(429)
  })

  it('creates error trace when network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === OPENAI_URL) {
        throw new Error('ENOTFOUND')
      }
      return originalFetch(url, init)
    }))

    const res = await makeProxyRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(502)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-proxy' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['error.message']).toBe('ENOTFOUND')
  })
})

describe('OpenAI Responses API proxy', () => {
  const mockResponsesResponse = {
    id: 'resp_test',
    object: 'response',
    created_at: 1723833600,
    model: 'gpt-4o',
    output: [
      {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello!' }]
      }
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 3,
      total_tokens: 18
    }
  }

  const mockErrorResponse = {
    error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  }

  const RESPONSES_URL = 'https://api.openai.com/v1/responses'
  const originalFetch = global.fetch

  function makeResponsesProxyRequest(body: unknown, authHeader = 'Bearer test-key') {
    return fetch(`${baseUrl}/v1/proxy/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify(body)
    })
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === RESPONSES_URL) {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockResponsesResponse) }),
          json: () => Promise.resolve(mockResponsesResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 401 when Authorization header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', input: 'hi' })
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing or invalid Authorization header')
  })

  it('returns 401 when Authorization header is not Bearer', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic invalid' },
      body: JSON.stringify({ model: 'gpt-4o', input: 'hi' })
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: '{not json'
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid JSON body')
  })

  it('forwards request to OpenAI Responses API and returns response with trace on success', async () => {
    const res = await makeResponsesProxyRequest({ model: 'gpt-4o', input: 'hi' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockResponsesResponse)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('gpt-4o')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('openai-responses')
    expect(proxyTrace?.spans[0]?.attributes?.['openai.response_id']).toBe('resp_test')
    expect(proxyTrace?.spans[0]?.attributes?.['llm.usage.reasoning_tokens']).toBe(3)
    expect(proxyTrace?.spans[0]?.usage?.promptTokens).toBe(10)
    expect(proxyTrace?.spans[0]?.usage?.completionTokens).toBe(5)
    expect(typeof proxyTrace?.spans[0]?.usage?.totalCost).toBe('number')

    // Security: Authorization header must not be in trace
    expect(proxyTrace?.spans[0]?.attributes?.['authorization']).toBeUndefined()
  })

  it('creates error trace when upstream fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === RESPONSES_URL) {
        return {
          ok: false,
          status: 429,
          clone: () => ({ json: () => Promise.resolve(mockErrorResponse) }),
          json: () => Promise.resolve(mockErrorResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await makeResponsesProxyRequest({ model: 'gpt-4o', input: 'hi' })
    expect(res.status).toBe(429)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['llm.model']).toBe('unknown')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('openai-responses')
    expect(errorTrace?.spans[0]?.attributes?.['http.status']).toBe(429)
  })

  it('creates error trace when network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === RESPONSES_URL) {
        throw new Error('ENOTFOUND')
      }
      return originalFetch(url, init)
    }))

    const res = await makeResponsesProxyRequest({ model: 'gpt-4o', input: 'hi' })
    expect(res.status).toBe(502)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-proxy' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['error.message']).toBe('ENOTFOUND')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('openai-responses')
  })
})

describe('Anthropic chat completions proxy', () => {
  const mockAnthropicResponse = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello!' }],
    model: 'claude-3-5-sonnet-20241022',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 8 }
  }

  const mockErrorResponse = {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Rate limit exceeded' }
  }

  const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
  const originalFetch = global.fetch

  function makeAnthropicProxyRequest(body: unknown, apiKey = 'test-key', useAuthHeader = false) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (useAuthHeader) {
      headers.authorization = `Bearer ${apiKey}`
    } else {
      headers['x-api-key'] = apiKey
    }
    return fetch(`${baseUrl}/v1/proxy/anthropic/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === ANTHROPIC_URL) {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockAnthropicResponse) }),
          json: () => Promise.resolve(mockAnthropicResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 401 when x-api-key header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/anthropic/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing or invalid x-api-key header')
  })

  it('accepts Authorization header as fallback for x-api-key', async () => {
    const res = await makeAnthropicProxyRequest(
      { model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      'test-key',
      true
    )
    expect(res.status).toBe(200)
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/anthropic/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      body: '{not json'
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid JSON body')
  })

  it('forwards request to Anthropic and returns response with trace on success', async () => {
    const res = await makeAnthropicProxyRequest({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockAnthropicResponse)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('claude-3-5-sonnet-20241022')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('anthropic')
    expect(proxyTrace?.spans[0]?.usage?.promptTokens).toBe(12)
    expect(proxyTrace?.spans[0]?.usage?.completionTokens).toBe(8)
    expect(typeof proxyTrace?.spans[0]?.usage?.totalCost).toBe('number')
    // Anthropic sonnet: $3.00/1M input, $15.00/1M output
    // 12 * 300/1M = 0.0036 cents, 8 * 1500/1M = 0.012 cents
    // Rounds to 0 cents for small token counts - use >= 0
    expect(proxyTrace?.spans[0]?.usage?.totalCost).toBeGreaterThanOrEqual(0)

    // Security: API key must not be in trace
    expect(proxyTrace?.spans[0]?.attributes?.['x-api-key']).toBeUndefined()
    expect(proxyTrace?.spans[0]?.attributes?.['authorization']).toBeUndefined()
  })

  it('creates error trace when upstream fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === ANTHROPIC_URL) {
        return {
          ok: false,
          status: 429,
          clone: () => ({ json: () => Promise.resolve(mockErrorResponse) }),
          json: () => Promise.resolve(mockErrorResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await makeAnthropicProxyRequest({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(res.status).toBe(429)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['llm.model']).toBe('unknown')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('anthropic')
    expect(errorTrace?.spans[0]?.attributes?.['http.status']).toBe(429)
  })

  it('creates error trace when network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === ANTHROPIC_URL) {
        throw new Error('ENOTFOUND')
      }
      return originalFetch(url, init)
    }))

    const res = await makeAnthropicProxyRequest({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(res.status).toBe(502)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-proxy' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['error.message']).toBe('ENOTFOUND')
  })
})

describe('Google Gemini generateContent proxy', () => {
  const mockGeminiResponse = {
    candidates: [
      {
        content: {
          parts: [{ text: 'Hello!' }],
          role: 'model'
        },
        finishReason: 'STOP',
        index: 0
      }
    ],
    usageMetadata: {
      promptTokenCount: 15,
      candidatesTokenCount: 10,
      totalTokenCount: 25
    },
    modelVersion: 'gemini-1.5-pro'
  }

  const mockErrorResponse = {
    error: { message: 'API key not valid', code: 400, status: 'INVALID_ARGUMENT' }
  }

  const GEMINI_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
  const originalFetch = global.fetch

  function makeGeminiProxyRequest(body: unknown, apiKey = 'test-key') {
    return fetch(`${baseUrl}/v1/proxy/gemini/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body)
    })
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr.startsWith(`${GEMINI_URL_BASE}/`)) {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockGeminiResponse) }),
          json: () => Promise.resolve(mockGeminiResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 401 when x-goog-api-key header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/gemini/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-1.5-pro', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing or invalid x-goog-api-key header')
  })

  it('accepts Authorization header as fallback for x-goog-api-key', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/gemini/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'gemini-1.5-pro', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    })
    expect(res.status).toBe(200)
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/gemini/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': 'test-key' },
      body: '{not json'
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid JSON body')
  })

  it('forwards request to Gemini and returns response with trace on success', async () => {
    const res = await makeGeminiProxyRequest({ model: 'gemini-1.5-pro', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockGeminiResponse)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('gemini-1.5-pro')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('google')
    expect(proxyTrace?.spans[0]?.usage?.promptTokens).toBe(15)
    expect(proxyTrace?.spans[0]?.usage?.completionTokens).toBe(10)
    expect(typeof proxyTrace?.spans[0]?.usage?.totalCost).toBe('number')

    // Security: API key must not be in trace
    expect(proxyTrace?.spans[0]?.attributes?.['x-goog-api-key']).toBeUndefined()
    expect(proxyTrace?.spans[0]?.attributes?.['authorization']).toBeUndefined()
  })

  it('creates error trace when upstream fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr.startsWith(`${GEMINI_URL_BASE}/`)) {
        return {
          ok: false,
          status: 400,
          clone: () => ({ json: () => Promise.resolve(mockErrorResponse) }),
          json: () => Promise.resolve(mockErrorResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await makeGeminiProxyRequest({ model: 'gemini-1.5-pro', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    expect(res.status).toBe(400)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['llm.model']).toBe('unknown')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('google')
    expect(errorTrace?.spans[0]?.attributes?.['http.status']).toBe(400)
  })

  it('creates error trace when network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr.startsWith(`${GEMINI_URL_BASE}/`)) {
        throw new Error('ENOTFOUND')
      }
      return originalFetch(url, init)
    }))

    const res = await makeGeminiProxyRequest({ model: 'gemini-1.5-pro', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    expect(res.status).toBe(502)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-proxy' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['error.message']).toBe('ENOTFOUND')
  })

  it('uses default model when not specified', async () => {
    const res = await makeGeminiProxyRequest({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    expect(res.status).toBe(200)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('gemini-1.5-pro')
  })
})

describe('Cohere chat completions proxy', () => {
  const mockCohereResponse = {
    text: 'Hello!',
    generationId: 'gen-test',
    meta: {
      tokens: { inputTokens: 8, outputTokens: 6 }
    },
    model: 'command-r-plus'
  }

  const mockErrorResponse = {
    message: 'API key invalid',
    code: 'invalid_api_key'
  }

  const COHERE_URL = 'https://api.cohere.com/v1/chat'
  const originalFetch = global.fetch

  function makeCohereProxyRequest(body: unknown, authHeader = 'Bearer test-key') {
    return fetch(`${baseUrl}/v1/proxy/cohere/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify(body)
    })
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === COHERE_URL) {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockCohereResponse) }),
          json: () => Promise.resolve(mockCohereResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 401 when Authorization header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/cohere/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' })
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing or invalid Authorization header')
  })

  it('returns 401 when Authorization header is not Bearer', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/cohere/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic invalid' },
      body: JSON.stringify({ message: 'hi' })
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/cohere/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: '{not json'
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid JSON body')
  })

  it('forwards request to Cohere and returns response with trace on success', async () => {
    const res = await makeCohereProxyRequest({ message: 'hi', model: 'command-r-plus' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockCohereResponse)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('command-r-plus')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('cohere')
    expect(proxyTrace?.spans[0]?.usage?.promptTokens).toBe(8)
    expect(proxyTrace?.spans[0]?.usage?.completionTokens).toBe(6)
    expect(typeof proxyTrace?.spans[0]?.usage?.totalCost).toBe('number')
    // Cohere command-r-plus: $3.00/1M input, $15.00/1M output
    // 8 * 300/1M = 0.0024 cents, 6 * 1500/1M = 0.009 cents
    // Rounds to 0 cents for small token counts - use >= 0
    expect(proxyTrace?.spans[0]?.usage?.totalCost).toBeGreaterThanOrEqual(0)

    // Security: API key must not be in trace
    expect(proxyTrace?.spans[0]?.attributes?.['authorization']).toBeUndefined()
  })

  it('creates error trace when upstream fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === COHERE_URL) {
        return {
          ok: false,
          status: 401,
          clone: () => ({ json: () => Promise.resolve(mockErrorResponse) }),
          json: () => Promise.resolve(mockErrorResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await makeCohereProxyRequest({ message: 'hi' })
    expect(res.status).toBe(401)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['llm.model']).toBe('unknown')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('cohere')
    expect(errorTrace?.spans[0]?.attributes?.['http.status']).toBe(401)
  })

  it('creates error trace when network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === COHERE_URL) {
        throw new Error('ENOTFOUND')
      }
      return originalFetch(url, init)
    }))

    const res = await makeCohereProxyRequest({ message: 'hi' })
    expect(res.status).toBe(502)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-proxy' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['error.message']).toBe('ENOTFOUND')
  })

  it('uses default model when not specified', async () => {
    const res = await makeCohereProxyRequest({ message: 'hi' })
    expect(res.status).toBe(200)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('command-r-plus')
  })
})

describe('Mistral chat completions proxy', () => {
  const mockMistralResponse = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1723833600,
    model: 'mistral-large-latest',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 14, completion_tokens: 7, total_tokens: 21 }
  }

  const mockErrorResponse = {
    error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  }

  const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions'
  const originalFetch = global.fetch

  function makeMistralProxyRequest(body: unknown, authHeader = 'Bearer test-key') {
    return fetch(`${baseUrl}/v1/proxy/mistral/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify(body)
    })
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === MISTRAL_URL) {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockMistralResponse) }),
          json: () => Promise.resolve(mockMistralResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 401 when Authorization header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/mistral/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-large-latest', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing or invalid Authorization header')
  })

  it('returns 401 when Authorization header is not Bearer', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/mistral/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic invalid' },
      body: JSON.stringify({ model: 'mistral-large-latest', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/mistral/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: '{not json'
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid JSON body')
  })

  it('forwards request to Mistral and returns response with trace on success', async () => {
    const res = await makeMistralProxyRequest({ model: 'mistral-large-latest', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockMistralResponse)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('mistral-large-latest')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('mistral')
    expect(proxyTrace?.spans[0]?.usage?.promptTokens).toBe(14)
    expect(proxyTrace?.spans[0]?.usage?.completionTokens).toBe(7)
    expect(typeof proxyTrace?.spans[0]?.usage?.totalCost).toBe('number')
    // Mistral large: $2.00/1M input, $6.00/1M output
    // 14 * 200/1M = 0.0028 cents, 7 * 600/1M = 0.0042 cents
    // Rounds to 0 cents for small token counts - use >= 0
    expect(proxyTrace?.spans[0]?.usage?.totalCost).toBeGreaterThanOrEqual(0)

    expect(proxyTrace?.spans[0]?.attributes?.['authorization']).toBeUndefined()
  })

  it('creates error trace when upstream fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === MISTRAL_URL) {
        return {
          ok: false,
          status: 429,
          clone: () => ({ json: () => Promise.resolve(mockErrorResponse) }),
          json: () => Promise.resolve(mockErrorResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await makeMistralProxyRequest({ model: 'mistral-large-latest', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(429)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['llm.model']).toBe('unknown')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('mistral')
    expect(errorTrace?.spans[0]?.attributes?.['http.status']).toBe(429)
  })

  it('creates error trace when network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === MISTRAL_URL) {
        throw new Error('ENOTFOUND')
      }
      return originalFetch(url, init)
    }))

    const res = await makeMistralProxyRequest({ model: 'mistral-large-latest', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(502)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-proxy' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['error.message']).toBe('ENOTFOUND')
  })

  it('uses default model when not specified', async () => {
    const res = await makeMistralProxyRequest({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('mistral-large-latest')
  })
})

describe('Azure OpenAI chat completions proxy', () => {
  const mockAzureResponse = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1723833600,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 }
  }

  const mockErrorResponse = {
    error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  }

  const AZURE_URL_BASE = 'https://'
  const originalFetch = global.fetch

  function makeAzureProxyRequest(
    body: unknown,
    headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: 'Bearer test-key',
      'x-azure-resource': 'my-resource',
      'x-azure-deployment': 'my-deployment'
    }
  ) {
    return fetch(`${baseUrl}/v1/proxy/azure/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr.startsWith(`${AZURE_URL_BASE}my-resource.openai.azure.com/`)) {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockAzureResponse) }),
          json: () => Promise.resolve(mockAzureResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 401 when Authorization and api-key headers are missing', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/azure/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-azure-resource': 'my-resource',
        'x-azure-deployment': 'my-deployment'
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing Authorization or api-key header')
  })

  it('accepts api-key header as alternative to Authorization', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/azure/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': 'test-key',
        'x-azure-resource': 'my-resource',
        'x-azure-deployment': 'my-deployment'
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(200)
  })

  it('returns 400 when x-azure-resource header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/azure/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
        'x-azure-deployment': 'my-deployment'
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing x-azure-resource or x-azure-deployment header')
  })

  it('returns 400 when x-azure-deployment header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/azure/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
        'x-azure-resource': 'my-resource'
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing x-azure-resource or x-azure-deployment header')
  })

  it('returns 400 for invalid resource name (SSRF prevention)', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/azure/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
        'x-azure-resource': 'evil.com',
        'x-azure-deployment': 'my-deployment'
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid resource or deployment name')
  })

  it('returns 400 for invalid deployment name (SSRF prevention)', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/azure/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
        'x-azure-resource': 'my-resource',
        'x-azure-deployment': 'evil;rm -rf /'
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid resource or deployment name')
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/azure/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
        'x-azure-resource': 'my-resource',
        'x-azure-deployment': 'my-deployment'
      },
      body: '{not json'
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid JSON body')
  })

  it('forwards request to Azure OpenAI and returns response with trace on success', async () => {
    const res = await makeAzureProxyRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockAzureResponse)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('gpt-4o')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('azure-openai')
    expect(proxyTrace?.spans[0]?.usage?.promptTokens).toBe(16)
    expect(proxyTrace?.spans[0]?.usage?.completionTokens).toBe(8)
    expect(typeof proxyTrace?.spans[0]?.usage?.totalCost).toBe('number')
    // Azure OpenAI gpt-4o: $2.50/1M input, $10.00/1M output
    // 16 * 250/1M = 0.004 cents, 8 * 1000/1M = 0.008 cents
    // Rounds to 0 cents for small token counts - use >= 0
    expect(proxyTrace?.spans[0]?.usage?.totalCost).toBeGreaterThanOrEqual(0)

    // Security: API key must not be in trace
    expect(proxyTrace?.spans[0]?.attributes?.['authorization']).toBeUndefined()
    expect(proxyTrace?.spans[0]?.attributes?.['api-key']).toBeUndefined()
  })

  it('creates error trace when upstream fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr.startsWith(`${AZURE_URL_BASE}my-resource.openai.azure.com/`)) {
        return {
          ok: false,
          status: 429,
          clone: () => ({ json: () => Promise.resolve(mockErrorResponse) }),
          json: () => Promise.resolve(mockErrorResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await makeAzureProxyRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(429)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['llm.model']).toBe('unknown')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('azure-openai')
    expect(errorTrace?.spans[0]?.attributes?.['http.status']).toBe(429)
  })

  it('creates error trace when network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr.startsWith(`${AZURE_URL_BASE}my-resource.openai.azure.com/`)) {
        throw new Error('ENOTFOUND')
      }
      return originalFetch(url, init)
    }))

    const res = await makeAzureProxyRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(502)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-proxy' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['error.message']).toBe('ENOTFOUND')
  })

  it('uses default model when not specified', async () => {
    const res = await makeAzureProxyRequest({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('gpt-4o')
  })

  it('uses custom api-version when provided', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr.startsWith(`${AZURE_URL_BASE}my-resource.openai.azure.com/`) && urlStr.includes('api-version=2024-06-01')) {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockAzureResponse) }),
          json: () => Promise.resolve(mockAzureResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await fetch(`${baseUrl}/v1/proxy/azure/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
        'x-azure-resource': 'my-resource',
        'x-azure-deployment': 'my-deployment',
        'x-azure-api-version': '2024-06-01'
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(200)
  })
})

describe('cost aggregation API', () => {
  function seedTraceWithUsage(
    name: string,
    usage: { promptTokens: number; completionTokens: number; totalTokens?: number },
    model = 'gpt-4o',
    sessionId?: string
  ): Promise<string> {
    return fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 1000).toISOString(),
        sessionId,
        spans: [
          {
            id: `span-${name}`,
            name: 'llm-call',
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 500).toISOString(),
            status: 'ok',
            usage: { ...usage, totalTokens: (usage.totalTokens ?? (usage.promptTokens + usage.completionTokens)) },
            attributes: { 'llm.model': model }
          }
        ]
      })
    }).then(async (res) => {
      const body = (await res.json()) as { id: string }
      return body.id
    })
  }

  it('returns 404 for unknown trace cost', async () => {
    const res = await fetch(`${baseUrl}/api/traces/no-such-id/cost`)
    expect(res.status).toBe(404)
  })

  it('returns cost breakdown for a trace with usage', async () => {
    const id = await seedTraceWithUsage('cost-trace', { promptTokens: 1_000_000, completionTokens: 500_000 }, 'gpt-4o')
    const res = await fetch(`${baseUrl}/api/traces/${id}/cost`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      traceId: string
      promptTokens: number
      completionTokens: number
      totalCostCents: number
      totalCostDollars: number
    }
    expect(body.traceId).toBe(id)
    expect(body.promptTokens).toBe(1_000_000)
    expect(body.completionTokens).toBe(500_000)
    // gpt-4o: $2.50/1M input, $10.00/1M output
    // 1M * 250/1M = 250 cents, 500K * 1000/1M = 500 cents = 750 cents
    expect(body.totalCostCents).toBe(750)
    expect(body.totalCostDollars).toBe(7.50)
  })

  it('returns zero cost for trace without usage', async () => {
    const res = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'no-usage-trace',
        startTime: '2026-08-16T10:00:00.000Z',
        endTime: '2026-08-16T10:00:01.000Z',
        spans: [
          {
            id: 'span-no-usage',
            name: 'parse',
            startTime: '2026-08-16T10:00:00.000Z',
            endTime: '2026-08-16T10:00:00.500Z',
            status: 'ok'
          }
        ]
      })
    })
    const { id } = (await res.json()) as { id: string }

    const costRes = await fetch(`${baseUrl}/api/traces/${id}/cost`)
    expect(costRes.status).toBe(200)
    const body = (await costRes.json()) as { totalCostCents: number; totalCostDollars: number }
    expect(body.totalCostCents).toBe(0)
    expect(body.totalCostDollars).toBe(0)
  })

  it('aggregates cost for a session', async () => {
    await seedTraceWithUsage('session-trace-1', { promptTokens: 1_000_000, completionTokens: 500_000 }, 'gpt-4o', 'session-cost-1')
    await seedTraceWithUsage('session-trace-2', { promptTokens: 500_000, completionTokens: 250_000 }, 'gpt-4o', 'session-cost-1')
    await seedTraceWithUsage('session-trace-3', { promptTokens: 2_000_000, completionTokens: 1_000_000 }, 'gpt-4o', 'session-cost-2')

    const res = await fetch(`${baseUrl}/api/sessions/session-cost-1/cost`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessionId: string
      traceCount: number
      promptTokens: number
      completionTokens: number
      totalCostCents: number
      totalCostDollars: number
    }
    expect(body.sessionId).toBe('session-cost-1')
    expect(body.traceCount).toBe(2)
    expect(body.promptTokens).toBe(1_500_000)
    expect(body.completionTokens).toBe(750_000)
    // trace-1: 750 cents, trace-2: 375 cents = 1125 cents
    expect(body.totalCostCents).toBe(1125)
    expect(body.totalCostDollars).toBe(11.25)
  })

  it('returns zero for empty session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/empty-session/cost`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { traceCount: number; totalCostCents: number }
    expect(body.traceCount).toBe(0)
    expect(body.totalCostCents).toBe(0)
  })

  it('aggregates session cost with mixed traces (some with usage, some without)', async () => {
    await seedTraceWithUsage('mixed-usage-1', { promptTokens: 1_000_000, completionTokens: 500_000 }, 'gpt-4o', 'session-mixed')
    // Trace without usage
    await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'session-mixed',
        startTime: '2026-08-16T10:00:00.000Z',
        endTime: '2026-08-16T10:00:01.000Z',
        spans: [
          {
            id: 'span-no-usage',
            name: 'parse',
            startTime: '2026-08-16T10:00:00.000Z',
            endTime: '2026-08-16T10:00:00.500Z',
            status: 'ok'
          }
        ],
        sessionId: 'session-mixed'
      })
    })
    await seedTraceWithUsage('mixed-usage-2', { promptTokens: 500_000, completionTokens: 250_000 }, 'gpt-4o', 'session-mixed')

    const res = await fetch(`${baseUrl}/api/sessions/session-mixed/cost`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessionId: string
      traceCount: number
      promptTokens: number
      completionTokens: number
      totalCostCents: number
      totalCostDollars: number
    }
    expect(body.sessionId).toBe('session-mixed')
    expect(body.traceCount).toBe(3)
    expect(body.promptTokens).toBe(1_500_000)
    expect(body.completionTokens).toBe(750_000)
    // trace-1: 750 cents, trace-3: 375 cents = 1125 cents (trace-2 has no usage = 0)
    expect(body.totalCostCents).toBe(1125)
    expect(body.totalCostDollars).toBe(11.25)
  })

  it('returns 400 for invalid sessionId', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${'a'.repeat(129)}/cost`)
    expect(res.status).toBe(400)
  })

  it('aggregates cost over time window', async () => {
    // These traces will be within the default 24h window
    await seedTraceWithUsage('window-trace-1', { promptTokens: 1_000_000, completionTokens: 500_000 }, 'gpt-4o')
    await seedTraceWithUsage('window-trace-2', { promptTokens: 500_000, completionTokens: 250_000 }, 'gpt-4o')

    const res = await fetch(`${baseUrl}/api/cost/summary?window=24`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      windowHours: number
      traceCount: number
      promptTokens: number
      completionTokens: number
      totalCostCents: number
      totalCostDollars: number
    }
    expect(body.windowHours).toBe(24)
    expect(body.traceCount).toBeGreaterThanOrEqual(2)
    expect(body.promptTokens).toBeGreaterThanOrEqual(1_500_000)
    expect(body.completionTokens).toBeGreaterThanOrEqual(750_000)
    expect(body.totalCostCents).toBeGreaterThanOrEqual(1125)
  })

  it('clamps window to maximum', async () => {
    const res = await fetch(`${baseUrl}/api/cost/summary?window=99999`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { windowHours: number }
    expect(body.windowHours).toBe(8760) // 1 year max
  })

  it('uses default window when not specified', async () => {
    const res = await fetch(`${baseUrl}/api/cost/summary`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { windowHours: number }
    expect(body.windowHours).toBe(24)
  })

  it('handles different models in cost aggregation', async () => {
    await seedTraceWithUsage('gpt4o-trace', { promptTokens: 1_000_000, completionTokens: 1_000_000 }, 'gpt-4o')
    await seedTraceWithUsage('claude-trace', { promptTokens: 1_000_000, completionTokens: 1_000_000 }, 'claude-3-5-sonnet-20241022')

    const res = await fetch(`${baseUrl}/api/cost/summary?window=24`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { totalCostCents: number }
    // gpt-4o: 1250 cents, claude: 1800 cents = 3050 cents
    expect(body.totalCostCents).toBeGreaterThanOrEqual(3050)
  })
})

describe('Generic passthrough proxy', () => {
  const mockOpenAIResponse = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1723833600,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  }

  const mockErrorResponse = {
    error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  }

  const originalFetch = global.fetch

  function makePassthroughRequest(
    upstreamPath: string,
    body: unknown,
    headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: 'Bearer test-key'
    }
  ) {
    return fetch(`${baseUrl}/v1/proxy/passthrough/${upstreamPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === 'https://api.openai.com/v1/chat/completions') {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockOpenAIResponse) }),
          json: () => Promise.resolve(mockOpenAIResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 400 when upstream path is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/passthrough/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing upstream path')
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/passthrough/api.openai.com/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: '{not json'
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid JSON body')
  })

  it('blocks localhost (SSRF prevention)', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/passthrough/localhost:8080/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('blocked hostname')
  })

  it('blocks 127.0.0.1 (SSRF prevention)', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/passthrough/127.0.0.1:8080/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('private IP range blocked')
  })

  it('blocks 169.254.169.254 metadata endpoint (SSRF prevention)', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/passthrough/169.254.169.254/latest/meta-data`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('blocked hostname')
  })

  it('blocks metadata.google.internal (SSRF prevention)', async () => {
    const res = await fetch(`${baseUrl}/v1/proxy/passthrough/metadata.google.internal/computeMetadata/v1/instance/id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('blocked hostname')
  })

  it('allows valid public hostname', async () => {
    const res = await makePassthroughRequest('api.openai.com/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockOpenAIResponse)
  })

  it('forwards request to upstream and returns response with trace on success', async () => {
    const res = await makePassthroughRequest('api.openai.com/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(mockOpenAIResponse)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('gpt-4o')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('generic-passthrough')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream.host']).toBe('api.openai.com')
    expect(proxyTrace?.spans[0]?.usage?.promptTokens).toBe(10)
    expect(proxyTrace?.spans[0]?.usage?.completionTokens).toBe(5)
    expect(typeof proxyTrace?.spans[0]?.usage?.totalCost).toBe('number')

    // Security: Authorization header must not be in trace
    expect(proxyTrace?.spans[0]?.attributes?.['authorization']).toBeUndefined()
  })

  it('creates error trace when upstream fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === 'https://api.openai.com/v1/chat/completions') {
        return {
          ok: false,
          status: 429,
          clone: () => ({ json: () => Promise.resolve(mockErrorResponse) }),
          json: () => Promise.resolve(mockErrorResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await makePassthroughRequest('api.openai.com/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(429)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['llm.model']).toBe('unknown')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('generic-passthrough')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream.host']).toBe('api.openai.com')
    expect(errorTrace?.spans[0]?.attributes?.['http.status']).toBe(429)
  })

  it('creates error trace when network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === 'https://api.openai.com/v1/chat/completions') {
        throw new Error('ENOTFOUND')
      }
      return originalFetch(url, init)
    }))

    const res = await makePassthroughRequest('api.openai.com/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(502)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; status: string; attributes: Record<string, unknown> }> }>; pagination: { total: number } }
    const errorTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-proxy' && s.status === 'error'))
    expect(errorTrace).toBeDefined()
    expect(errorTrace?.spans[0]?.attributes?.['error.message']).toBe('ENOTFOUND')
    expect(errorTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('generic-passthrough')
  })

  it('passes through Authorization header to upstream', async () => {
    let capturedAuthHeader: string | null = null
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === 'https://api.openai.com/v1/chat/completions') {
        const headers = init?.headers
        if (headers && typeof headers === 'object' && 'authorization' in headers) {
          const auth = (headers as Record<string, string | undefined>).authorization
          capturedAuthHeader = auth ?? null
        } else {
          capturedAuthHeader = null
        }
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockOpenAIResponse) }),
          json: () => Promise.resolve(mockOpenAIResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await makePassthroughRequest('api.openai.com/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }, {
      'content-type': 'application/json',
      authorization: 'Bearer custom-key-123'
    })
    expect(res.status).toBe(200)
    expect(capturedAuthHeader).toBe('Bearer custom-key-123')
  })

  it('passes through api-key header to upstream', async () => {
    let capturedApiKey: string | null = null
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === 'https://api.openai.com/v1/chat/completions') {
        const headers = init?.headers
        if (headers && typeof headers === 'object' && 'api-key' in headers) {
          const apiKey = (headers as Record<string, string | undefined>)['api-key']
          capturedApiKey = apiKey ?? null
        } else {
          capturedApiKey = null
        }
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockOpenAIResponse) }),
          json: () => Promise.resolve(mockOpenAIResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await fetch(`${baseUrl}/v1/proxy/passthrough/api.openai.com/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': 'test-api-key-456'
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(200)
    expect(capturedApiKey).toBe('test-api-key-456')
  })

  it('preserves query parameters in upstream URL', async () => {
    let capturedUrl: string | null = null
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr.startsWith('https://api.openai.com/v1/chat/completions')) {
        capturedUrl = urlStr
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockOpenAIResponse) }),
          json: () => Promise.resolve(mockOpenAIResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await fetch(`${baseUrl}/v1/proxy/passthrough/api.openai.com/v1/chat/completions?custom_param=test&foo=bar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(200)
    expect(capturedUrl).toContain('custom_param=test')
    expect(capturedUrl).toContain('foo=bar')
  })

  it('handles Anthropic-compatible upstream', async () => {
    const mockAnthropicResponse = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 8 }
    }

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === 'https://api.anthropic.com/v1/messages') {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockAnthropicResponse) }),
          json: () => Promise.resolve(mockAnthropicResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await fetch(`${baseUrl}/v1/proxy/passthrough/api.anthropic.com/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(200)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('claude-3-5-sonnet-20241022')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('generic-passthrough')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream.host']).toBe('api.anthropic.com')
    expect(proxyTrace?.spans[0]?.usage?.promptTokens).toBe(12)
    expect(proxyTrace?.spans[0]?.usage?.completionTokens).toBe(8)
  })

  it('handles Cohere-compatible upstream', async () => {
    const mockCohereResponse = {
      text: 'Hello!',
      generationId: 'gen-test',
      meta: { tokens: { inputTokens: 8, outputTokens: 6 } },
      model: 'command-r-plus'
    }

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString()
      if (urlStr === 'https://api.cohere.com/v1/chat') {
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: () => Promise.resolve(mockCohereResponse) }),
          json: () => Promise.resolve(mockCohereResponse)
        } as Response
      }
      return originalFetch(url, init)
    }))

    const res = await fetch(`${baseUrl}/v1/proxy/passthrough/api.cohere.com/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ message: 'hi', model: 'command-r-plus' })
    })
    expect(res.status).toBe(200)

    const tracesRes = await fetch(`${baseUrl}/api/traces`)
    const tracesBody = (await tracesRes.json()) as { data: Array<{ spans: Array<{ name: string; attributes: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const proxyTrace = tracesBody.data.find((t) => t.spans.some((s) => s.name === 'llm-call'))
    expect(proxyTrace).toBeDefined()
    expect(proxyTrace?.spans[0]?.attributes?.['llm.model']).toBe('command-r-plus')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream']).toBe('generic-passthrough')
    expect(proxyTrace?.spans[0]?.attributes?.['proxy.upstream.host']).toBe('api.cohere.com')
    expect(proxyTrace?.spans[0]?.usage?.promptTokens).toBe(8)
    expect(proxyTrace?.spans[0]?.usage?.completionTokens).toBe(6)
  })
})

describe('trace API expression filter', () => {
  // Use future timestamps (year 2099) to ensure these traces sort first in startTime:desc order,
  // since the shared test database contains many traces from earlier tests with recent timestamps.
  const baseTime = '2099-01-01T00:00:00.000Z'
  let timeOffset = 0
  function nextTime(): string {
    const t = new Date(Date.parse(baseTime) + timeOffset)
    timeOffset += 1000 // 1 second increments
    return t.toISOString()
  }

  function seedTrace(
    startTime: string,
    name: string,
    spanStatus: 'ok' | 'error' = 'ok',
    options?: { sessionId?: string; userId?: string; attributes?: Record<string, unknown>; usage?: { promptTokens: number; completionTokens: number; totalTokens?: number; totalCost?: number } }
  ) {
    const usage = options?.usage
    return fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        startTime,
        endTime: new Date(Date.parse(startTime) + 1000).toISOString(),
        sessionId: options?.sessionId,
        userId: options?.userId,
        spans: [
          {
            id: `span-${name}`,
            name: 'llm-call',
            startTime,
            endTime: new Date(Date.parse(startTime) + 500).toISOString(),
            status: spanStatus,
            attributes: options?.attributes,
            usage: usage ? { ...usage, totalTokens: usage.totalTokens ?? (usage.promptTokens + usage.completionTokens) } : undefined
          }
        ]
      })
    })
  }

  function makeFilterUrl(filter: string) {
    const params = new URLSearchParams()
    params.set('filter', filter)
    return `${baseUrl}/api/traces?${params.toString()}`
  }

  it('filters by status:error using expression filter', async () => {
    const prefix = 'filter-status-error-'
    await seedTrace(nextTime(), prefix + 'ok-filtered')
    await seedTrace(nextTime(), prefix + 'err-a', 'error')
    await seedTrace(nextTime(), prefix + 'err-b', 'error')

    const res = await fetch(`${baseUrl}/api/traces?filter=status:error AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(2)
    expect(body.data.map((t) => t.name).sort()).toEqual([prefix + 'err-a', prefix + 'err-b'])
    expect(body.pagination.total).toBe(2)
  })

  it('filters by duration_ms comparison', async () => {
    const prefix = 'filter-duration-'
    // Create short trace (100ms duration) and long trace (1000ms duration) manually
    // to avoid seedTrace's fixed 1000ms duration
    const shortStart = nextTime()
    await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: prefix + 'short',
        startTime: shortStart,
        endTime: new Date(Date.parse(shortStart) + 100).toISOString(), // 100ms trace duration
        spans: [{
          id: `span-${prefix}short`,
          name: 'llm-call',
          startTime: shortStart,
          endTime: new Date(Date.parse(shortStart) + 50).toISOString(),
          status: 'ok'
        }]
      })
    })
    const longStart = nextTime()
    await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: prefix + 'long',
        startTime: longStart,
        endTime: new Date(Date.parse(longStart) + 1000).toISOString(), // 1000ms trace duration
        spans: [{
          id: `span-${prefix}long`,
          name: 'llm-call',
          startTime: longStart,
          endTime: new Date(Date.parse(longStart) + 500).toISOString(),
          status: 'ok'
        }]
      })
    })

    const res = await fetch(`${baseUrl}/api/traces?filter=duration_ms>500 AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'long')
  })

  it('filters by name contains (:)', async () => {
    const prefix = 'filter-name-contains-'
    await seedTrace(nextTime(), prefix + 'chat-service')
    await seedTrace(nextTime(), prefix + 'api-service')

    const res = await fetch(`${baseUrl}/api/traces?filter=name:chat AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'chat-service')
  })

  it('filters by name not contains (!~)', async () => {
    const prefix = 'filter-name-not-contains-'
    await seedTrace(nextTime(), prefix + 'chat-service')
    await seedTrace(nextTime(), prefix + 'api-service')

    const res = await fetch(`${baseUrl}/api/traces?filter=name!~chat AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'api-service')
  })

  it('filters by sessionId', async () => {
    const prefix = 'filter-session-'
    await seedTrace(nextTime(), prefix + 'trace-a', 'ok', { sessionId: 'session-123' })
    await seedTrace(nextTime(), prefix + 'trace-b', 'ok', { sessionId: 'session-456' })

    const res = await fetch(`${baseUrl}/api/traces?filter=sessionId:session-123 AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'trace-a')
  })

  it('filters by userId', async () => {
    const prefix = 'filter-user-'
    await seedTrace(nextTime(), prefix + 'trace-a', 'ok', { userId: 'user-123' })
    await seedTrace(nextTime(), prefix + 'trace-b', 'ok', { userId: 'user-456' })

    const res = await fetch(`${baseUrl}/api/traces?filter=userId:user-123 AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'trace-a')
  })

  it('filters by span.name', async () => {
    const prefix = 'filter-span-name-'
    // Set span name directly (not via attributes) since evaluator checks span.name field
    await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: prefix + 'trace-a',
        startTime: nextTime(),
        endTime: new Date(Date.parse(nextTime()) + 1000).toISOString(),
        spans: [{
          id: `span-${prefix}trace-a`,
          name: 'custom-span',
          startTime: nextTime(),
          endTime: new Date(Date.parse(nextTime()) + 500).toISOString(),
          status: 'ok'
        }]
      })
    })
    await seedTrace(nextTime(), prefix + 'trace-b', 'ok', { attributes: { 'span.name': 'other-span' } })

    const res = await fetch(`${baseUrl}/api/traces?filter=span.name:custom-span AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'trace-a')
  })

  it('filters by span.attributes', async () => {
    const prefix = 'filter-span-attrs-'
    await seedTrace(nextTime(), prefix + 'trace-a', 'ok', { attributes: { 'llm.model': 'gpt-4o' } })
    await seedTrace(nextTime(), prefix + 'trace-b', 'ok', { attributes: { 'llm.model': 'claude-3' } })

    const res = await fetch(`${baseUrl}/api/traces?filter=span.attributes.llm.model:gpt-4o AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'trace-a')
  })

  it('combines filter with discrete params (AND semantics)', async () => {
    const prefix = 'filter-combine-'
    await seedTrace(nextTime(), prefix + 'chat-service', 'error', { sessionId: 'session-123' })
    await seedTrace(nextTime(), prefix + 'chat-service', 'ok', { sessionId: 'session-123' })
    await seedTrace(nextTime(), prefix + 'api-service', 'error', { sessionId: 'session-456' })

    // filter=status:error AND serviceName=chat (discrete param)
    const res = await fetch(`${baseUrl}/api/traces?filter=status:error&serviceName=${prefix}chat-service`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'chat-service')
  })

  it('handles AND logic', async () => {
    const prefix = 'filter-and-'
    await seedTrace(nextTime(), prefix + 'chat-service', 'error')
    await seedTrace(nextTime(), prefix + 'chat-service', 'ok')
    await seedTrace(nextTime(), prefix + 'api-service', 'error')

    const res = await fetch(`${baseUrl}/api/traces?filter=name:chat AND status:error AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'chat-service')
  })

  it('handles OR logic', async () => {
    const prefix = 'filter-or-'
    await seedTrace(nextTime(), prefix + 'chat-service', 'ok')
    await seedTrace(nextTime(), prefix + 'api-service', 'ok')
    await seedTrace(nextTime(), prefix + 'other-service', 'ok')

    // Parentheses needed: (name:chat OR name:api) AND name:prefix
    // Without parentheses, AND binds tighter: name:chat OR (name:api AND name:prefix)
    const res = await fetch(`${baseUrl}/api/traces?filter=(name:chat OR name:api) AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(2)
    expect(body.data.map((t) => t.name).sort()).toEqual([prefix + 'api-service', prefix + 'chat-service'])
  })

  it('handles NOT logic', async () => {
    const prefix = 'filter-not-'
    await seedTrace(nextTime(), prefix + 'chat-service', 'error')
    await seedTrace(nextTime(), prefix + 'api-service', 'ok')

    const res = await fetch(`${baseUrl}/api/traces?filter=NOT status:error AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'api-service')
  })

  it('handles grouped expressions with parentheses', async () => {
    const prefix = 'filter-group-'
    await seedTrace(nextTime(), prefix + 'chat-service', 'error')
    await seedTrace(nextTime(), prefix + 'api-service', 'error')
    await seedTrace(nextTime(), prefix + 'chat-service', 'ok')

    const res = await fetch(`${baseUrl}/api/traces?filter=(name:chat OR name:api) AND status:error AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(2)
    expect(body.data.map((t) => t.name).sort()).toEqual([prefix + 'api-service', prefix + 'chat-service'])
  })

  it('returns 400 for invalid filter expression', async () => {
    const res = await fetch(`${baseUrl}/api/traces?filter=invalid expression`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; details: string[] }
    expect(body.error).toBe('invalid filter expression')
    expect(body.details).toBeDefined()
  })

  it('returns 400 for malformed filter syntax', async () => {
    const res = await fetch(`${baseUrl}/api/traces?filter=status:`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; details: string[] }
    expect(body.error).toBe('invalid filter expression')
  })

  it('filters by usage.promptTokens', async () => {
    const prefix = 'filter-usage-'
    await seedTrace(nextTime(), prefix + 'trace-a', 'ok', { usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } })
    await seedTrace(nextTime(), prefix + 'trace-b', 'ok', { usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 } })

    const res = await fetch(`${baseUrl}/api/traces?filter=usage.promptTokens>75 AND name:${prefix}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string }[]; pagination: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.name).toBe(prefix + 'trace-a')
  })
})
