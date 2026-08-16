import Database from 'better-sqlite3'
// Global Web Crypto (Node 20+): crypto.randomUUID() — no import needed
import type { Trace, TraceStatus } from './trace.js'
import { traceStatus, traceTotalPromptTokens, traceTotalCompletionTokens } from './trace.js'
import { pricingEngine } from './pricing.js'

export interface TraceStoreOptions {
  /**
   * Path to the SQLite database file. Omit (or pass ':memory:') for a
   * throwaway in-memory database.
   */
  dbPath?: string
}

export interface TraceListOptions {
  /** Maximum number of traces to return (newest-first). Omit for no limit. */
  limit?: number
  /** Number of traces to skip before returning results (for paging). */
  offset?: number
  /** Only return traces whose derived status matches. */
  status?: TraceStatus
  /** Only return traces with this sessionId. */
  sessionId?: string
  /** Only return traces with this userId. */
  userId?: string
  /** Filter by trace name (service name). */
  serviceName?: string
  /** Filter by operation name (first span name). */
  operationName?: string
  /** Filter by startTime >= this value (ISO 8601). */
  startTimeGte?: string
  /** Filter by startTime <= this value (ISO 8601). */
  startTimeLte?: string
  /** Sort field and direction: 'startTime:asc' | 'startTime:desc' | 'durationMs:asc' | 'durationMs:desc' | 'name:asc' | 'name:desc' */
  sort?: string
}

/**
 * Durable trace store backed by SQLite (better-sqlite3).
 *
 * The schema is initialized idempotently on construction and every read and
 * write uses strictly parameterized queries — user data is never interpolated
 * into SQL. The full trace payload is persisted as JSON so list/get return
 * objects equivalent to what was ingested.
 */
export class TraceStore {
  private readonly db: Database.Database

  constructor(options: TraceStoreOptions = {}) {
    this.db = new Database(options.dbPath ?? ':memory:')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        startTime    TEXT NOT NULL,
        endTime      TEXT NOT NULL,
        startEpochMs INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'ok',
        sessionId    TEXT,
        userId       TEXT,
        data         TEXT NOT NULL
      )
    `)
    this.ensureStatusColumn()
    this.ensureSessionColumns()
  }

  /**
   * Idempotent migration: adds the derived `status` column to databases that
   * were created before pagination/filtering support and backfills it from the
   * persisted span payloads.
   */
  private ensureStatusColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(traces)').all() as Array<{ name: string }>
    if (columns.some((c) => c.name === 'status')) return
    this.db.exec("ALTER TABLE traces ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'")
    const rows = this.db.prepare('SELECT id, data FROM traces').all() as Array<{ id: string; data: string }>
    const update = this.db.prepare('UPDATE traces SET status = ? WHERE id = ?')
    for (const row of rows) {
      update.run(traceStatus(JSON.parse(row.data) as Trace), row.id)
    }
  }

  /**
   * Idempotent migration: adds sessionId and userId columns for session
   * grouping. Creates indexes to support efficient filtering.
   */
  private ensureSessionColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(traces)').all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === 'sessionId')) {
      this.db.exec('ALTER TABLE traces ADD COLUMN sessionId TEXT')
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_traces_sessionId ON traces(sessionId)')
    }
    if (!columns.some((c) => c.name === 'userId')) {
      this.db.exec('ALTER TABLE traces ADD COLUMN userId TEXT')
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_traces_userId ON traces(userId)')
    }
  }

  add(trace: Trace): string {
    const id = trace.id ?? crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO traces (id, name, startTime, endTime, startEpochMs, status, sessionId, userId, data)
         VALUES (@id, @name, @startTime, @endTime, @startEpochMs, @status, @sessionId, @userId, @data)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           startTime = excluded.startTime,
           endTime = excluded.endTime,
           startEpochMs = excluded.startEpochMs,
           status = excluded.status,
           sessionId = excluded.sessionId,
           userId = excluded.userId,
           data = excluded.data`
      )
      .run({
        id,
        name: trace.name,
        startTime: trace.startTime,
        endTime: trace.endTime,
        startEpochMs: Date.parse(trace.startTime),
        status: traceStatus(trace),
        sessionId: trace.sessionId ?? null,
        userId: trace.userId ?? null,
        data: JSON.stringify({ ...trace, id })
      })
    return id
  }

  /**
   * Newest first by startTime; ties broken by insertion order (newest row first).
   * Supports bounded paging (limit/offset) and filtering by derived trace
   * status. All values are bound as parameters — user input is never
   * interpolated into SQL.
   */
  list(options: TraceListOptions = {}): Trace[] {
    const params: Array<string | number> = []
    const where: string[] = []
    if (options.status !== undefined) {
      where.push('status = ?')
      params.push(options.status)
    }
    if (options.sessionId !== undefined) {
      where.push('sessionId = ?')
      params.push(options.sessionId)
    }
    if (options.userId !== undefined) {
      where.push('userId = ?')
      params.push(options.userId)
    }
    if (options.serviceName !== undefined) {
      where.push('name = ?')
      params.push(options.serviceName)
    }
    if (options.operationName !== undefined) {
      where.push('EXISTS (SELECT 1 FROM json_each(data, \'$.spans\') WHERE json_extract(value, \'$.name\') = ?)')
      params.push(options.operationName)
    }
    if (options.startTimeGte !== undefined) {
      where.push('startTime >= ?')
      params.push(options.startTimeGte)
    }
    if (options.startTimeLte !== undefined) {
      where.push('startTime <= ?')
      params.push(options.startTimeLte)
    }

    const whereClause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

    let orderBy = 'startEpochMs DESC, rowid DESC'
    const needsInMemorySort = options.sort === 'durationMs:asc' || options.sort === 'durationMs:desc'
    if (options.sort !== undefined && !needsInMemorySort) {
      const parts = options.sort.split(':')
      const field = parts[0]
      const direction = parts[1]
      const validFields = ['startTime', 'name']
      const validDirections = ['asc', 'desc']
      if (field && direction && validFields.includes(field) && validDirections.includes(direction)) {
        const col = field === 'startTime' ? 'startEpochMs' : field
        orderBy = `${col} ${direction.toUpperCase()}, rowid DESC`
      }
    }

    let sql = `SELECT data FROM traces${whereClause} ORDER BY ${orderBy}`
    if (options.limit !== undefined || options.offset !== undefined) {
      sql += ' LIMIT ?'
      params.push(options.limit ?? -1)
      if (options.offset !== undefined) {
        sql += ' OFFSET ?'
        params.push(options.offset)
      }
    }
    const rows = this.db.prepare(sql).all(...params) as Array<{ data: string }>
    let traces = rows.map((row) => JSON.parse(row.data) as Trace)

    if (needsInMemorySort) {
      const direction = options.sort!.split(':')[1]
      traces.sort((a, b) => {
        const aDur = a.spans[0] ? Date.parse(a.spans[0].endTime) - Date.parse(a.spans[0].startTime) : 0
        const bDur = b.spans[0] ? Date.parse(b.spans[0].endTime) - Date.parse(b.spans[0].startTime) : 0
        return direction === 'asc' ? aDur - bDur : bDur - aDur
      })
    }

    return traces
  }

  count(options: TraceListOptions = {}): number {
    const params: Array<string | number> = []
    const where: string[] = []
    if (options.status !== undefined) {
      where.push('status = ?')
      params.push(options.status)
    }
    if (options.sessionId !== undefined) {
      where.push('sessionId = ?')
      params.push(options.sessionId)
    }
    if (options.userId !== undefined) {
      where.push('userId = ?')
      params.push(options.userId)
    }
    if (options.serviceName !== undefined) {
      where.push('name = ?')
      params.push(options.serviceName)
    }
    if (options.operationName !== undefined) {
      where.push('EXISTS (SELECT 1 FROM json_each(data, \'$.spans\') WHERE json_extract(value, \'$.name\') = ?)')
      params.push(options.operationName)
    }
    if (options.startTimeGte !== undefined) {
      where.push('startTime >= ?')
      params.push(options.startTimeGte)
    }
    if (options.startTimeLte !== undefined) {
      where.push('startTime <= ?')
      params.push(options.startTimeLte)
    }

    const whereClause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    const sql = `SELECT COUNT(*) AS n FROM traces${whereClause}`
    const row = this.db.prepare(sql).all(...params) as Array<{ n: number }>
    return row[0]?.n ?? 0
  }

  get(id: string): Trace | undefined {
    const row = this.db.prepare('SELECT data FROM traces WHERE id = ?').get(id) as
      | { data: string }
      | undefined
    return row === undefined ? undefined : (JSON.parse(row.data) as Trace)
  }

  get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM traces').get() as { n: number }
    return row.n
  }

  /**
   * Permanently removes a trace by id. Returns true when a trace was deleted,
   * false when no trace with that id existed.
   */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM traces WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** Close the underlying SQLite database. Safe to call once, after which the store is unusable. */
  close(): void {
    this.db.close()
  }

  /**
   * Calculate aggregated cost for a single trace by id.
   * Returns cost in cents (integer) and dollars (float), plus token breakdown.
   */
  getTraceCost(id: string): { traceId: string; promptTokens: number; completionTokens: number; totalCostCents: number; totalCostDollars: number } | undefined {
    const trace = this.get(id)
    if (!trace) return undefined

    let promptTokens = 0
    let completionTokens = 0
    let totalCostCents = 0

    for (const span of trace.spans) {
      if (span.usage) {
        promptTokens += span.usage.promptTokens ?? 0
        completionTokens += span.usage.completionTokens ?? 0
        // Use model from span attributes if available, otherwise default
        const model = (span.attributes?.['llm.model'] as string) ?? 'gpt-4o'
        totalCostCents += pricingEngine.calculateCostCents(span.usage.promptTokens ?? 0, span.usage.completionTokens ?? 0, model)
      }
    }

    return {
      traceId: id,
      promptTokens,
      completionTokens,
      totalCostCents,
      totalCostDollars: totalCostCents / 100
    }
  }

  /**
   * Calculate aggregated cost for all traces in a session.
   * Returns cost in cents (integer) and dollars (float), plus token breakdown and trace count.
   */
  getSessionCost(sessionId: string): { sessionId: string; traceCount: number; promptTokens: number; completionTokens: number; totalCostCents: number; totalCostDollars: number } {
    const traces = this.list({ sessionId })
    let promptTokens = 0
    let completionTokens = 0
    let totalCostCents = 0

    for (const trace of traces) {
      for (const span of trace.spans) {
        if (span.usage) {
          promptTokens += span.usage.promptTokens ?? 0
          completionTokens += span.usage.completionTokens ?? 0
          const model = (span.attributes?.['llm.model'] as string) ?? 'gpt-4o'
          totalCostCents += pricingEngine.calculateCostCents(span.usage.promptTokens ?? 0, span.usage.completionTokens ?? 0, model)
        }
      }
    }

    return {
      sessionId,
      traceCount: traces.length,
      promptTokens,
      completionTokens,
      totalCostCents,
      totalCostDollars: totalCostCents / 100
    }
  }

  /**
   * Calculate time-windowed cost aggregation across all traces.
   * Window is specified in hours (e.g., 24 for last 24 hours).
   * Returns cost in cents (integer) and dollars (float), plus token breakdown and trace count.
   */
  getTimeWindowCost(windowHours: number): { windowHours: number; traceCount: number; promptTokens: number; completionTokens: number; totalCostCents: number; totalCostDollars: number } {
    const now = new Date()
    const cutoff = new Date(now.getTime() - windowHours * 60 * 60 * 1000)
    const cutoffIso = cutoff.toISOString()

    const traces = this.list({ startTimeGte: cutoffIso })
    let promptTokens = 0
    let completionTokens = 0
    let totalCostCents = 0

    for (const trace of traces) {
      for (const span of trace.spans) {
        if (span.usage) {
          promptTokens += span.usage.promptTokens ?? 0
          completionTokens += span.usage.completionTokens ?? 0
          const model = (span.attributes?.['llm.model'] as string) ?? 'gpt-4o'
          totalCostCents += pricingEngine.calculateCostCents(span.usage.promptTokens ?? 0, span.usage.completionTokens ?? 0, model)
        }
      }
    }

    return {
      windowHours,
      traceCount: traces.length,
      promptTokens,
      completionTokens,
      totalCostCents,
      totalCostDollars: totalCostCents / 100
    }
  }
}