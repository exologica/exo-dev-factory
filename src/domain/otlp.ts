import { z } from 'zod'
import type { Trace, Span } from './trace.js'

// OTLP JSON schemas for validation (subset needed for trace ingestion)
export const otlpAttributeSchema = z.object({
  key: z.string().min(1),
  value: z.object({
    stringValue: z.string().optional(),
    intValue: z.string().optional(), // OTLP sends int64 as string
    doubleValue: z.number().optional(),
    boolValue: z.boolean().optional(),
    arrayValue: z.object({ values: z.array(z.unknown()) }).optional(),
    kvlistValue: z.object({ values: z.array(z.unknown()) }).optional(),
    bytesValue: z.string().optional() // base64 encoded
  })
})

export const otlpEventSchema = z.object({
  timeUnixNano: z.string(),
  name: z.string().min(1),
  attributes: z.array(otlpAttributeSchema).optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional()
})

export const otlpSpanStatusSchema = z.object({
  message: z.string().optional(),
  code: z.number().int().optional() // 0=UNSET, 1=OK, 2=ERROR
}).optional()

// JavaScript's Date is only defined over +/-8.64e15 ms, so the representable
// range for integer Unix nanosecond timestamp strings is +/-8.64e24 ns.
const OTLP_TIMESTAMP_MIN_NANO = -8640000000000000n * 1_000_000n
const OTLP_TIMESTAMP_MAX_NANO = 8640000000000000n * 1_000_000n

/** Integer Unix nanosecond timestamp string within the representable Date range. */
export const otlpNanoTimestampSchema = z.string().refine(
  (value) => {
    // BigInt('') and whitespace-only strings coerce to 0n; reject them explicitly.
    if (value.trim() === '') return false
    let nanos: bigint
    try {
      nanos = BigInt(value)
    } catch {
      return false
    }
    return nanos >= OTLP_TIMESTAMP_MIN_NANO && nanos <= OTLP_TIMESTAMP_MAX_NANO
  },
  { message: 'must be an integer nanosecond timestamp within the representable date range' }
)

export const otlpSpanSchema = z.object({
  traceId: z.string().length(32), // 16 bytes hex
  spanId: z.string().length(16),  // 8 bytes hex
  traceState: z.string().optional(),
  parentSpanId: z.string().length(16).optional(),
  name: z.string().min(1),
  kind: z.number().int().optional(), // SpanKind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER
  startTimeUnixNano: otlpNanoTimestampSchema,
  endTimeUnixNano: otlpNanoTimestampSchema,
  attributes: z.array(otlpAttributeSchema).optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional(),
  events: z.array(otlpEventSchema).optional(),
  status: otlpSpanStatusSchema,
  links: z.array(z.unknown()).optional() // not used for trace ingestion
})

export const otlpScopeSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  attributes: z.array(otlpAttributeSchema).optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional()
}).optional()

export const otlpScopeSpansSchema = z.object({
  scope: otlpScopeSchema,
  spans: z.array(otlpSpanSchema).min(1),
  schemaUrl: z.string().optional()
})

export const otlpResourceSchema = z.object({
  attributes: z.array(otlpAttributeSchema).optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional()
}).optional()

export const otlpResourceSpansSchema = z.object({
  resource: otlpResourceSchema,
  scopeSpans: z.array(otlpScopeSpansSchema).min(1),
  schemaUrl: z.string().optional()
})

export const otlpTracesRequestSchema = z.object({
  resourceSpans: z.array(otlpResourceSpansSchema).min(1)
})

export type OtlpAttribute = z.infer<typeof otlpAttributeSchema>
export type OtlpSpan = z.infer<typeof otlpSpanSchema>
export type OtlpScopeSpans = z.infer<typeof otlpScopeSpansSchema>
export type OtlpResourceSpans = z.infer<typeof otlpResourceSpansSchema>
export type OtlpTracesRequest = z.infer<typeof otlpTracesRequestSchema>

/** Convert OTLP Unix nano timestamp string to ISO 8601 UTC string. */
export function otlpNanoToIso(nano: string): string {
  const nanos = BigInt(nano)
  const millis = Number(nanos / 1_000_000n)
  return new Date(millis).toISOString()
}

/** Extract a single primitive value from OTLP attribute value object. */
export function extractAttributeValue(attr: OtlpAttribute): unknown {
  const v = attr.value
  if (v.stringValue !== undefined) return v.stringValue
  if (v.intValue !== undefined) return BigInt(v.intValue)
  if (v.doubleValue !== undefined) return v.doubleValue
  if (v.boolValue !== undefined) return v.boolValue
  if (v.arrayValue?.values) return v.arrayValue.values
  if (v.kvlistValue?.values) return v.kvlistValue.values
  if (v.bytesValue !== undefined) return v.bytesValue
  return null
}

/** Convert OTLP attributes array to a Record<string, unknown>. */
export function otlpAttributesToRecord(attrs: OtlpAttribute[] | undefined): Record<string, unknown> {
  if (!attrs || attrs.length === 0) return {}
  const out: Record<string, unknown> = {}
  for (const attr of attrs) {
    const value = extractAttributeValue(attr)
    out[attr.key] = typeof value === 'bigint' ? Number(value) : value
  }
  return out
}

/** Map OTLP span status code to internal status. */
function mapOtlpStatus(code: number | undefined): 'ok' | 'error' {
  // OTLP: 0=UNSET, 1=OK, 2=ERROR
  return code === 2 ? 'error' : 'ok'
}

/** Map OTLP span to internal Span. */
export function mapOtlpSpanToSpan(otlpSpan: OtlpSpan, resourceAttrs: Record<string, unknown>, scopeAttrs: Record<string, unknown>): Span {
  const attributes = otlpAttributesToRecord(otlpSpan.attributes)
  
  // Merge resource and scope attributes (span attributes take precedence)
  // Order: resource -> scope -> span (span wins)
  const mergedAttributes: Record<string, unknown> = {
    ...resourceAttrs,
    ...scopeAttrs,
    ...attributes
  }

  // Extract GenAI semantic conventions
  const genAiSystem = mergedAttributes['gen_ai.system'] as string | undefined
  const genAiModel = mergedAttributes['gen_ai.request.model'] as string | undefined
  const genAiPromptTokens = mergedAttributes['gen_ai.usage.prompt_tokens'] as number | bigint | undefined
  const genAiCompletionTokens = mergedAttributes['gen_ai.usage.completion_tokens'] as number | bigint | undefined
  const genAiTotalTokens = mergedAttributes['gen_ai.usage.total_tokens'] as number | bigint | undefined

  // Build usage if GenAI attributes present
  let usage: Span['usage']
  if (genAiPromptTokens !== undefined || genAiCompletionTokens !== undefined) {
    const p = typeof genAiPromptTokens === 'bigint' ? Number(genAiPromptTokens) : (genAiPromptTokens ?? 0)
    const c = typeof genAiCompletionTokens === 'bigint' ? Number(genAiCompletionTokens) : (genAiCompletionTokens ?? 0)
    const t = typeof genAiTotalTokens === 'bigint' ? Number(genAiTotalTokens) : (genAiTotalTokens ?? (p + c))
    usage = {
      promptTokens: p,
      completionTokens: c,
      totalTokens: t,
      totalCost: undefined // Cost calculation happens at proxy level; not derived from OTLP
    }
  }

  // Filter out internal OTLP fields from attributes that shouldn't be in the trace
  const filteredAttributes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(mergedAttributes)) {
    // Skip GenAI usage fields from attributes (they're in usage)
    if (key.startsWith('gen_ai.usage.')) continue
    filteredAttributes[key] = value
  }

  return {
    id: otlpSpan.spanId,
    name: otlpSpan.name,
    startTime: otlpNanoToIso(otlpSpan.startTimeUnixNano),
    endTime: otlpNanoToIso(otlpSpan.endTimeUnixNano),
    status: mapOtlpStatus(otlpSpan.status?.code),
    attributes: Object.keys(filteredAttributes).length > 0 ? filteredAttributes : undefined,
    usage
  }
}

/** Map OTLP ResourceSpans to internal Traces.
 * 
 * OTLP can have multiple ResourceSpans, each with multiple ScopeSpans, each with multiple Spans.
 * We group spans by traceId to create internal Trace objects.
 */
export function mapOtlpToTraces(otlpRequest: OtlpTracesRequest): Trace[] {
  const tracesById = new Map<string, { spans: Span[]; resourceAttrs: Record<string, unknown> }>()

  for (const resourceSpans of otlpRequest.resourceSpans) {
    const resourceAttrs = otlpAttributesToRecord(resourceSpans.resource?.attributes)
    
    for (const scopeSpans of resourceSpans.scopeSpans) {
      const scopeAttrs = otlpAttributesToRecord(scopeSpans.scope?.attributes)
      
      for (const otlpSpan of scopeSpans.spans) {
        const traceId = otlpSpan.traceId
        const existing = tracesById.get(traceId)
        
        const span = mapOtlpSpanToSpan(otlpSpan, resourceAttrs, scopeAttrs)
        
        if (existing) {
          existing.spans.push(span)
        } else {
          tracesById.set(traceId, { spans: [span], resourceAttrs })
        }
      }
    }
  }

  // Convert to Trace objects
  const traces: Trace[] = []
  for (const [traceId, { spans, resourceAttrs }] of tracesById) {
    // Determine trace name from first span or resource attributes
    const serviceName = (resourceAttrs['service.name'] as string) ?? spans[0]?.name ?? 'otlp-trace'
    
    // Sort spans by startTime
    spans.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
    
    const trace: Trace = {
      name: serviceName,
      startTime: spans[0]?.startTime ?? new Date().toISOString(),
      endTime: spans[spans.length - 1]?.endTime ?? new Date().toISOString(),
      spans,
      sessionId: (resourceAttrs['session.id'] as string) ?? undefined,
      userId: (resourceAttrs['user.id'] as string) ?? undefined
    }
    traces.push(trace)
  }

  return traces
}

/** Validate and parse OTLP request body, returning internal Traces. */
export function parseOtlpTracesRequest(body: unknown): { success: true; traces: Trace[] } | { success: false; error: z.ZodError } {
  const parsed = otlpTracesRequestSchema.safeParse(body)
  if (!parsed.success) {
    return { success: false, error: parsed.error }
  }
  const traces = mapOtlpToTraces(parsed.data)
  return { success: true, traces }
}