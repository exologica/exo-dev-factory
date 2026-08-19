/**
 * Expression Filter DSL Parser
 *
 * Grammar (recursive descent, precedence from lowest to highest):
 *
 * expression     := or_expr
 * or_expr        := and_expr ('OR' and_expr)*
 * and_expr       := not_expr ('AND' not_expr)*
 * not_expr       := 'NOT'? primary
 * primary        := '(' expression ')' | comparison
 * comparison     := field_ref comparison_op value
 * field_ref      := identifier ('.' identifier)*
 * comparison_op  := '==' | '!=' | '>' | '>=' | '<' | '<=' | ':' | '!~'
 * value          := string | number | boolean | 'null'
 * identifier     := [a-zA-Z_][a-zA-Z0-9_-]*
 * string         := '"' [^"]* '"' | '\'' [^']* '\''
 * number         := [0-9]+ ('.' [0-9]+)?
 * boolean        := 'true' | 'false'
 *
 * Field references map to trace/span properties:
 * - status, name, sessionId, userId, startTime, endTime
 * - duration_ms (computed from trace)
 * - span fields: span.name, span.status, span.duration_ms, span.attributes.*
 * - usage fields: usage.promptTokens, usage.completionTokens, usage.totalCost
 */

export type FilterValue = string | number | boolean | null

export interface FilterFieldRef {
  type: 'field'
  path: string[]
}

export interface FilterLiteral {
  type: 'literal'
  value: FilterValue
}

export type FilterNode = FilterFieldRef | FilterLiteral

export type ComparisonOp = '==' | '!=' | '>' | '>=' | '<' | '<=' | ':' | '!~'

export interface ComparisonExpr {
  type: 'comparison'
  op: ComparisonOp
  left: FilterFieldRef
  right: FilterLiteral
}

export type LogicalOp = 'AND' | 'OR'

export interface LogicalExpr {
  type: 'logical'
  op: LogicalOp
  left: FilterExpr
  right: FilterExpr
}

export interface NotExpr {
  type: 'not'
  expr: FilterExpr
}

export type FilterExpr = ComparisonExpr | LogicalExpr | NotExpr

export interface ParseResult {
  ast: FilterExpr | null
  errors: string[]
}

const COMPARISON_OPS: ComparisonOp[] = ['==', '!=', '>=', '<=', '>', '<', ':', '!~']
const LOGICAL_OPS: LogicalOp[] = ['AND', 'OR']

class Tokenizer {
  private input: string
  private pos: number = 0
  private tokens: Array<{ type: string; value: string }> = []

  constructor(input: string) {
    this.input = input.trim()
  }

  tokenize(): Array<{ type: string; value: string }> {
    this.tokens = []
    this.pos = 0

    while (this.pos < this.input.length) {
      const char = this.input[this.pos] ?? ''

      // Skip whitespace
      if (/\s/.test(char)) {
        this.pos++
        continue
      }

      // Check for comparison operators (longest first)
      let matched = false
      for (const op of COMPARISON_OPS) {
        if (this.input.startsWith(op, this.pos)) {
          this.tokens.push({ type: 'OP', value: op })
          this.pos += op.length
          matched = true
          break
        }
      }
      if (matched) continue

      // Check for logical operators
      for (const op of LOGICAL_OPS) {
        if (this.input.toUpperCase().startsWith(op, this.pos)) {
          this.tokens.push({ type: 'LOGICAL', value: op.toUpperCase() })
          this.pos += op.length
          matched = true
          break
        }
      }
      if (matched) continue

      // Check for NOT
      if (this.input.toUpperCase().startsWith('NOT', this.pos)) {
        this.tokens.push({ type: 'NOT', value: 'NOT' })
        this.pos += 3
        continue
      }

      // Parentheses
      if (char === '(') {
        this.tokens.push({ type: 'LPAREN', value: '(' })
        this.pos++
        continue
      }
      if (char === ')') {
        this.tokens.push({ type: 'RPAREN', value: ')' })
        this.pos++
        continue
      }

      // Dot for field references
      if (char === '.') {
        this.tokens.push({ type: 'DOT', value: '.' })
        this.pos++
        continue
      }

      // String literals (double or single quoted)
      if (char === '"' || char === "'") {
        const quote = char
        this.pos++
        let value = ''
        while (this.pos < this.input.length && this.input[this.pos] !== quote) {
          value += this.input[this.pos] ?? ''
          this.pos++
        }
        if (this.pos >= this.input.length) {
          throw new Error(`Unterminated string literal at position ${this.pos}`)
        }
        this.pos++ // consume closing quote
        this.tokens.push({ type: 'STRING', value })
        continue
      }

      // Numbers (including negative and float)
      const nextChar = this.input[this.pos + 1] ?? ''
      if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(nextChar))) {
        let value = ''
        if (char === '-') {
          value += '-'
          this.pos++
        }
        while (this.pos < this.input.length) {
          const c = this.input[this.pos] ?? ''
          if (/[0-9.]/.test(c)) {
            value += c
            this.pos++
          } else {
            break
          }
        }
        this.tokens.push({ type: 'NUMBER', value })
        continue
      }

      // Identifiers and keywords (true/false/null) - also allow hyphens in the middle for unquoted string values
      if (/[a-zA-Z_]/.test(char)) {
        let value = ''
        while (this.pos < this.input.length) {
          const c = this.input[this.pos] ?? ''
          if (/[a-zA-Z0-9_]/.test(c)) {
            value += c
            this.pos++
          } else if (c === '-') {
            // Allow hyphens in identifiers (for values like session-123, filter-status-error-)
            // Negative numbers are handled separately and only match when '-' is followed by a digit
            value += c
            this.pos++
          } else {
            break
          }
        }
        const upper = value.toUpperCase()
        if (upper === 'TRUE' || upper === 'FALSE') {
          this.tokens.push({ type: 'BOOLEAN', value: upper })
        } else if (upper === 'NULL') {
          this.tokens.push({ type: 'NULL', value: 'null' })
        } else {
          this.tokens.push({ type: 'IDENT', value })
        }
        continue
      }

      throw new Error(`Unexpected character '${char}' at position ${this.pos}`)
    }

    this.tokens.push({ type: 'EOF', value: '' })
    return this.tokens
  }
}

class Parser {
  private tokens: Array<{ type: string; value: string }>
  private pos: number = 0

  constructor(tokens: Array<{ type: string; value: string }>) {
    this.tokens = tokens
  }

  private peek(): { type: string; value: string } {
    return this.tokens[this.pos] ?? { type: 'EOF', value: '' }
  }

  private consume(expectedType?: string): { type: string; value: string } {
    const token = this.tokens[this.pos] ?? { type: 'EOF', value: '' }
    if (expectedType && token.type !== expectedType) {
      throw new Error(`Expected ${expectedType}, got ${token.type} (${token.value}) at position ${this.pos}`)
    }
    this.pos++
    return token
  }

  parse(): FilterExpr {
    const expr = this.parseOr()
    if (this.peek().type !== 'EOF') {
      throw new Error(`Unexpected token ${this.peek().type} (${this.peek().value}) after expression`)
    }
    return expr
  }

  private parseOr(): FilterExpr {
    let left = this.parseAnd()

    while (this.peek().type === 'LOGICAL' && this.peek().value === 'OR') {
      this.consume('LOGICAL')
      const right = this.parseAnd()
      left = { type: 'logical', op: 'OR', left, right }
    }

    return left
  }

  private parseAnd(): FilterExpr {
    let left = this.parseNot()

    while (this.peek().type === 'LOGICAL' && this.peek().value === 'AND') {
      this.consume('LOGICAL')
      const right = this.parseNot()
      left = { type: 'logical', op: 'AND', left, right }
    }

    return left
  }

  private parseNot(): FilterExpr {
    if (this.peek().type === 'NOT') {
      this.consume('NOT')
      const expr = this.parseNot()
      return { type: 'not', expr }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): FilterExpr {
    const token = this.peek()

    if (token.type === 'LPAREN') {
      this.consume('LPAREN')
      const expr = this.parseOr()
      this.consume('RPAREN')
      return expr
    }

    return this.parseComparison()
  }

  private parseComparison(): FilterExpr {
    // Parse field reference (identifier possibly with dots)
    const fieldParts: string[] = []
    let token = this.consume('IDENT')
    fieldParts.push(token.value)

    while (this.peek().type === 'DOT') {
      this.consume('DOT')
      token = this.consume('IDENT')
      fieldParts.push(token.value)
    }

    // Must have a comparison operator
    const opToken = this.consume('OP')
    if (!COMPARISON_OPS.includes(opToken.value as ComparisonOp)) {
      throw new Error(`Invalid comparison operator: ${opToken.value}`)
    }
    const op = opToken.value as ComparisonOp

    // Parse value
    const valueToken = this.peek()
    let value: FilterValue

    if (valueToken.type === 'STRING') {
      this.consume('STRING')
      value = valueToken.value
    } else if (valueToken.type === 'NUMBER') {
      this.consume('NUMBER')
      value = parseFloat(valueToken.value)
    } else if (valueToken.type === 'BOOLEAN') {
      this.consume('BOOLEAN')
      value = valueToken.value === 'TRUE'
    } else if (valueToken.type === 'NULL') {
      this.consume('NULL')
      value = null
    } else if (valueToken.type === 'IDENT') {
      // Support unquoted string values (e.g., status:error)
      this.consume('IDENT')
      value = valueToken.value
    } else {
      throw new Error(`Expected value after comparison operator, got ${valueToken.type}`)
    }

    return {
      type: 'comparison',
      op,
      left: { type: 'field', path: fieldParts },
      right: { type: 'literal', value }
    }
  }
}

export function parseFilterExpression(input: string): ParseResult {
  try {
    const tokenizer = new Tokenizer(input)
    const tokens = tokenizer.tokenize()
    const parser = new Parser(tokens)
    const ast = parser.parse()
    return { ast, errors: [] }
  } catch (error) {
    return {
      ast: null,
      errors: [error instanceof Error ? error.message : 'Unknown parse error']
    }
  }
}

// Utility to get max depth of AST (for DoS protection)
export function getAstDepth(node: FilterExpr): number {
  if (node.type === 'comparison') return 1
  if (node.type === 'not') return 1 + getAstDepth(node.expr)
  if (node.type === 'logical') return 1 + Math.max(getAstDepth(node.left), getAstDepth(node.right))
  return 1
}

// Utility to count nodes in AST (for DoS protection)
export function countAstNodes(node: FilterExpr): number {
  if (node.type === 'comparison') return 1
  if (node.type === 'not') return 1 + countAstNodes(node.expr)
  if (node.type === 'logical') return 1 + countAstNodes(node.left) + countAstNodes(node.right)
  return 1
}
