import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { traceSchema } from '../domain/trace.js'
import { z } from 'zod'
import { TraceStore } from '../domain/store.js'

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

// Query params degrade safely to documented defaults: a missing, non-numeric,
// out-of-range, or unknown status value falls back instead of erroring, and
// the limit is hard-capped so responses stay bounded.
const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_TRACE_LIST_LIMIT).catch(MAX_TRACE_LIST_LIMIT),
  offset: z.coerce.number().int().nonnegative().catch(0),
  status: z.enum(['ok', 'error']).optional().catch(undefined)
})

app.get('/api/traces', (c) => c.json(store.list(listQuerySchema.parse(c.req.query()))))

app.get('/api/traces/:id', (c) => {
  const trace = store.get(c.req.param('id'))
  if (!trace) {
    return c.json({ error: 'trace not found' }, 404)
  }
  return c.json(trace)
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
