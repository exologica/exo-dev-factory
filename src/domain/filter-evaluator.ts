/**
 * Expression Filter DSL Evaluator
 *
 * Evaluates a parsed filter AST against trace objects.
 * Supports field access on trace and span properties.
 */

import type { Trace, Span } from './trace.js'
import type { FilterExpr, FilterValue, ComparisonOp } from './filter-parser.js'

export interface EvalContext {
  trace: Trace
  // Computed fields available for filtering
  duration_ms: number
  span: Span | null // First span for top-level span fields
}

export interface EvaluationResult {
  matches: boolean
  error?: string
}

// Field accessors for trace properties
const TRACE_FIELD_GETTERS: Record<string, (ctx: EvalContext) => FilterValue> = {
  status: (ctx) => ctx.trace.spans.some((s) => s.status === 'error') ? 'error' : 'ok',
  name: (ctx) => ctx.trace.name,
  sessionId: (ctx) => ctx.trace.sessionId ?? null,
  userId: (ctx) => ctx.trace.userId ?? null,
  startTime: (ctx) => ctx.trace.startTime,
  endTime: (ctx) => ctx.trace.endTime,
  duration_ms: (ctx) => ctx.duration_ms,
  // Span-level fields (first span)
  'span.name': (ctx) => ctx.span?.name ?? null,
  'span.status': (ctx) => ctx.span?.status ?? null,
  'span.duration_ms': (ctx) => ctx.span ? Date.parse(ctx.span.endTime) - Date.parse(ctx.span.startTime) : null,
  // Usage fields (aggregated across spans)
  'usage.promptTokens': (ctx) => ctx.trace.spans.reduce((sum, s) => sum + (s.usage?.promptTokens ?? 0), 0),
  'usage.completionTokens': (ctx) => ctx.trace.spans.reduce((sum, s) => sum + (s.usage?.completionTokens ?? 0), 0),
  'usage.totalCost': (ctx) => ctx.trace.spans.reduce((sum, s) => sum + (s.usage?.totalCost ?? 0), 0)
}

// Span attribute accessors: span.attributes.*
function getSpanAttribute(ctx: EvalContext, attrPath: string): FilterValue {
  if (!ctx.span?.attributes) return null
  // First try exact key match (for keys containing dots like 'llm.model')
  if (attrPath in ctx.span.attributes) {
    return ctx.span.attributes[attrPath] as FilterValue
  }
  // Fall back to nested access
  const keys = attrPath.split('.')
  let current: unknown = ctx.span.attributes
  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return null
    }
  }
  return current as FilterValue
}

// Resolve a field path to a value
function resolveField(ctx: EvalContext, path: string[]): FilterValue {
  const fieldKey = path.join('.')

  // Check direct trace field getters
  const getter = TRACE_FIELD_GETTERS[fieldKey]
  if (getter) {
    return getter(ctx)
  }

  // Check span attributes
  if (path[0] === 'span' && path[1] === 'attributes') {
    return getSpanAttribute(ctx, path.slice(2).join('.'))
  }

  // Check for nested trace properties (e.g., trace.spans[0].name)
  // Not supported in MVP - only top-level and first span
  return null
}

// Compare two values with a comparison operator
function compareValues(left: FilterValue, right: FilterValue, op: ComparisonOp): boolean {
  // Handle null/undefined
  if (left === null || left === undefined) {
    if (op === '==') return right === null || right === undefined
    if (op === '!=') return right !== null && right !== undefined
    return false // null compared with >, <, etc. is always false
  }

  // String comparison for ':' (contains) and '!~' (not contains)
  if (op === ':' || op === '!~') {
    const leftStr = String(left)
    const rightStr = String(right)
    const contains = leftStr.includes(rightStr)
    return op === ':' ? contains : !contains
  }

  // Numeric comparison
  if (typeof left === 'number' && typeof right === 'number') {
    switch (op) {
      case '==': return left === right
      case '!=': return left !== right
      case '>': return left > right
      case '>=': return left >= right
      case '<': return left < right
      case '<=': return left <= right
    }
  }

  // String comparison for == and !=
  if (typeof left === 'string' && typeof right === 'string') {
    switch (op) {
      case '==': return left === right
      case '!=': return left !== right
    }
  }

  // Boolean comparison
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    switch (op) {
      case '==': return left === right
      case '!=': return left !== right
    }
  }

  // Type mismatch for numeric/string ops - return false
  if (['>', '>=', '<', '<='].includes(op)) {
    return false
  }

  // Default: strict equality for ==, inequality for !=
  if (op === '==') return left === right
  if (op === '!=') return left !== right

  return false
}

export function evaluateFilter(ast: FilterExpr, trace: Trace): EvaluationResult {
  const span = trace.spans[0] ?? null
  const duration_ms = Date.parse(trace.endTime) - Date.parse(trace.startTime)

  const ctx: EvalContext = { trace, duration_ms, span }

  try {
    const matches = evaluateNode(ast, ctx)
    return { matches }
  } catch (error) {
    return { matches: false, error: error instanceof Error ? error.message : 'Evaluation error' }
  }
}

function evaluateNode(node: FilterExpr, ctx: EvalContext): boolean {
  if (node.type === 'comparison') {
    const leftValue = resolveField(ctx, node.left.path)
    const rightValue = node.right.value
    return compareValues(leftValue, rightValue, node.op)
  }

  if (node.type === 'not') {
    return !evaluateNode(node.expr, ctx)
  }

  if (node.type === 'logical') {
    const leftResult = evaluateNode(node.left, ctx)
    if (node.op === 'AND') {
      if (!leftResult) return false // Short-circuit
      return evaluateNode(node.right, ctx)
    }
    if (node.op === 'OR') {
      if (leftResult) return true // Short-circuit
      return evaluateNode(node.right, ctx)
    }
  }

  return false
}

// Batch evaluation for performance
export function evaluateFilterBatch(ast: FilterExpr, traces: Trace[]): Trace[] {
  return traces.filter((trace) => evaluateFilter(ast, trace).matches)
}