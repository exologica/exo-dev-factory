import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { traceSchema } from '../domain/trace.js'
import { z } from 'zod'
import { TraceStore } from '../domain/store.js'
import type { Trace } from '../domain/trace.js'
import { pricingEngine } from '../domain/pricing.js'

// Durable by default: traces survive restarts in a local SQLite file. The
// location is deterministic and documented (README); override with
// TRACE_DB_PATH, or pass ':memory:' for a throwaway in-memory database.
const store = new TraceStore({
  dbPath: process.env.TRACE_DB_PATH
    ? path.resolve(process.env.TRACE_DB_PATH)
    : path.resolve('data', 'traces.db')
})
const app = new Hono()

app.post('/api/traces', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (body === null) {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const parsed = traceSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid trace', details: parsed.error.issues }, 400)
  }
  const id = store.add(parsed.data)
  return c.json({ id }, 201)
})

const MAX_TRACE_LIST_LIMIT = 100
const DEFAULT_TRACE_LIST_LIMIT = 20

// Query params degrade safely to documented defaults: a missing, non-numeric,
// out-of-range, or unknown status value falls back instead of erroring, and
// the limit is hard-capped so responses stay bounded.
const listQuerySchema = z.object({
  // Page-based pagination (1-based)
  page: z.coerce.number().int().positive().catch(1),
  // Clamp limit to [1, MAX_TRACE_LIST_LIMIT]; invalid/missing falls back to default.
  limit: z.coerce.number().int().positive().transform((v) => Math.min(Math.max(v, 1), MAX_TRACE_LIST_LIMIT)).catch(DEFAULT_TRACE_LIST_LIMIT),
  // Legacy offset-based pagination (kept for backward compatibility); clamp negative to 0.
  offset: z.coerce.number().int().transform((v) => Math.max(v, 0)).optional(),
  status: z.enum(['ok', 'error']).optional().catch(undefined),
  sessionId: z.string().max(128).optional().catch(undefined),
  userId: z.string().max(128).optional().catch(undefined),
  serviceName: z.string().max(256).optional().catch(undefined),
  operationName: z.string().max(256).optional().catch(undefined),
  startTimeGte: z.string().datetime({ offset: true }).optional().catch(undefined),
  startTimeLte: z.string().datetime({ offset: true }).optional().catch(undefined),
  sort: z
    .enum([
      'startTime:asc',
      'startTime:desc',
      'durationMs:asc',
      'durationMs:desc',
      'name:asc',
      'name:desc'
    ])
    .optional()
    .catch(undefined)
})

app.get('/api/traces', (c) => {
  const query = listQuerySchema.parse(c.req.query())
  const page = query.page ?? 1
  const limit = query.limit ?? DEFAULT_TRACE_LIST_LIMIT
  const offset = query.offset ?? (page - 1) * limit

  const listOptions = {
    limit,
    offset,
    status: query.status,
    sessionId: query.sessionId,
    userId: query.userId,
    serviceName: query.serviceName,
    operationName: query.operationName,
    startTimeGte: query.startTimeGte,
    startTimeLte: query.startTimeLte,
    sort: query.sort
  }

  const data = store.list(listOptions)
  const total = store.count(listOptions)
  const totalPages = Math.ceil(total / limit)

  return c.json({
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages
    }
  })
})

app.get('/api/traces/:id', (c) => {
  const trace = store.get(c.req.param('id'))
  if (!trace) {
    return c.json({ error: 'trace not found' }, 404)
  }
  return c.json(trace)
})

app.delete('/api/traces/:id', (c) => {
  if (!store.delete(c.req.param('id'))) {
    return c.json({ error: 'trace not found' }, 404)
  }
  return c.body(null, 204)
})

// Cost aggregation endpoints

const costQuerySchema = z.object({
  // Clamp window to [1, 8760] (max 1 year in hours); invalid/missing falls back to 24.
  window: z.coerce.number().int().positive().transform((v) => Math.min(Math.max(v, 1), 8760)).catch(24)
})

app.get('/api/traces/:id/cost', (c) => {
  const cost = store.getTraceCost(c.req.param('id'))
  if (!cost) {
    return c.json({ error: 'trace not found' }, 404)
  }
  return c.json(cost)
})

app.get('/api/sessions/:sessionId/cost', (c) => {
  const sessionId = c.req.param('sessionId')
  if (!sessionId || sessionId.length > 128) {
    return c.json({ error: 'invalid sessionId' }, 400)
  }
  const cost = store.getSessionCost(sessionId)
  return c.json(cost)
})

app.get('/api/cost/summary', (c) => {
  const query = costQuerySchema.parse(c.req.query())
  const cost = store.getTimeWindowCost(query.window)
  return c.json(cost)
})

app.post('/v1/proxy/chat/completions', async (c) => {
  const authHeader = c.req.header('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'missing or invalid Authorization header' }, 401)
  }

  const body = await c.req.json().catch(() => null)
  if (body === null) {
    return c.json({ error: 'invalid JSON body' }, 400)
  }

  const startTime = new Date().toISOString()
  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: authHeader
    },
    body: JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', requestInit)
  } catch (err) {
    const endTime = new Date().toISOString()
    const errorTrace: Trace = {
      name: 'proxy-chat-completions',
      startTime,
      endTime,
      spans: [
        {
          id: crypto.randomUUID(),
          name: 'llm-proxy',
          startTime,
          endTime,
          status: 'error',
          attributes: {
            'error.message': err instanceof Error ? err.message : 'unknown error',
            'proxy.upstream': 'openai'
          }
        }
      ]
    }
    store.add(errorTrace)
    return c.json({ error: 'upstream request failed' }, 502)
  }

  const endTime = new Date().toISOString()
  const responseBody = (await response.clone().json().catch(() => ({}))) as {
    model?: string
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
  }

  const model = typeof responseBody.model === 'string' ? responseBody.model : 'unknown'
  const promptTokens = typeof responseBody.usage?.prompt_tokens === 'number' ? responseBody.usage.prompt_tokens : 0
  const completionTokens = typeof responseBody.usage?.completion_tokens === 'number' ? responseBody.usage.completion_tokens : 0
  const totalTokens = typeof responseBody.usage?.total_tokens === 'number' ? responseBody.usage.total_tokens : promptTokens + completionTokens

  const inputCostPerToken = 2.50 / 1_000_000
  const outputCostPerToken = 10.00 / 1_000_000
  const totalCost = promptTokens * inputCostPerToken + completionTokens * outputCostPerToken

  const trace: Trace = {
    name: 'proxy-chat-completions',
    startTime,
    endTime,
    spans: [
      {
        id: crypto.randomUUID(),
        name: 'llm-call',
        startTime,
        endTime,
        status: response.ok ? 'ok' : 'error',
        attributes: {
          'llm.model': model,
          'proxy.upstream': 'openai',
          'http.status': response.status
        },
        usage: {
          promptTokens,
          completionTokens,
          totalCost
        }
      }
    ]
  }

  store.add(trace)

  return new Response(JSON.stringify(responseBody), {
    status: response.status,
    headers: {
      'content-type': 'application/json'
    }
  })
})

app.use('*', serveStatic({ root: './dist/client' }))
app.get('*', (c) => c.text('not found', 404))

const port = Number(process.env.PORT ?? 8787)

// Bind only when executed directly so tests can import { app } without
// occupying a port (integration tests start their own ephemeral listener).
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`exo-dev-factory listening on http://localhost:${info.port}`)
  })
}

export { app, store }
