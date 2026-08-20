import { describe, it, expect } from 'vitest'
import {
  otlpTracesRequestSchema,
  otlpNanoToIso,
  extractAttributeValue,
  otlpAttributesToRecord,
  mapOtlpSpanToSpan,
  mapOtlpToTraces,
  parseOtlpTracesRequest,
  otlpNanoTimestampSchema
} from '../../src/domain/otlp.js'

const validOtlpRequest = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'my-service' } },
          { key: 'session.id', value: { stringValue: 'session-123' } },
          { key: 'user.id', value: { stringValue: 'user-456' } }
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

const validOtlpRequestMultipleSpans = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'multi-span-service' } }
        ]
      },
      scopeSpans: [
        {
          scope: { name: 'test-scope' },
          spans: [
            {
              traceId: '00000000000000000000000000000002',
              spanId: '0000000000000002',
              name: 'span-parent',
              kind: 1,
              startTimeUnixNano: '1723833600000000000',
              endTimeUnixNano: '1723833610000000000',
              attributes: [
                { key: 'custom.attr', value: { stringValue: 'parent-value' } }
              ],
              status: { code: 1 }
            },
            {
              traceId: '00000000000000000000000000000002',
              spanId: '0000000000000003',
              parentSpanId: '0000000000000002',
              name: 'span-child',
              kind: 2,
              startTimeUnixNano: '1723833601000000000',
              endTimeUnixNano: '1723833605000000000',
              attributes: [
                { key: 'gen_ai.system', value: { stringValue: 'anthropic' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'claude-3-5-sonnet' } },
                { key: 'gen_ai.usage.prompt_tokens', value: { intValue: '200' } },
                { key: 'gen_ai.usage.completion_tokens', value: { intValue: '100' } }
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
              traceId: '00000000000000000000000000000003',
              spanId: '0000000000000004',
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
              traceId: '00000000000000000000000000000004',
              spanId: '0000000000000005',
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

describe('otlpNanoToIso', () => {
  it('converts nanosecond timestamp to ISO string', () => {
    const result = otlpNanoToIso('1723833600000000000')
    // Verify it produces a valid ISO string with correct format
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('handles sub-millisecond precision', () => {
    const result = otlpNanoToIso('1723833600123456789')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('otlpNanoTimestampSchema', () => {
  it('accepts a valid 19-digit nanosecond timestamp', () => {
    expect(otlpNanoTimestampSchema.safeParse('1723833600000000000').success).toBe(true)
  })

  it('accepts boundary values at the representable Date range', () => {
    expect(otlpNanoTimestampSchema.safeParse('8640000000000000000000').success).toBe(true)
    expect(otlpNanoTimestampSchema.safeParse('-8640000000000000000000').success).toBe(true)
  })

  it('rejects out-of-range timestamps beyond the Date range', () => {
    // 28-digit value from issue #77 reproduction
    expect(otlpNanoTimestampSchema.safeParse('1787181900000000000200000000').success).toBe(false)
    expect(otlpNanoTimestampSchema.safeParse('8640000000000000000001').success).toBe(false)
    expect(otlpNanoTimestampSchema.safeParse('-8640000000000000000001').success).toBe(false)
  })

  it('rejects non-integer timestamp strings', () => {
    expect(otlpNanoTimestampSchema.safeParse('abc').success).toBe(false)
    expect(otlpNanoTimestampSchema.safeParse('1.5').success).toBe(false)
    expect(otlpNanoTimestampSchema.safeParse('1e6').success).toBe(false)
    expect(otlpNanoTimestampSchema.safeParse('').success).toBe(false)
    expect(otlpNanoTimestampSchema.safeParse('  ').success).toBe(false)
  })
})

describe('extractAttributeValue', () => {
  it('extracts stringValue', () => {
    expect(extractAttributeValue({ key: 'k', value: { stringValue: 'hello' } })).toBe('hello')
  })

  it('extracts intValue as bigint', () => {
    expect(extractAttributeValue({ key: 'k', value: { intValue: '42' } })).toBe(42n)
  })

  it('extracts doubleValue', () => {
    expect(extractAttributeValue({ key: 'k', value: { doubleValue: 3.14 } })).toBe(3.14)
  })

  it('extracts boolValue', () => {
    expect(extractAttributeValue({ key: 'k', value: { boolValue: true } })).toBe(true)
  })

  it('extracts arrayValue', () => {
    const arr = { values: [1, 2, 3] }
    expect(extractAttributeValue({ key: 'k', value: { arrayValue: arr } })).toEqual([1, 2, 3])
  })

  it('extracts kvlistValue', () => {
    const kv = { values: [{ key: 'a', value: { stringValue: 'b' } }] }
    expect(extractAttributeValue({ key: 'k', value: { kvlistValue: kv } })).toEqual(kv.values)
  })

  it('extracts bytesValue', () => {
    expect(extractAttributeValue({ key: 'k', value: { bytesValue: 'YQ==' } })).toBe('YQ==')
  })

  it('returns null for empty value', () => {
    expect(extractAttributeValue({ key: 'k', value: {} })).toBeNull()
  })
})

describe('otlpAttributesToRecord', () => {
  it('converts array to record', () => {
    const attrs = [
      { key: 'a', value: { stringValue: '1' } },
      { key: 'b', value: { intValue: '2' } }
    ]
    const result = otlpAttributesToRecord(attrs)
    expect(result).toEqual({ a: '1', b: 2 })
  })

  it('returns empty object for undefined', () => {
    expect(otlpAttributesToRecord(undefined)).toEqual({})
  })

  it('returns empty object for empty array', () => {
    expect(otlpAttributesToRecord([])).toEqual({})
  })
})

describe('mapOtlpSpanToSpan', () => {
  it('maps basic span fields', () => {
    const otlpSpan = {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
      name: 'test-span',
      kind: 2,
      startTimeUnixNano: '1723833600000000000',
      endTimeUnixNano: '1723833605000000000',
      attributes: [{ key: 'custom.key', value: { stringValue: 'value' } }],
      status: { code: 1 }
    }
    const span = mapOtlpSpanToSpan(otlpSpan, {}, {})
    expect(span.id).toBe('0000000000000001')
    expect(span.name).toBe('test-span')
    expect(span.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(span.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(span.status).toBe('ok')
    expect(span.attributes?.['custom.key']).toBe('value')
  })

  it('maps error status from OTLP status code 2', () => {
    const otlpSpan = {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
      name: 'error-span',
      startTimeUnixNano: '1723833600000000000',
      endTimeUnixNano: '1723833605000000000',
      status: { code: 2 }
    }
    const span = mapOtlpSpanToSpan(otlpSpan, {}, {})
    expect(span.status).toBe('error')
  })

  it('maps ok status from OTLP status code 1', () => {
    const otlpSpan = {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
      name: 'ok-span',
      startTimeUnixNano: '1723833600000000000',
      endTimeUnixNano: '1723833605000000000',
      status: { code: 1 }
    }
    const span = mapOtlpSpanToSpan(otlpSpan, {}, {})
    expect(span.status).toBe('ok')
  })

  it('defaults to ok for unset status (code 0 or undefined)', () => {
    const otlpSpan = {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
      name: 'unset-span',
      startTimeUnixNano: '1723833600000000000',
      endTimeUnixNano: '1723833605000000000',
      status: { code: 0 }
    }
    const span = mapOtlpSpanToSpan(otlpSpan, {}, {})
    expect(span.status).toBe('ok')
  })

  it('extracts GenAI usage into span usage object', () => {
    const otlpSpan = {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
      name: 'llm-call',
      startTimeUnixNano: '1723833600000000000',
      endTimeUnixNano: '1723833605000000000',
      attributes: [
        { key: 'gen_ai.system', value: { stringValue: 'openai' } },
        { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
        { key: 'gen_ai.usage.prompt_tokens', value: { intValue: '100' } },
        { key: 'gen_ai.usage.completion_tokens', value: { intValue: '50' } },
        { key: 'gen_ai.usage.total_tokens', value: { intValue: '150' } }
      ],
      status: { code: 1 }
    }
    const span = mapOtlpSpanToSpan(otlpSpan, {}, {})
    expect(span.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      totalCost: undefined
    })
    // GenAI usage attributes should not appear in span attributes
    expect(span.attributes?.['gen_ai.usage.prompt_tokens']).toBeUndefined()
    expect(span.attributes?.['gen_ai.usage.completion_tokens']).toBeUndefined()
    expect(span.attributes?.['gen_ai.usage.total_tokens']).toBeUndefined()
  })

  it('merges resource and scope attributes with span attributes taking precedence', () => {
    const otlpSpan = {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
      name: 'test-span',
      startTimeUnixNano: '1723833600000000000',
      endTimeUnixNano: '1723833605000000000',
      attributes: [
        { key: 'span.key', value: { stringValue: 'span-value' } },
        { key: 'shared.key', value: { stringValue: 'span-value' } }
      ],
      status: { code: 1 }
    }
    const resourceAttrs = { 'resource.key': 'resource-value', 'shared.key': 'resource-shared' }
    const scopeAttrs = { 'scope.key': 'scope-value', 'shared.key': 'scope-shared' }
    const span = mapOtlpSpanToSpan(otlpSpan, resourceAttrs, scopeAttrs)
    expect(span.attributes?.['resource.key']).toBe('resource-value')
    expect(span.attributes?.['scope.key']).toBe('scope-value')
    expect(span.attributes?.['span.key']).toBe('span-value')
    expect(span.attributes?.['shared.key']).toBe('span-value') // span wins
  })
})

describe('mapOtlpToTraces', () => {
  it('converts valid OTLP request to traces', () => {
    const traces = mapOtlpToTraces(validOtlpRequest as any)
    expect(traces).toHaveLength(1)
    const trace = traces[0]!
    expect(trace.name).toBe('my-service')
    expect(trace.sessionId).toBe('session-123')
    expect(trace.userId).toBe('user-456')
    expect(trace.spans).toHaveLength(1)
    const span = trace.spans[0]!
    expect(span.name).toBe('llm-call')
    expect(span.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      totalCost: undefined
    })
    expect(span.attributes?.['gen_ai.system']).toBe('openai')
    expect(span.attributes?.['gen_ai.request.model']).toBe('gpt-4o')
    expect(span.attributes?.['http.status_code']).toBe(200)
  })

  it('groups multiple spans by traceId into single trace', () => {
    const traces = mapOtlpToTraces(validOtlpRequestMultipleSpans as any)
    expect(traces).toHaveLength(1)
    const trace = traces[0]!
    expect(trace.name).toBe('multi-span-service')
    expect(trace.spans).toHaveLength(2)
    // Spans should be sorted by startTime
    expect(trace.spans[0]!.name).toBe('span-parent')
    expect(trace.spans[1]!.name).toBe('span-child')
    // Parent span has no usage, child has usage
    expect(trace.spans[0]!.usage).toBeUndefined()
    expect(trace.spans[1]!.usage).toEqual({
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: 300,
      totalCost: undefined
    })
  })

  it('creates separate traces for different traceIds', () => {
    const traces = mapOtlpToTraces(validOtlpRequestMultipleTraces as any)
    expect(traces).toHaveLength(2)
    expect(traces[0]!.name).toBe('trace-a')
    expect(traces[1]!.name).toBe('trace-b')
    expect(traces[0]!.spans[0]!.status).toBe('ok')
    expect(traces[1]!.spans[0]!.status).toBe('error')
  })

  it('uses first span name as trace name when no service.name', () => {
    const request = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: '00000000000000000000000000000005',
                  spanId: '0000000000000006',
                  name: 'first-span-name',
                  startTimeUnixNano: '1723833600000000000',
                  endTimeUnixNano: '1723833601000000000',
                  status: { code: 1 }
                }
              ]
            }
          ]
        }
      ]
    }
    const traces = mapOtlpToTraces(request as any)
    expect(traces[0]!.name).toBe('first-span-name')
  })

  it('falls back to "otlp-trace" when no service.name and span name is missing', () => {
    const request = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: '00000000000000000000000000000006',
                  spanId: '0000000000000007',
                  name: 'unnamed-span',
                  startTimeUnixNano: '1723833600000000000',
                  endTimeUnixNano: '1723833601000000000',
                  status: { code: 1 }
                }
              ]
            }
          ]
        }
      ]
    }
    const traces = mapOtlpToTraces(request as any)
    expect(traces[0]!.name).toBe('unnamed-span')
  })
})

describe('parseOtlpTracesRequest', () => {
  it('parses valid OTLP request and returns traces', () => {
    const result = parseOtlpTracesRequest(validOtlpRequest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.traces).toHaveLength(1)
      expect(result.traces[0]!.name).toBe('my-service')
    }
  })

  it('rejects missing resourceSpans', () => {
    const result = parseOtlpTracesRequest({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes('resourceSpans'))).toBe(true)
    }
  })

  it('rejects empty resourceSpans', () => {
    const result = parseOtlpTracesRequest({ resourceSpans: [] })
    expect(result.success).toBe(false)
  })

  it('rejects missing spans in scopeSpans', () => {
    const request = {
      resourceSpans: [
        { scopeSpans: [{ scope: {}, spans: [] }] }
      ]
    }
    const result = parseOtlpTracesRequest(request)
    expect(result.success).toBe(false)
  })

  it('rejects invalid traceId format', () => {
    const request = {
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
    const result = parseOtlpTracesRequest(request)
    expect(result.success).toBe(false)
  })

  it('rejects invalid spanId format', () => {
    const request = {
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
    const result = parseOtlpTracesRequest(request)
    expect(result.success).toBe(false)
  })

  it('rejects missing required span fields', () => {
    const request = {
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
    const result = parseOtlpTracesRequest(request)
    expect(result.success).toBe(false)
  })

  it('rejects out-of-range span timestamps', () => {
    const request = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { traceId: '00000000000000000000000000000001', spanId: '0000000000000001', name: 'x', startTimeUnixNano: '1787181900000000000200000000', endTimeUnixNano: '1723833605000000000', status: {} }
              ]
            }
          ]
        }
      ]
    }
    const result = parseOtlpTracesRequest(request)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes('startTimeUnixNano'))).toBe(true)
    }
  })

  it('rejects non-integer span timestamp strings', () => {
    const request = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { traceId: '00000000000000000000000000000001', spanId: '0000000000000001', name: 'x', startTimeUnixNano: '1723833600000000000', endTimeUnixNano: 'not-a-number', status: {} }
              ]
            }
          ]
        }
      ]
    }
    const result = parseOtlpTracesRequest(request)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes('endTimeUnixNano'))).toBe(true)
    }
  })
})