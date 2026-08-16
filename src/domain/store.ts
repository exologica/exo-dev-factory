import Database from 'better-sqlite3'
// Global Web Crypto (Node 20+): crypto.randomUUID() — no import needed
import type { Trace, TraceStatus } from './trace.js'
import { traceStatus } from './trace.js'

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
        data         TEXT NOT NULL
      )
    `)
    this.ensureStatusColumn()
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

  add(trace: Trace): string {
    const id = trace.id ?? crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO traces (id, name, startTime, endTime, startEpochMs, status, data)
         VALUES (@id, @name, @startTime, @endTime, @startEpochMs, @status, @data)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           startTime = excluded.startTime,
           endTime = excluded.endTime,
           startEpochMs = excluded.startEpochMs,
           status = excluded.status,
           data = excluded.data`
      )
      .run({
        id,
        name: trace.name,
        startTime: trace.startTime,
        endTime: trace.endTime,
        startEpochMs: Date.parse(trace.startTime),
        status: traceStatus(trace),
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
    const whereClause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    let sql = `SELECT data FROM traces${whereClause} ORDER BY startEpochMs DESC, rowid DESC`
    if (options.limit !== undefined || options.offset !== undefined) {
      // SQLite LIMIT -1 means "no limit", so offset-only paging stays valid.
      sql += ' LIMIT ?'
      params.push(options.limit ?? -1)
      if (options.offset !== undefined) {
        sql += ' OFFSET ?'
        params.push(options.offset)
      }
    }
    const rows = this.db.prepare(sql).all(...params) as Array<{ data: string }>
    return rows.map((row) => JSON.parse(row.data) as Trace)
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
}
