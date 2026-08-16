import { useCallback, useEffect, useState } from 'react'
import type { Span, Trace } from '../domain/trace'
import { spanDurationMs, traceDurationMs } from '../domain/trace'

const fmtMs = (ms: number) => `${ms}ms`

function TraceRow({ trace, active, onSelect }: { trace: Trace; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={active ? 'row active' : 'row'}
      aria-current={active ? 'true' : undefined}
    >
      <span className="name">{trace.name}</span>
      <span className="meta">
        {trace.spans.length} span{trace.spans.length === 1 ? '' : 's'} · {fmtMs(traceDurationMs(trace))}
      </span>
    </button>
  )
}

function SpanRow({ span }: { span: Span }) {
  return (
    <li className={span.status === 'error' ? 'span error' : 'span'}>
      <span className="name">{span.name}</span>
      <span className="meta">
        {span.status} · {fmtMs(spanDurationMs(span))}
      </span>
    </li>
  )
}

export default function App() {
  const [traces, setTraces] = useState<Trace[]>([])
  const [selected, setSelected] = useState<Trace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/traces')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<Trace[]>
      })
      .then(setTraces)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'failed to load traces'))
      .finally(() => setLoading(false))
  }, [])

  const selectTrace = useCallback(async (id: string) => {
    const r = await fetch(`/api/traces/${id}`)
    if (!r.ok) return
    setSelected(await (r.json() as Promise<Trace>))
  }, [])

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
          {loading && <p className="muted">Loading…</p>}
          {!loading && traces.length === 0 && <p className="muted">No traces yet. POST one to /api/traces.</p>}
          {traces.map((t) => (
            <TraceRow
              key={t.id}
              trace={t}
              active={selected?.id === t.id}
              onSelect={() => void selectTrace(t.id!)}
            />
          ))}
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
        .row { display: flex; justify-content: space-between; gap: 12px; width: 100%; text-align: left; background: #161a20; border: 1px solid #232830; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; color: inherit; font: inherit; }
        .row.active { border-color: #4c8bf5; background: #1a2130; }
        .row .name { font-weight: 600; }
        .row .meta, .span .meta { color: #8b949e; white-space: nowrap; }
        .spans { list-style: none; padding: 0; margin: 0; }
        .span { display: flex; justify-content: space-between; gap: 12px; background: #161a20; border: 1px solid #232830; border-left: 3px solid #2f9e44; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; }
        .span.error { border-left-color: #e03131; }
      `}</style>
    </main>
  )
}
