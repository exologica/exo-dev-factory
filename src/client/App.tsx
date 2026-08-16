import { useCallback, useEffect, useState } from 'react'
import type { Span, Trace } from '../domain/trace'
import {
  spanDurationMs,
  traceDurationMs,
  traceTotalPromptTokens,
  traceTotalCompletionTokens,
  traceTotalCost,
  traceHasUsage,
  spanHasUsage
} from '../domain/trace'

const fmtMs = (ms: number) => `${ms}ms`
const PAGE_SIZE = 10

function TraceRow({
  trace,
  active,
  onSelect,
  onDelete
}: {
  trace: Trace
  active: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const hasUsage = traceHasUsage(trace)
  const totalPrompt = traceTotalPromptTokens(trace)
  const totalCompletion = traceTotalCompletionTokens(trace)
  const totalCost = traceTotalCost(trace)

  return (
    <div className={active ? 'row active' : 'row'}>
      <button
        type="button"
        className="row-main"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
      >
        <span className="name">{trace.name}</span>
        <span className="meta">
          {trace.spans.length} span{trace.spans.length === 1 ? '' : 's'} · {fmtMs(traceDurationMs(trace))}
          {hasUsage && (
            <>
              {' · '}
              <span className="usage">{totalPrompt + totalCompletion} tokens</span>
              {totalCost > 0 && <span className="cost">${totalCost.toFixed(4)}</span>}
            </>
          )}
        </span>
      </button>
      <button
        type="button"
        className="row-delete"
        aria-label={`Delete ${trace.name}`}
        title="Delete trace"
        onClick={onDelete}
      >
        ✕
      </button>
    </div>
  )
}

function SpanRow({ span }: { span: Span }) {
  const hasUsage = spanHasUsage(span)

  return (
    <li className={span.status === 'error' ? 'span error' : 'span'}>
      <span className="name">{span.name}</span>
      <span className="meta">
        {span.status} · {fmtMs(spanDurationMs(span))}
        {hasUsage && (
          <>
            {' · '}
            <span className="usage">
              {span.usage!.promptTokens} → {span.usage!.completionTokens} tokens
            </span>
            {span.usage!.totalCost !== undefined && span.usage!.totalCost > 0 && (
              <span className="cost">${span.usage!.totalCost.toFixed(4)}</span>
            )}
          </>
        )}
      </span>
    </li>
  )
}

export default function App() {
  const [traces, setTraces] = useState<Trace[]>([])
  const [selected, setSelected] = useState<Trace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'error'>('all')

  useEffect(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
    if (statusFilter !== 'all') params.set('status', statusFilter)
    setLoading(true)
    fetch(`/api/traces?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<Trace[]>
      })
      .then(setTraces)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'failed to load traces'))
      .finally(() => setLoading(false))
  }, [page, statusFilter])

  const selectTrace = useCallback(async (id: string) => {
    const r = await fetch(`/api/traces/${id}`)
    if (!r.ok) return
    setSelected(await (r.json() as Promise<Trace>))
  }, [])

  const deleteTrace = useCallback(async (trace: Trace) => {
    const r = await fetch(`/api/traces/${trace.id}`, { method: 'DELETE' })
    // 204 (deleted) and 404 (already gone) both mean the trace should leave
    // the list; any other status leaves the list untouched.
    if (r.status !== 204 && r.status !== 404) return
    const remaining = traces.filter((t) => t.id !== trace.id)
    setTraces(remaining)
    setSelected((sel) => (sel?.id === trace.id ? null : sel))
    // Stepping back keeps the visible page populated after removing its last trace.
    if (remaining.length === 0 && page > 0) setPage((p) => p - 1)
  }, [page, traces])

  const applyStatus = (status: 'all' | 'ok' | 'error') => {
    setStatusFilter(status)
    setPage(0)
  }

  const hasNext = traces.length === PAGE_SIZE
  const hasPrev = page > 0

  return (
    <main>
      <header>
        <h1>exo-dev-factory</h1>
        <p className="subtitle">LLM trace observability</p>
      </header>

      {error && <div className="error">{error}</div>}

      <section className="layout">
        <aside className="list">
          <h2>Traces</h2>
          <div className="filters" role="group" aria-label="Filter traces">
            {(['all', 'ok', 'error'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={statusFilter === s ? 'filter active' : 'filter'}
                aria-pressed={statusFilter === s}
                onClick={() => applyStatus(s)}
              >
                {s === 'all' ? 'All' : s === 'ok' ? 'OK' : 'Errors'}
              </button>
            ))}
          </div>
          {loading && <p className="muted">Loading…</p>}
          {!loading && traces.length === 0 && (
            <p className="muted">
              {statusFilter === 'all'
                ? 'No traces yet. POST one to /api/traces.'
                : 'No traces match this filter.'}
            </p>
          )}
          {traces.map((t) => (
            <TraceRow
              key={t.id}
              trace={t}
              active={selected?.id === t.id}
              onSelect={() => void selectTrace(t.id!)}
              onDelete={() => void deleteTrace(t)}
            />
          ))}
          <div className="pager">
            <button
              type="button"
              className="page"
              disabled={!hasPrev}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              ← Prev
            </button>
            <span className="muted">Page {page + 1}</span>
            <button
              type="button"
              className="page"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        </aside>

        <section className="detail">
          {selected ? (
            <>
              <h2>{selected.name}</h2>
              <p className="muted">
                {fmtMs(traceDurationMs(selected))} · {selected.spans.length} span
                {selected.spans.length === 1 ? '' : 's'}
              </p>
              <ul className="spans">
                {selected.spans.map((s) => (
                  <SpanRow key={s.id} span={s} />
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">Select a trace to inspect its spans.</p>
          )}
        </section>
      </section>

      <style>{`
        :root { color-scheme: dark; }
        * { box-sizing: border-box; }
        body { margin: 0; background: #0f1115; color: #e6e8eb; font: 14px/1.5 system-ui, sans-serif; }
        main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
        header h1 { margin: 0; font-size: 20px; }
        .subtitle { margin: 2px 0 0; color: #8b949e; }
        .muted { color: #8b949e; }
        .error { background: #3d1d1d; border: 1px solid #7f2b2b; color: #ffb4b4; padding: 8px 12px; border-radius: 6px; margin-top: 12px; }
        .layout { display: grid; grid-template-columns: 320px 1fr; gap: 24px; margin-top: 16px; }
        @media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
        .list h2, .detail h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; }
        .row { display: flex; align-items: center; gap: 6px; width: 100%; background: #161a20; border: 1px solid #232830; border-radius: 8px; padding: 6px 8px 6px 12px; margin-bottom: 8px; }
        .row.active { border-color: #4c8bf5; background: #1a2130; }
        .row-main { flex: 1; display: flex; justify-content: space-between; gap: 12px; min-width: 0; text-align: left; background: none; border: none; padding: 4px 0; color: inherit; font: inherit; cursor: pointer; }
        .row-main .name { font-weight: 600; }
        .row .meta, .span .meta { color: #8b949e; white-space: nowrap; }
        .usage { color: #a5d6ff; font-weight: 500; }
        .cost { color: #ffa657; font-weight: 500; }
        .row-delete { background: none; border: none; color: #8b949e; font: inherit; font-size: 12px; line-height: 1; cursor: pointer; padding: 4px 6px; border-radius: 4px; }
        .row-delete:hover { color: #ffb4b4; background: #3d1d1d; }
        .spans { list-style: none; padding: 0; margin: 0; }
        .span { display: flex; justify-content: space-between; gap: 12px; background: #161a20; border: 1px solid #232830; border-left: 3px solid #2f9e44; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; }
        .span.error { border-left-color: #e03131; }
        .filters { display: flex; gap: 6px; margin-bottom: 10px; }
        .filter { background: #161a20; border: 1px solid #232830; color: #8b949e; border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer; }
        .filter.active { border-color: #4c8bf5; color: #e6e8eb; background: #1a2130; }
        .pager { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 12px; }
        .page { background: #161a20; border: 1px solid #232830; color: #e6e8eb; border-radius: 6px; padding: 5px 10px; font: inherit; font-size: 12px; cursor: pointer; }
        .page:disabled { opacity: .45; cursor: default; }
      `}</style>
    </main>
  )
}
