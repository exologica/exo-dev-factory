import { z } from 'zod'

export const usageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().max(10_000_000),
    completionTokens: z.number().int().nonnegative().max(10_000_000),
    totalCost: z.number().nonnegative().optional()
  })
  .optional()

export const spanSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  status: z.enum(['ok', 'error']),
  attributes: z.record(z.string(), z.unknown()).optional(),
  usage: usageSchema
})

export const traceSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    startTime: z.string().datetime({ offset: true }),
    endTime: z.string().datetime({ offset: true }),
    spans: z.array(spanSchema).min(1)
  })
  .refine((t) => Date.parse(t.endTime) >= Date.parse(t.startTime), {
    message: 'endTime must be >= startTime',
    path: ['endTime']
  })

export type Span = z.infer<typeof spanSchema>
export type Trace = z.infer<typeof traceSchema>

export type TraceStatus = 'ok' | 'error'

/** A trace is 'error' when any of its spans failed; otherwise 'ok'. */
export function traceStatus(trace: Trace): TraceStatus {
  return trace.spans.some((s) => s.status === 'error') ? 'error' : 'ok'
}

export function spanDurationMs(span: Span): number {
  return Date.parse(span.endTime) - Date.parse(span.startTime)
}

export function traceDurationMs(trace: Trace): number {
  return Date.parse(trace.endTime) - Date.parse(trace.startTime)
}

export function traceTotalPromptTokens(trace: Trace): number {
  return trace.spans.reduce((sum, s) => sum + (s.usage?.promptTokens ?? 0), 0)
}

export function traceTotalCompletionTokens(trace: Trace): number {
  return trace.spans.reduce((sum, s) => sum + (s.usage?.completionTokens ?? 0), 0)
}

export function traceTotalCost(trace: Trace): number {
  return trace.spans.reduce((sum, s) => sum + (s.usage?.totalCost ?? 0), 0)
}

export function traceHasUsage(trace: Trace): boolean {
  return trace.spans.some((s) => s.usage !== undefined)
}

export function spanHasUsage(span: Span): boolean {
  return span.usage !== undefined
}
