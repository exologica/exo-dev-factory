import Database from 'better-sqlite3'
// Global Web Crypto (Node 20+): crypto.randomUUID() — no import needed
import type { Trace } from './trace.js'

export interface TraceStoreOptions {
  /**
   * Path to the SQLite database file. Omit (or pass ':memory:') for a
   * throwaway in-memory database.
   */
  dbPath?: string
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
        data         TEXT NOT NULL
      )
    `)
  }

  add(trace: Trace): string {
    const id = trace.id ?? crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO traces (id, name, startTime, endTime, startEpochMs, data)
         VALUES (@id, @name, @startTime, @endTime, @startEpochMs, @data)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           startTime = excluded.startTime,
           endTime = excluded.endTime,
           startEpochMs = excluded.startEpochMs,
           data = excluded.data`
      )
      .run({
        id,
        name: trace.name,
        startTime: trace.startTime,
        endTime: trace.endTime,
        startEpochMs: Date.parse(trace.startTime),
        data: JSON.stringify({ ...trace, id })
      })
    return id
  }

  /** Newest first by startTime; ties broken by insertion order (newest row first). */
  list(): Trace[] {
    const rows = this.db
      .prepare('SELECT data FROM traces ORDER BY startEpochMs DESC, rowid DESC')
      .all() as Array<{ data: string }>
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

  /** Close the underlying SQLite database. Safe to call once, after which the store is unusable. */
  close(): void {
    this.db.close()
  }
}
