// Global Web Crypto (Node 20+): crypto.randomUUID() — no import needed
import type { Trace } from './trace.js'

/**
 * In-memory trace store — the seed has no persistence.
 * The bot will propose a durable backend (SQLite, etc.) via a
 * governance-approved change later.
 */
export class TraceStore {
  private readonly traces = new Map<string, Trace>()

  add(trace: Trace): string {
    const id = trace.id ?? crypto.randomUUID()
    this.traces.set(id, { ...trace, id })
    return id
  }

  /** Newest first by startTime. */
  list(): Trace[] {
    return [...this.traces.values()].sort(
      (a, b) => Date.parse(b.startTime) - Date.parse(a.startTime)
    )
  }

  get(id: string): Trace | undefined {
    return this.traces.get(id)
  }

  get size(): number {
    return this.traces.size
  }
}
