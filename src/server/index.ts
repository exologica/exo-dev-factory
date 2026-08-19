import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { traceSchema } from '../domain/trace.js'
import { parseOtlpTracesRequest, type OtlpTracesRequest } from '../domain/otlp.js'
import { z } from 'zod'
import { TraceStore } from '../domain/store.js'
import type { Trace, TraceStatus } from '../domain/trace.js'
import { pricingEngine } from '../domain/pricing.js'
import { parseFilterExpression, type FilterExpr } from '../domain/filter-parser.js'

// Anthropic API constants
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_API_VERSION = '2023-06-01'

// Google Gemini API constants
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

// Cohere API constants
const COHERE_URL = 'https://api.cohere.com/v1/chat'

// Mistral API constants
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions'

// OpenAI Responses API constants
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

// Azure OpenAI API constants
// Azure OpenAI endpoint format: https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=2024-02-15-preview
const AZURE_API_VERSION = '2024-02-15-preview'
const AZURE_BASE_HOST = 'openai.azure.com'

// Generic passthrough proxy constants
const PRIVATE_IP_RANGES = [
  /^10\./,                    // 10.0.0.0/8
  /^127\./,                   // 127.0.0.0/8 (localhost)
  /^169\.254\./,              // 169.254.0.0/16 (link-local)
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
  /^192\.168\./,              // 192.168.0.0/16
  /^::1$/,                    // IPv6 localhost
  /^fe80::/,                  // IPv6 link-local
  /^fc00::/,                  // IPv6 unique local
  /^fd00::/                   // IPv6 unique local
]

const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',  // GCP metadata
  '169.254.169.254',           // AWS/Azure/GCP metadata
  'metadata.azure.com',        // Azure metadata
  'metadata'                   // Generic metadata
]

// SSRF protection: validate hostname against blocklist and private IP ranges
function validateUpstreamHostname(hostname: string): { valid: boolean; error?: string } {
  const lowerHost = hostname.toLowerCase()

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.includes(lowerHost)) {
    return { valid: false, error: `blocked hostname: ${hostname}` }
  }

  // Check if it's an IP address (IPv4 or IPv6)
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/
  const ipv6Pattern = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^fe80::/

  if (ipv4Pattern.test(hostname) || ipv6Pattern.test(hostname)) {
    for (const range of PRIVATE_IP_RANGES) {
      if (range.test(hostname)) {
        return { valid: false, error: `private IP range blocked: ${hostname}` }
      }
    }
  }

  // Basic hostname validation (RFC 1123)
  const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
  if (!hostnamePattern.test(hostname)) {
    return { valid: false, error: `invalid hostname format: ${hostname}` }
  }

  return { valid: true }
}

// Extract upstream URL from path param and query string
function buildUpstreamUrl(upstreamPath: string, query: Record<string, string | undefined>): string {
  // upstreamPath is the path part after /v1/proxy/passthrough/
  // e.g., if request is to /v1/proxy/passthrough/api.openai.com/v1/chat/completions?model=gpt-4o
  // then upstreamPath = "api.openai.com/v1/chat/completions"
  // We need to reconstruct: https://api.openai.com/v1/chat/completions?model=gpt-4o

  const [hostname, ...pathParts] = upstreamPath.split('/')
  const path = pathParts.length > 0 ? '/' + pathParts.join('/') : '/'

  // Build query string from request query params
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      searchParams.set(key, value)
    }
  }
  const queryString = searchParams.toString()

  return `https://${hostname}${path}${queryString ? '?' + queryString : ''}`
}

// Determine upstream host from URL for trace metadata
function extractUpstreamHost(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname
  } catch {
    return 'unknown'
  }
}

// Detect model from request body for common formats
function detectModelFromBody(body: unknown, upstreamHost: string): string {
  if (!body || typeof body !== 'object') return 'unknown'

  const b = body as Record<string, unknown>

  // OpenAI/OpenAI-compatible format
  if (typeof b.model === 'string') return b.model

  // Anthropic format
  if (typeof b.model === 'string') return b.model

  // Google Gemini format: models/{model}:generateContent
  if (upstreamHost.includes('generativelanguage.googleapis.com')) {
    // Model is typically in the URL path, not body
    return 'gemini'
  }

  // Cohere format
  if (typeof b.model === 'string') return b.model

  // Mistral format
  if (typeof b.model === 'string') return b.model

  return 'unknown'
}

// Headers to pass through to upstream (case-insensitive)
const PASSTHROUGH_HEADERS = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
  'x-azure-resource',
  'x-azure-deployment',
  'x-azure-api-version',
  'anthropic-version',
  'content-type'
])

// Headers that should never be logged in traces
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie'
])

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

// OTLP/HTTP JSON ingestion endpoint
const MAX_OTLP_PAYLOAD_SIZE = 10 * 1024 * 1024

app.post('/v1/traces', async (c) => {
  const contentLength = c.req.header('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_OTLP_PAYLOAD_SIZE) {
    return c.json({ error: 'payload too large', maxSize: MAX_OTLP_PAYLOAD_SIZE }, 413)
  }

  const body = await c.req.json().catch(() => null)
  if (body === null) {
    return c.json({ error: 'invalid JSON body' }, 400)
  }

  const result = parseOtlpTracesRequest(body)
  if (!result.success) {
    return c.json({ error: 'invalid OTLP payload', details: result.error.issues }, 400)
  }

  const traceIds: string[] = []
  for (const trace of result.traces) {
    const id = store.add(trace)
    traceIds.push(id)
  }

  return c.json({ traceIds, count: traceIds.length }, 202)
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
    .catch(undefined),
  // Expression filter DSL (e.g., 'status:error AND duration_ms>1000')
  filter: z.string().max(2000).optional().catch(undefined)
})

function validatePaginationParams(query: Record<string, string | undefined>): { error: string } | null {
  const rawLimit = query.limit
  const rawOffset = query.offset

  if (rawLimit !== undefined) {
    const limitNum = Number(rawLimit)
    if (Number.isNaN(limitNum)) {
      return { error: 'limit must be a number' }
    }
    if (!Number.isInteger(limitNum)) {
      return { error: 'limit must be an integer' }
    }
    if (limitNum <= 0) {
      return { error: 'limit must be a positive integer (minimum 1)' }
    }
    if (limitNum > MAX_TRACE_LIST_LIMIT) {
      return { error: `limit must not exceed ${MAX_TRACE_LIST_LIMIT}` }
    }
  }

  if (rawOffset !== undefined) {
    const offsetNum = Number(rawOffset)
    if (Number.isNaN(offsetNum)) {
      return { error: 'offset must be a number' }
    }
    if (!Number.isInteger(offsetNum)) {
      return { error: 'offset must be an integer' }
    }
    if (offsetNum < 0) {
      return { error: 'offset must be a non-negative integer' }
    }
  }

  return null
}

app.get('/api/traces', (c) => {
  const query = c.req.query()
  const validationError = validatePaginationParams(query)
  if (validationError) {
    return c.json({ error: validationError.error }, 400)
  }

  const parsed = listQuerySchema.parse(query)
  const page = parsed.page ?? 1
  const limit = parsed.limit ?? DEFAULT_TRACE_LIST_LIMIT
  const offset = parsed.offset ?? (page - 1) * limit

  // Parse filter expression if provided
  let filterAst: FilterExpr | undefined
  if (parsed.filter) {
    console.log("DEBUG: parsed.filter =", JSON.stringify(parsed.filter));
    const parseResult = parseFilterExpression(parsed.filter)
    if (parseResult.errors.length > 0) {
      return c.json({ error: 'invalid filter expression', details: parseResult.errors }, 400)
    }
    filterAst = parseResult.ast ?? undefined
  }

  const listOptions: {
    limit: number
    offset: number
    status?: TraceStatus
    sessionId?: string
    userId?: string
    serviceName?: string
    operationName?: string
    startTimeGte?: string
    startTimeLte?: string
    sort?: string
    filterAst?: FilterExpr
  } = {
    limit,
    offset,
    status: parsed.status,
    sessionId: parsed.sessionId,
    userId: parsed.userId,
    serviceName: parsed.serviceName,
    operationName: parsed.operationName,
    startTimeGte: parsed.startTimeGte,
    startTimeLte: parsed.startTimeLte,
    sort: parsed.sort,
    filterAst
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
          totalTokens: promptTokens + completionTokens,
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

// Anthropic chat completions proxy
app.post('/v1/proxy/anthropic/messages', async (c) => {
  const apiKey = c.req.header('x-api-key') || c.req.header('authorization')?.replace('Bearer ', '')
  if (!apiKey) {
    return c.json({ error: 'missing or invalid x-api-key header' }, 401)
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
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION
    },
    body: JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(ANTHROPIC_URL, requestInit)
  } catch (err) {
    const endTime = new Date().toISOString()
    const errorTrace: Trace = {
      name: 'proxy-anthropic-messages',
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
            'proxy.upstream': 'anthropic'
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
      input_tokens?: number
      output_tokens?: number
    }
  }

  const model = typeof responseBody.model === 'string' ? responseBody.model : 'unknown'
  const inputTokens = typeof responseBody.usage?.input_tokens === 'number' ? responseBody.usage.input_tokens : 0
  const outputTokens = typeof responseBody.usage?.output_tokens === 'number' ? responseBody.usage.output_tokens : 0

  const totalCostCents = pricingEngine.calculateCostCents(inputTokens, outputTokens, model)
  const totalCost = totalCostCents / 100

  const trace: Trace = {
    name: 'proxy-anthropic-messages',
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
          'proxy.upstream': 'anthropic',
          'http.status': response.status
        },
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
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

// Google Gemini chat completions proxy
app.post('/v1/proxy/gemini/generateContent', async (c) => {
  const apiKey = c.req.header('x-goog-api-key') || c.req.header('authorization')?.replace('Bearer ', '')
  if (!apiKey) {
    return c.json({ error: 'missing or invalid x-goog-api-key header' }, 401)
  }

  const body = await c.req.json().catch(() => null)
  if (body === null) {
    return c.json({ error: 'invalid JSON body' }, 400)
  }

  // Extract model from request body (Google format: models/{model}:generateContent)
  const model = typeof body.model === 'string' ? body.model : 'gemini-1.5-pro'
  const geminiUrl = `${GEMINI_BASE_URL}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`

  const startTime = new Date().toISOString()
  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      contents: body.contents,
      generationConfig: body.generationConfig,
      safetySettings: body.safetySettings
    })
  }

  let response: Response
  try {
    response = await fetch(geminiUrl, requestInit)
  } catch (err) {
    const endTime = new Date().toISOString()
    const errorTrace: Trace = {
      name: 'proxy-gemini-generateContent',
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
            'proxy.upstream': 'google'
          }
        }
      ]
    }
    store.add(errorTrace)
    return c.json({ error: 'upstream request failed' }, 502)
  }

  const endTime = new Date().toISOString()
  const responseBody = (await response.clone().json().catch(() => ({}))) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>
      }
    }>
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      totalTokenCount?: number
    }
    modelVersion?: string
  }

  const modelName = typeof responseBody.modelVersion === 'string' ? responseBody.modelVersion : 'unknown'
  const promptTokens = typeof responseBody.usageMetadata?.promptTokenCount === 'number' ? responseBody.usageMetadata.promptTokenCount : 0
  const completionTokens = typeof responseBody.usageMetadata?.candidatesTokenCount === 'number' ? responseBody.usageMetadata.candidatesTokenCount : 0

  const totalCostCents = pricingEngine.calculateCostCents(promptTokens, completionTokens, modelName)
  const totalCost = totalCostCents / 100

  const trace: Trace = {
    name: 'proxy-gemini-generateContent',
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
          'llm.model': modelName,
          'proxy.upstream': 'google',
          'http.status': response.status
        },
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
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

app.post('/v1/proxy/cohere/v1/chat', async (c) => {
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
    response = await fetch(COHERE_URL, requestInit)
  } catch (err) {
    const endTime = new Date().toISOString()
    const errorTrace: Trace = {
      name: 'proxy-cohere-chat',
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
            'proxy.upstream': 'cohere'
          }
        }
      ]
    }
    store.add(errorTrace)
    return c.json({ error: 'upstream request failed' }, 502)
  }

  const endTime = new Date().toISOString()
  const responseBody = (await response.clone().json().catch(() => ({}))) as {
    text?: string
    generationId?: string
    meta?: {
      tokens?: {
        inputTokens?: number
        outputTokens?: number
      }
    }
    model?: string
  }

  const requestModel = typeof body.model === 'string' ? body.model : undefined
  const responseModel = typeof responseBody.model === 'string' ? responseBody.model : undefined
  const model = response.ok
    ? (responseModel ?? requestModel ?? 'command-r-plus')
    : 'unknown'
  const promptTokens = typeof responseBody.meta?.tokens?.inputTokens === 'number' ? responseBody.meta.tokens.inputTokens : 0
  const completionTokens = typeof responseBody.meta?.tokens?.outputTokens === 'number' ? responseBody.meta.tokens.outputTokens : 0

  const totalCostCents = pricingEngine.calculateCostCents(promptTokens, completionTokens, model)
  const totalCost = totalCostCents / 100

  const trace: Trace = {
    name: 'proxy-cohere-chat',
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
          'proxy.upstream': 'cohere',
          'http.status': response.status
        },
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
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

// Mistral chat completions proxy
app.post('/v1/proxy/mistral/v1/chat/completions', async (c) => {
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
    response = await fetch(MISTRAL_URL, requestInit)
  } catch (err) {
    const endTime = new Date().toISOString()
    const errorTrace: Trace = {
      name: 'proxy-mistral-chat-completions',
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
            'proxy.upstream': 'mistral'
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

  const requestModel = typeof body.model === 'string' ? body.model : undefined
  const responseModel = typeof responseBody.model === 'string' ? responseBody.model : undefined
  const model = response.ok
    ? (responseModel ?? requestModel ?? 'mistral-large-latest')
    : 'unknown'
  const promptTokens = typeof responseBody.usage?.prompt_tokens === 'number' ? responseBody.usage.prompt_tokens : 0
  const completionTokens = typeof responseBody.usage?.completion_tokens === 'number' ? responseBody.usage.completion_tokens : 0

  const totalCostCents = pricingEngine.calculateCostCents(promptTokens, completionTokens, model)
  const totalCost = totalCostCents / 100

  const trace: Trace = {
    name: 'proxy-mistral-chat-completions',
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
          'proxy.upstream': 'mistral',
          'http.status': response.status
        },
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
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

// OpenAI Responses API proxy
app.post('/v1/proxy/responses', async (c) => {
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
    response = await fetch(OPENAI_RESPONSES_URL, requestInit)
  } catch (err) {
    const endTime = new Date().toISOString()
    const errorTrace: Trace = {
      name: 'proxy-openai-responses',
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
            'proxy.upstream': 'openai-responses'
          }
        }
      ]
    }
    store.add(errorTrace)
    return c.json({ error: 'upstream request failed' }, 502)
  }

  const endTime = new Date().toISOString()
  const responseBody = (await response.clone().json().catch(() => ({}))) as {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      reasoning_tokens?: number
      total_tokens?: number
    }
  }

  const isError = !response.ok
  const model = isError ? 'unknown' : (typeof responseBody.model === 'string' ? responseBody.model : 'unknown')
  const responseId = typeof responseBody.id === 'string' ? responseBody.id : undefined
  const inputTokens = typeof responseBody.usage?.input_tokens === 'number' ? responseBody.usage.input_tokens : 0
  const outputTokens = typeof responseBody.usage?.output_tokens === 'number' ? responseBody.usage.output_tokens : 0
  const reasoningTokens = typeof responseBody.usage?.reasoning_tokens === 'number' ? responseBody.usage.reasoning_tokens : 0

  // OpenAI Responses API: total_tokens = input_tokens + output_tokens (reasoning_tokens included in output)
  const totalTokens = typeof responseBody.usage?.total_tokens === 'number'
    ? responseBody.usage.total_tokens
    : inputTokens + outputTokens

  const totalCostCents = pricingEngine.calculateCostCents(inputTokens, outputTokens, model)
  const totalCost = totalCostCents / 100

  const traceAttributes: Record<string, unknown> = {
    'llm.model': model,
    'proxy.upstream': 'openai-responses',
    'http.status': response.status
  }
  if (responseId) {
    traceAttributes['openai.response_id'] = responseId
  }
  if (reasoningTokens > 0) {
    traceAttributes['llm.usage.reasoning_tokens'] = reasoningTokens
  }

  const trace: Trace = {
    name: 'proxy-openai-responses',
    startTime,
    endTime,
    spans: [
      {
        id: crypto.randomUUID(),
        name: 'llm-call',
        startTime,
        endTime,
        status: response.ok ? 'ok' : 'error',
        attributes: traceAttributes,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
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

// Azure OpenAI chat completions proxy
app.post('/v1/proxy/azure/chat/completions', async (c) => {
  const authHeader = c.req.header('authorization')
  const apiKey = c.req.header('api-key')
  const resource = c.req.header('x-azure-resource')
  const deployment = c.req.header('x-azure-deployment')
  const apiVersion = c.req.header('x-azure-api-version') || AZURE_API_VERSION

  if (!authHeader && !apiKey) {
    return c.json({ error: 'missing Authorization or api-key header' }, 401)
  }

  if (!resource || !deployment) {
    return c.json({ error: 'missing x-azure-resource or x-azure-deployment header' }, 400)
  }

  // Validate resource and deployment names to prevent SSRF
  const namePattern = /^[a-zA-Z0-9-]+$/
  if (!namePattern.test(resource) || !namePattern.test(deployment)) {
    return c.json({ error: 'invalid resource or deployment name' }, 400)
  }

  const body = await c.req.json().catch(() => null)
  if (body === null) {
    return c.json({ error: 'invalid JSON body' }, 400)
  }

  // Construct Azure OpenAI endpoint URL
  const azureUrl = `https://${resource}.${AZURE_BASE_HOST}/openai/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`

  const startTime = new Date().toISOString()
  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json'
  }

  if (authHeader) {
    requestHeaders.authorization = authHeader
  } else if (apiKey) {
    requestHeaders['api-key'] = apiKey
  }

  const requestInit: RequestInit = {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(azureUrl, requestInit)
  } catch (err) {
    const endTime = new Date().toISOString()
    const errorTrace: Trace = {
      name: 'proxy-azure-chat-completions',
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
            'proxy.upstream': 'azure-openai'
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

  const requestModel = typeof body.model === 'string' ? body.model : undefined
  const responseModel = typeof responseBody.model === 'string' ? responseBody.model : undefined
  const model = response.ok
    ? (responseModel ?? requestModel ?? 'gpt-4o')
    : 'unknown'
  const promptTokens = typeof responseBody.usage?.prompt_tokens === 'number' ? responseBody.usage.prompt_tokens : 0
  const completionTokens = typeof responseBody.usage?.completion_tokens === 'number' ? responseBody.usage.completion_tokens : 0

  const totalCostCents = pricingEngine.calculateCostCents(promptTokens, completionTokens, model)
  const totalCost = totalCostCents / 100

  const trace: Trace = {
    name: 'proxy-azure-chat-completions',
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
          'proxy.upstream': 'azure-openai',
          'http.status': response.status
        },
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
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

// Generic passthrough proxy route
app.post('/v1/proxy/passthrough/', async (c) => {
  return c.json({ error: 'missing upstream path' }, 400)
})

app.post('/v1/proxy/passthrough/**', async (c) => {
  const fullPath = c.req.path
  const prefix = '/v1/proxy/passthrough/'
  if (!fullPath.startsWith(prefix)) {
    return c.json({ error: 'missing upstream path' }, 400)
  }
  const upstreamPath = fullPath.slice(prefix.length)
  if (!upstreamPath || upstreamPath.trim() === '') {
    return c.json({ error: 'missing upstream path' }, 400)
  }

  // Build upstream URL from path param and query string
  const query = c.req.query()
  const upstreamUrl = buildUpstreamUrl(upstreamPath, query)

  // Validate upstream hostname for SSRF protection
  const hostname = extractUpstreamHost(upstreamUrl)
  const validation = validateUpstreamHostname(hostname)
  if (!validation.valid) {
    return c.json({ error: validation.error }, 403)
  }

  const body = await c.req.json().catch(() => null)
  if (body === null) {
    return c.json({ error: 'invalid JSON body' }, 400)
  }

  // Extract headers to pass through
  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json'
  }

  // Pass through allowed headers (case-insensitive)
  const headers = c.req.raw.headers
  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (PASSTHROUGH_HEADERS.has(lowerKey)) {
      requestHeaders[key] = value
    }
  }

  const startTime = new Date().toISOString()
  const requestInit: RequestInit = {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(upstreamUrl, requestInit)
  } catch (err) {
    const endTime = new Date().toISOString()
    const errorTrace: Trace = {
      name: 'proxy-generic-passthrough',
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
            'proxy.upstream': 'generic-passthrough',
            'proxy.upstream.host': hostname,
            'llm.model': 'unknown'
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
      input_tokens?: number
      output_tokens?: number
    }
    meta?: {
      tokens?: {
        inputTokens?: number
        outputTokens?: number
      }
    }
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      totalTokenCount?: number
    }
    modelVersion?: string
  }

  const isError = !response.ok
  const model = isError ? 'unknown' : detectModelFromBody(body, hostname)
  let promptTokens = 0
  let completionTokens = 0

  // Extract token usage from various provider response formats (only for successful responses)
  if (!isError && responseBody.usage) {
    // OpenAI/OpenAI-compatible format (prompt_tokens, completion_tokens)
    if (typeof responseBody.usage.prompt_tokens === 'number' || typeof responseBody.usage.completion_tokens === 'number') {
      promptTokens = typeof responseBody.usage.prompt_tokens === 'number' ? responseBody.usage.prompt_tokens : 0
      completionTokens = typeof responseBody.usage.completion_tokens === 'number' ? responseBody.usage.completion_tokens : 0
    }
    // Anthropic format (input_tokens, output_tokens)
    else if (typeof responseBody.usage.input_tokens === 'number' || typeof responseBody.usage.output_tokens === 'number') {
      promptTokens = typeof responseBody.usage.input_tokens === 'number' ? responseBody.usage.input_tokens : 0
      completionTokens = typeof responseBody.usage.output_tokens === 'number' ? responseBody.usage.output_tokens : 0
    }
  } else if (!isError && responseBody.meta?.tokens) {
    // Cohere format
    promptTokens = typeof responseBody.meta.tokens.inputTokens === 'number' ? responseBody.meta.tokens.inputTokens : 0
    completionTokens = typeof responseBody.meta.tokens.outputTokens === 'number' ? responseBody.meta.tokens.outputTokens : 0
  } else if (!isError && responseBody.usageMetadata) {
    // Google Gemini format
    promptTokens = typeof responseBody.usageMetadata.promptTokenCount === 'number' ? responseBody.usageMetadata.promptTokenCount : 0
    completionTokens = typeof responseBody.usageMetadata.candidatesTokenCount === 'number' ? responseBody.usageMetadata.candidatesTokenCount : 0
  }

  // Calculate cost using pricing engine (falls back to default rates for unknown models)
  const totalCostCents = pricingEngine.calculateCostCents(promptTokens, completionTokens, model)
  const totalCost = totalCostCents / 100

  // Build trace attributes (excluding sensitive headers)
  const traceAttributes: Record<string, unknown> = {
    'llm.model': model,
    'proxy.upstream': 'generic-passthrough',
    'proxy.upstream.host': hostname,
    'http.status': response.status
  }

  const trace: Trace = {
    name: 'proxy-generic-passthrough',
    startTime,
    endTime,
    spans: [
      {
        id: crypto.randomUUID(),
        name: 'llm-call',
        startTime,
        endTime,
        status: response.ok ? 'ok' : 'error',
        attributes: traceAttributes,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
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
