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

  it('clamps the limit to the documented maximum', async () => {
    for (let i = 0; i < 120; i += 1) {
      await seedTrace(`2026-08-16T14:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`, `bulk-${i}`)
    }

    const res = await fetch(`${baseUrl}/api/traces?limit=9999`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[]; pagination: { limit: number } }
    expect(body.data).toHaveLength(100)
    expect(body.pagination.limit).toBe(100)
  })

  it('degrades invalid pagination parameters to documented defaults', async () => {
    const res = await fetch(`${baseUrl}/api/traces?limit=abc&offset=-3&status=bogus`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[]; pagination: { limit: number } }
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBeLessThanOrEqual(100)
    expect(body.pagination.limit).toBe(20) // default limit
  })
})

describe('trace API usage fields', () => {
  async function seedTraceWithUsage(name: string, usage?: { promptTokens: number; completionTokens: number; totalCost?: number }) {
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
            usage: { promptTokens: 100, completionTokens: 50, totalCost: 0.0015 }
          }
        ]
      })
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    expect(body.id).toBeTypeOf('string')
  })

  it('round-trips usage fields via GET /api/traces/:id', async () => {
    const id = await seedTraceWithUsage('round-trip', { promptTokens: 200, completionTokens: 100, totalCost: 0.003 })
    const res = await fetch(`${baseUrl}/api/traces/${id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { spans: Array<{ usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }
    expect(body.spans[0]?.usage).toEqual({ promptTokens: 200, completionTokens: 100, totalCost: 0.003 })
  })

  it('round-trips usage fields via GET /api/traces list', async () => {
    await seedTraceWithUsage('list-round-trip', { promptTokens: 150, completionTokens: 75, totalCost: 0.00225 })
    const res = await fetch(`${baseUrl}/api/traces`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ name: string; spans: Array<{ usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const found = body.data.find((t) => t.name === 'list-round-trip')
    expect(found).toBeDefined()
    expect(found?.spans[0]?.usage).toEqual({ promptTokens: 150, completionTokens: 75, totalCost: 0.00225 })
  })

  it('round-trips usage without totalCost', async () => {
    const id = await seedTraceWithUsage('no-cost', { promptTokens: 100, completionTokens: 50 })
    const res = await fetch(`${baseUrl}/api/traces/${id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { spans: Array<{ usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }
    expect(body.spans[0]?.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalCost: undefined })
  })

  it('handles mixed traces with and without usage in list', async () => {
    await seedTraceWithUsage('mixed-no-usage')
    await seedTraceWithUsage('mixed-with-usage', { promptTokens: 300, completionTokens: 150, totalCost: 0.0045 })
    const res = await fetch(`${baseUrl}/api/traces`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ name: string; spans: Array<{ usage?: { promptTokens: number; completionTokens: number; totalCost?: number } }> }>; pagination: { total: number } }
    const noUsage = body.data.find((t) => t.name === 'mixed-no-usage')
    const withUsage = body.data.find((t) => t.name === 'mixed-with-usage')
    expect(noUsage?.spans[0]?.usage).toBeUndefined()
    expect(withUsage?.spans[0]?.usage).toEqual({ promptTokens: 300, completionTokens: 150, totalCost: 0.0045 })
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

describe('cost aggregation API', () => {
  function seedTraceWithUsage(
    name: string,
    usage: { promptTokens: number; completionTokens: number },
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
            usage,
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
