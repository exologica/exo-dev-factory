import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
    const body = (await res.json()) as { id: string }[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
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
  function seedTrace(startTime: string, name: string, spanStatus: 'ok' | 'error' = 'ok') {
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
            status: spanStatus
          }
        ]
      })
    })
  }

  it('paginates GET /api/traces with limit and offset', async () => {
    for (let i = 0; i < 15; i += 1) {
      await seedTrace(`2026-08-16T12:${String(i).padStart(2, '0')}:00.000Z`, `page-${i}`)
    }

    const page1 = (await (await fetch(`${baseUrl}/api/traces?limit=10`)).json()) as {
      id: string
      name: string
    }[]
    expect(page1).toHaveLength(10)
    expect(page1[0]?.name).toBe('page-14')

    // The suite shares one DB file, so other tests may have seeded traces too.
    // Expected remainder is the true total minus the first page.
    const all = (await (await fetch(`${baseUrl}/api/traces`)).json()) as { id: string; name: string }[]
    const page2 = (await (
      await fetch(`${baseUrl}/api/traces?limit=10&offset=10`)
    ).json()) as { id: string; name: string }[]
    expect(page2).toHaveLength(all.length - 10)
    const page1Ids = new Set(page1.map((t) => t.id))
    expect(page2.every((t) => !page1Ids.has(t.id))).toBe(true)
  })

  it('filters GET /api/traces by derived status', async () => {
    await seedTrace('2026-08-16T13:00:00.000Z', 'ok-filtered')
    await seedTrace('2026-08-16T13:01:00.000Z', 'err-a', 'error')
    await seedTrace('2026-08-16T13:02:00.000Z', 'err-b', 'error')

    const res = await fetch(`${baseUrl}/api/traces?status=error`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string }[]
    expect(body).toHaveLength(2)
    expect(body.map((t) => t.name).sort()).toEqual(['err-a', 'err-b'])
  })

  it('clamps the limit to the documented maximum', async () => {
    for (let i = 0; i < 120; i += 1) {
      await seedTrace(`2026-08-16T14:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`, `bulk-${i}`)
    }

    const res = await fetch(`${baseUrl}/api/traces?limit=9999`)
    const body = (await res.json()) as unknown[]
    expect(body).toHaveLength(100)
  })

  it('degrades invalid pagination parameters to documented defaults', async () => {
    const res = await fetch(`${baseUrl}/api/traces?limit=abc&offset=-3&status=bogus`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeLessThanOrEqual(100)
  })
})
