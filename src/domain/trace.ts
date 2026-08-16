import { z } from 'zod'

export const spanSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  status: z.enum(['ok', 'error']),
  attributes: z.record(z.string(), z.unknown()).optional()
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

export function spanDurationMs(span: Span): number {
  return Date.parse(span.endTime) - Date.parse(span.startTime)
}

export function traceDurationMs(trace: Trace): number {
  return Date.parse(trace.endTime) - Date.parse(trace.startTime)
}
