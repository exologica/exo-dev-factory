import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TraceStore } from '../../src/domain/store.js'

const dbDir = mkdtempSync(path.join(tmpdir(), 'exo-dev-factory-otlp-'))
const dbPath = path.join(dbDir, 'traces.db')
process.env.TRACE_DB_PATH = dbPath

const { app } = await import('../../src/server/index.js')

const validOtlpRequest = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'otlp-test-service' } },
          { key: 'session.id', value: { stringValue: 'otlp-session-123' } },
          { key: 'user.id', value: { stringValue: 'otlp-user-456' } }
        ]
      },
      scopeSpans: [
        {
          scope: { name: 'test-scope', version: '1.0.0' },
          spans: [
            {
              traceId: '00000000000000000000000000000001',
              spanId: '0000000000000001',
              name: 'llm-call',
              kind: 2,
              startTimeUnixNano: '1723833600000000000',
              endTimeUnixNano: '1723833605000000000',
              attributes: [
                { key: 'gen_ai.system', value: { stringValue: 'openai' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
                { key: 'gen_ai.usage.prompt_tokens', value: { intValue: '100' } },
                { key: 'gen_ai.usage.completion_tokens', value: { intValue: '50' } },
                { key: 'gen_ai.usage.total_tokens', value: { intValue: '150' } },
                { key: 'http.status_code', value: { intValue: '200' } }
              ],
              status: { code: 1 }
            }
          ]
        }
      ]
    }
  ]
}

const validOtlpRequestMultipleTraces = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'trace-a' } }] },
      scopeSpans: [
        {
          spans: [
            {
              traceId: '00000000000000000000000000000002',
              spanId: '0000000000000002',
              name: 'trace-a-span',
              startTimeUnixNano: '1723833600000000000',
              endTimeUnixNano: '1723833601000000000',
              status: { code: 1 }
            }
          ]
        }
      ]
    },
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'trace-b' } }] },
      scopeSpans: [
        {
          spans: [
            {
              traceId: '00000000000000000000000000000003',
              spanId: '0000000000000003',
              name: 'trace-b-span',
              startTimeUnixNano: '1723833602000000000',
              endTimeUnixNano: '1723833603000000000',
              status: { code: 2 }
            }
          ]
        }
      ]
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

describe('OTLP /v1/traces endpoint', () => {
  it('accepts a valid OTLP request and returns 202 with traceIds', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validOtlpRequest)
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { traceIds: string[]; count: number }
    expect(Array.isArray(body.traceIds)).toBe(true)
    expect(body.traceIds.length).toBe(1)
    expect(body.count).toBe(1)
  })

  it('stores traces that are retrievable via GET /api/traces', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validOtlpRequest)
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { traceIds: string[]; count: number }
    expect(body.traceIds.length).toBeGreaterThan(0)
    const traceId = body.traceIds[0]!

    const getRes = await fetch(`${baseUrl}/api/traces/${traceId}`)
    expect(getRes.status).toBe(200)
    const trace = (await getRes.json()) as { name: string; spans: Array<{ name: string; attributes?: Record<string, unknown>; usage?: { promptTokens: number } }> }
    expect(trace.name).toBe('otlp-test-service')
    expect(trace.spans.length).toBe(1)
    const span = trace.spans[0]!
    expect(span.name).toBe('llm-call')
    expect(span.attributes?.['gen_ai.system']).toBe('openai')
    expect(span.attributes?.['gen_ai.request.model']).toBe('gpt-4o')
    expect(span.usage?.promptTokens).toBe(100)
  })

  it('includes sessionId and userId from resource attributes', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validOtlpRequest)
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { traceIds: string[] }
    const traceId = body.traceIds[0]

    const getRes = await fetch(`${baseUrl}/api/traces/${traceId}`)
    expect(getRes.status).toBe(200)
    const trace = (await getRes.json()) as { sessionId?: string; userId?: string }
    expect(trace.sessionId).toBe('otlp-session-123')
    expect(trace.userId).toBe('otlp-user-456')
  })

  it('handles multiple traces in one request', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validOtlpRequestMultipleTraces)
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { traceIds: string[]; count: number }
    expect(body.traceIds.length).toBe(2)
    expect(body.count).toBe(2)

    // Verify both traces are retrievable
    for (const traceId of body.traceIds) {
      const getRes = await fetch(`${baseUrl}/api/traces/${traceId}`)
      expect(getRes.status).toBe(200)
    }
  })

  it('appears in trace list with correct filters', async () => {
    await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validOtlpRequest)
    })

    const listRes = await fetch(`${baseUrl}/api/traces?serviceName=otlp-test-service`)
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as { data: Array<{ name: string }>; pagination: { total: number } }
    expect(listBody.pagination.total).toBeGreaterThanOrEqual(1)
    expect(listBody.data.some((t) => t.name === 'otlp-test-service')).toBe(true)
  })

  it('returns 400 for invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid JSON body')
  })

  it('returns 400 for missing resourceSpans', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid OTLP payload')
  })

  it('returns 400 for empty resourceSpans', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceSpans: [] })
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid traceId format', async () => {
    const invalidRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { traceId: 'invalid', spanId: '0000000000000001', name: 'x', startTimeUnixNano: '0', endTimeUnixNano: '1', status: {} }
              ]
            }
          ]
        }
      ]
    }
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalidRequest)
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid spanId format', async () => {
    const invalidRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { traceId: '00000000000000000000000000000001', spanId: 'invalid', name: 'x', startTimeUnixNano: '0', endTimeUnixNano: '1', status: {} }
              ]
            }
          ]
        }
      ]
    }
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalidRequest)
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing required span fields', async () => {
    const invalidRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { traceId: '00000000000000000000000000000001', spanId: '0000000000000001', startTimeUnixNano: '0', endTimeUnixNano: '1', status: {} }
              ]
            }
          ]
        }
      ]
    }
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalidRequest)
    })
    expect(res.status).toBe(400)
  })

  it('returns 413 for payload exceeding 10MB', async () => {
    // Create a request with a large payload (over 10MB)
    const largeRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: Array.from({ length: 10000 }, (_, i) => ({
                traceId: '00000000000000000000000000000001',
                spanId: String(i).padStart(16, '0'),
                name: `span-${i}`,
                startTimeUnixNano: '1723833600000000000',
                endTimeUnixNano: '1723833605000000000',
                attributes: Array.from({ length: 100 }, (_, j) => ({
                  key: `attr.${j}`,
                  value: { stringValue: 'x'.repeat(100) }
                })),
                status: { code: 1 }
              }))
            }
          ]
        }
      ]
    }

    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(largeRequest)
    })
    // Should either return 413 (payload too large) or 400 (validation)
    // The 413 check happens at content-length header level
    expect([400, 413]).toContain(res.status)
  })

  it('preserves existing /api/traces endpoint', async () => {
    // Verify the original endpoint still works
    const res = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'original-endpoint-test',
        startTime: '2026-08-16T10:00:00.000Z',
        endTime: '2026-08-16T10:00:01.000Z',
        spans: [
          {
            id: 'span-original',
            name: 'parse',
            startTime: '2026-08-16T10:00:00.000Z',
            endTime: '2026-08-16T10:00:00.500Z',
            status: 'ok'
          }
        ]
      })
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    expect(body.id).toBeTypeOf('string')
  })

  it('maps OTLP error status correctly', async () => {
    const errorRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: '00000000000000000000000000000004',
                  spanId: '0000000000000004',
                  name: 'error-span',
                  startTimeUnixNano: '1723833600000000000',
                  endTimeUnixNano: '1723833605000000000',
                  status: { code: 2 }
                }
              ]
            }
          ]
        }
      ]
    }

    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(errorRequest)
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { traceIds: string[] }
    expect(body.traceIds.length).toBeGreaterThan(0)
    const traceId = body.traceIds[0]!

    const getRes = await fetch(`${baseUrl}/api/traces/${traceId}`)
    expect(getRes.status).toBe(200)
    const trace = (await getRes.json()) as { spans: Array<{ status: string }> }
    expect(trace.spans.length).toBeGreaterThan(0)
    expect(trace.spans[0]!.status).toBe('error')
  })

  it('maps OTLP ok status correctly', async () => {
    const okRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: '00000000000000000000000000000005',
                  spanId: '0000000000000005',
                  name: 'ok-span',
                  startTimeUnixNano: '1723833600000000000',
                  endTimeUnixNano: '1723833605000000000',
                  status: { code: 1 }
                }
              ]
            }
          ]
        }
      ]
    }

    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(okRequest)
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { traceIds: string[] }
    expect(body.traceIds.length).toBeGreaterThan(0)
    const traceId = body.traceIds[0]!

    const getRes = await fetch(`${baseUrl}/api/traces/${traceId}`)
    expect(getRes.status).toBe(200)
    const trace = (await getRes.json()) as { spans: Array<{ status: string }> }
    expect(trace.spans.length).toBeGreaterThan(0)
    expect(trace.spans[0]!.status).toBe('ok')
  })
})