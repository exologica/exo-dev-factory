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
