import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { app } from '../../src/server/index.js'

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
})
