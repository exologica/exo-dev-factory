import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { Span, Trace } from '../domain/trace'
import {
  spanDurationMs,
  traceDurationMs,
  traceTotalPromptTokens,
  traceTotalCompletionTokens,
  traceTotalCost,
  traceHasUsage,
  spanHasUsage,
  traceStatus
} from '../domain/trace'

const fmtMs = (ms: number) => `${ms}ms`
const PAGE_SIZES = [10, 20, 50, 100] as const
const DEFAULT_PAGE_SIZE = 10
const DEBOUNCE_MS = 300
const URL_SYNC_DEBOUNCE_MS = 300

const URL_PARAM_KEYS = {
  serviceName: 'serviceName',
  operationName: 'operationName',
  status: 'status',
  startTimeGte: 'startTimeGte',
  startTimeLte: 'startTimeLte',
  page: 'page',
  limit: 'limit',
  sort: 'sort',
  sortDir: 'sortDir'
} as const

function filtersToSearchParams(filters: FilterState): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.serviceName !== '') params.set(URL_PARAM_KEYS.serviceName, filters.serviceName)
  if (filters.operationName !== '') params.set(URL_PARAM_KEYS.operationName, filters.operationName)
  if (filters.status !== 'all') params.set(URL_PARAM_KEYS.status, filters.status)
  if (filters.startTimeGte !== '') params.set(URL_PARAM_KEYS.startTimeGte, filters.startTimeGte)
  if (filters.startTimeLte !== '') params.set(URL_PARAM_KEYS.startTimeLte, filters.startTimeLte)
  if (filters.page !== 1) params.set(URL_PARAM_KEYS.page, String(filters.page))
  if (filters.pageSize !== DEFAULT_PAGE_SIZE) params.set(URL_PARAM_KEYS.limit, String(filters.pageSize))
  if (filters.sort !== 'startTime') params.set(URL_PARAM_KEYS.sort, filters.sort)
  if (filters.sortDir !== 'desc') params.set(URL_PARAM_KEYS.sortDir, filters.sortDir)
  return params
}

function searchParamsToFilters(searchParams: URLSearchParams): Partial<FilterState> {
  const patch: Partial<FilterState> = {}
  
  const serviceName = searchParams.get(URL_PARAM_KEYS.serviceName)
  if (serviceName !== null) patch.serviceName = serviceName
  
  const operationName = searchParams.get(URL_PARAM_KEYS.operationName)
  if (operationName !== null) patch.operationName = operationName
  
  const status = searchParams.get(URL_PARAM_KEYS.status)
  if (status === 'ok' || status === 'error') patch.status = status
  
  const startTimeGte = searchParams.get(URL_PARAM_KEYS.startTimeGte)
  if (startTimeGte !== null && startTimeGte !== '') {
    const parsed = Date.parse(startTimeGte)
    if (!Number.isNaN(parsed)) patch.startTimeGte = startTimeGte
  }
  
  const startTimeLte = searchParams.get(URL_PARAM_KEYS.startTimeLte)
  if (startTimeLte !== null && startTimeLte !== '') {
    const parsed = Date.parse(startTimeLte)
    if (!Number.isNaN(parsed)) patch.startTimeLte = startTimeLte
  }
  
  const page = searchParams.get(URL_PARAM_KEYS.page)
  if (page !== null) {
    const parsed = Number(page)
    if (Number.isInteger(parsed) && parsed >= 1) patch.page = parsed
  }
  
  const limit = searchParams.get(URL_PARAM_KEYS.limit)
  if (limit !== null) {
    const parsed = Number(limit)
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) patch.pageSize = parsed
  }
  
  const sort = searchParams.get(URL_PARAM_KEYS.sort)
  const validSortKeys = ['startTime', 'durationMs', 'name', 'operation', 'sessionId', 'status'] as const
  if (sort !== null && validSortKeys.includes(sort as typeof validSortKeys[number])) {
    patch.sort = sort as FilterState['sort']
  }
  
  const sortDir = searchParams.get(URL_PARAM_KEYS.sortDir)
  if (sortDir === 'asc' || sortDir === 'desc') {
    patch.sortDir = sortDir
  }
  
  return patch
}

function getInitialFiltersFromUrl(): FilterState {
  if (typeof window === 'undefined') return initialFilters
  try {
    const searchParams = new URLSearchParams(window.location.search)
    const urlPatch = searchParamsToFilters(searchParams)
    return { ...initialFilters, ...urlPatch }
  } catch {
    return initialFilters
  }
}

function syncFiltersToUrl(filters: FilterState): void {
  if (typeof window === 'undefined') return
  try {
    const params = filtersToSearchParams(filters)
    const newUrl = params.toString() ? `${window.location.pathname}?${params}` : window.location.pathname
    window.history.replaceState(null, '', newUrl)
  } catch {
    // Silently ignore URL sync errors (e.g., sandboxed iframe)
  }
}

const SORT_OPTIONS = [
  { key: 'startTime', label: 'Timestamp' },
  { key: 'durationMs', label: 'Duration' },
  { key: 'name', label: 'Service' },
  { key: 'operation', label: 'Operation' },
  { key: 'sessionId', label: 'Session' },
  { key: 'status', label: 'Status' }
] as const

type SortKey = typeof SORT_OPTIONS[number]['key']
type SortDir = 'asc' | 'desc'

interface FilterState {
  serviceName: string
  operationName: string
  status: 'all' | 'ok' | 'error'
  startTimeGte: string
  startTimeLte: string
  sessionId: string
  userId: string
  sort: SortKey
  sortDir: SortDir
  page: number
  pageSize: number
  groupBySession: boolean
}

const initialFilters: FilterState = {
  serviceName: '',
  operationName: '',
  status: 'all',
  startTimeGte: '',
  startTimeLte: '',
  sessionId: '',
  userId: '',
  sort: 'startTime',
  sortDir: 'desc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  groupBySession: false
}

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

function FilterBar({
  filters,
  onChange,
  loading,
  serviceNames,
  operationNames,
  sessionNames,
  onClear
}: {
  filters: FilterState
  onChange: (patch: Partial<FilterState>) => void
  loading: boolean
  serviceNames: string[]
  operationNames: string[]
  sessionNames: string[]
  onClear: () => void
}) {
  const hasActiveFilters = useMemo(
    () =>
      filters.serviceName !== '' ||
      filters.operationName !== '' ||
      filters.status !== 'all' ||
      filters.startTimeGte !== '' ||
      filters.startTimeLte !== '' ||
      filters.sessionId !== '' ||
      filters.userId !== '',
    [filters]
  )

  const handleFilterChange = useCallback(
    (key: keyof FilterState, value: string | boolean) => {
      onChange({ [key]: value, page: 1 })
    },
    [onChange]
  )

  return (
    <div className="filters-bar">
      <div className="filter-group">
        <label htmlFor="filter-service" className="sr-only">
          Service name
        </label>
        <select
          id="filter-service"
          value={filters.serviceName}
          onChange={(e) => handleFilterChange('serviceName', e.target.value)}
          disabled={loading}
          className="filter-input"
        >
          <option value="">All services</option>
          {serviceNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <label htmlFor="filter-operation" className="sr-only">
          Operation name
        </label>
        <input
          id="filter-operation"
          type="text"
          placeholder="Operation name…"
          value={filters.operationName}
          onChange={(e) => handleFilterChange('operationName', e.target.value)}
          disabled={loading}
          className="filter-input"
        />
      </div>

      <div className="filter-group">
        <label htmlFor="filter-status" className="sr-only">
          Status
        </label>
        <select
          id="filter-status"
          value={filters.status}
          onChange={(e) => handleFilterChange('status', e.target.value as 'all' | 'ok' | 'error')}
          disabled={loading}
          className="filter-input"
        >
          <option value="all">All statuses</option>
          <option value="ok">OK</option>
          <option value="error">Errors</option>
        </select>
      </div>

      <div className="filter-group">
        <label htmlFor="filter-session" className="sr-only">
          Session ID
        </label>
        <select
          id="filter-session"
          value={filters.sessionId}
          onChange={(e) => handleFilterChange('sessionId', e.target.value)}
          disabled={loading}
          className="filter-input"
        >
          <option value="">All sessions</option>
          {sessionNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <label htmlFor="filter-user" className="sr-only">
          User ID
        </label>
        <input
          id="filter-user"
          type="text"
          placeholder="User ID…"
          value={filters.userId}
          onChange={(e) => handleFilterChange('userId', e.target.value)}
          disabled={loading}
          className="filter-input"
        />
      </div>

      <div className="filter-group time-range">
        <label htmlFor="filter-start-time" className="sr-only">
          Start time
        </label>
        <input
          id="filter-start-time"
          type="datetime-local"
          value={filters.startTimeGte ? new Date(filters.startTimeGte).toISOString().slice(0, 16) : ''}
          onChange={(e) => {
            const val = e.target.value
            handleFilterChange('startTimeGte', val ? new Date(val).toISOString() : '')
          }}
          disabled={loading}
          className="filter-input time-input"
        />
        <span className="time-sep">to</span>
        <label htmlFor="filter-end-time" className="sr-only">
          End time
        </label>
        <input
          id="filter-end-time"
          type="datetime-local"
          value={filters.startTimeLte ? new Date(filters.startTimeLte).toISOString().slice(0, 16) : ''}
          onChange={(e) => {
            const val = e.target.value
            handleFilterChange('startTimeLte', val ? new Date(val).toISOString() : '')
          }}
          disabled={loading}
          className="filter-input time-input"
        />
      </div>

      <div className="filter-group group-toggle">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={filters.groupBySession}
            onChange={(e) => handleFilterChange('groupBySession', e.target.checked)}
            disabled={loading}
            className="checkbox-input"
          />
          <span className="checkbox-text">Group by Session</span>
        </label>
      </div>

      {hasActiveFilters && (
        <button
          type="button"
          className="clear-filters"
          onClick={onClear}
          disabled={loading}
          aria-label="Clear all filters"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}

function SortableHeader({
  column,
  activeSort,
  activeDir,
  onSort,
  loading
}: {
  column: (typeof SORT_OPTIONS)[number]
  activeSort: SortKey
  activeDir: SortDir
  onSort: (key: SortKey) => void
  loading: boolean
}) {
  const isActive = activeSort === column.key

  return (
    <th
      scope="col"
      className={isActive ? `sorted ${activeDir}` : ''}
      onClick={() => !loading && onSort(column.key)}
      style={{ cursor: loading ? 'not-allowed' : 'pointer' }}
    >
      <span>{column.label}</span>
      {isActive && (
        <span className="sort-indicator" aria-hidden="true">
          {activeDir === 'asc' ? ' ▲' : ' ▼'}
        </span>
      )}
    </th>
  )
}

function PaginationControls({
  page,
  pageSize,
  total,
  totalPages,
  loading,
  onPageChange,
  onPageSizeChange
}: {
  page: number
  pageSize: number
  total: number
  totalPages: number
  loading: boolean
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}) {
  if (totalPages <= 1) return null

  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)

  return (
    <div className="pager">
      <div className="page-size">
        <label htmlFor="page-size" className="sr-only">
          Page size
        </label>
        <select
          id="page-size"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          disabled={loading}
          className="filter-input"
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} / page
            </option>
          ))}
        </select>
      </div>

      <div className="page-info">
        Showing {start}–{end} of {total}
      </div>

      <div className="page-nav">
        <button
          type="button"
          className="page"
          disabled={loading || page === 1}
          onClick={() => onPageChange(page - 1)}
        >
          ← Prev
        </button>
        <span className="muted">Page {page} of {totalPages}</span>
        <button
          type="button"
          className="page"
          disabled={loading || page === totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next →
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const [traces, setTraces] = useState<Trace[]>([])
  const [selected, setSelected] = useState<Trace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [filters, setFilters] = useState<FilterState>(() => getInitialFiltersFromUrl())
  const [debouncedFilters, setDebouncedFilters] = useState<FilterState>(() => getInitialFiltersFromUrl())
  const [serviceNames, setServiceNames] = useState<string[]>([])
  const [operationNames, setOperationNames] = useState<string[]>([])
  const [sessionNames, setSessionNames] = useState<string[]>([])

  // Sync filters to URL (debounced, replaceState)
  useEffect(() => {
    const timer = setTimeout(() => {
      syncFiltersToUrl(filters)
    }, URL_SYNC_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filters])

  // Debounce filter changes for API requests
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedFilters(filters)
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filters])

  useEffect(() => {
    const services = new Set<string>()
    const operations = new Set<string>()
    const sessions = new Set<string>()
    for (const trace of traces) {
      services.add(trace.name)
      if (trace.spans[0]) operations.add(trace.spans[0].name)
      if (trace.sessionId) sessions.add(trace.sessionId)
    }
    setServiceNames(Array.from(services).sort())
    setOperationNames(Array.from(operations).sort())
    setSessionNames(Array.from(sessions).sort())
  }, [traces])

  // Fetch traces with debounced filters
  useEffect(() => {
    const params = new URLSearchParams({
      page: String(debouncedFilters.page),
      limit: String(debouncedFilters.pageSize)
    })
    if (debouncedFilters.serviceName) params.set('serviceName', debouncedFilters.serviceName)
    if (debouncedFilters.operationName) params.set('operationName', debouncedFilters.operationName)
    if (debouncedFilters.status !== 'all') params.set('status', debouncedFilters.status)
    if (debouncedFilters.sessionId) params.set('sessionId', debouncedFilters.sessionId)
    if (debouncedFilters.userId) params.set('userId', debouncedFilters.userId)
    if (debouncedFilters.startTimeGte) params.set('startTimeGte', debouncedFilters.startTimeGte)
    if (debouncedFilters.startTimeLte) params.set('startTimeLte', debouncedFilters.startTimeLte)
    if (debouncedFilters.sort && debouncedFilters.sortDir) {
      params.set('sort', `${debouncedFilters.sort}:${debouncedFilters.sortDir}`)
    }

    setLoading(true)
    fetch(`/api/traces?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<{
          data: Trace[]
          pagination: { page: number; limit: number; total: number; totalPages: number }
        }>
      })
      .then((res) => {
        setTraces(res.data)
        setTotal(res.pagination.total)
        setTotalPages(res.pagination.totalPages)
        setFilters((f) => ({ ...f, page: res.pagination.page }))
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'failed to load traces'))
      .finally(() => setLoading(false))
  }, [debouncedFilters])

  const selectTrace = useCallback(async (id: string) => {
    const r = await fetch(`/api/traces/${id}`)
    if (!r.ok) return
    setSelected(await (r.json() as Promise<Trace>))
  }, [])

  const deleteTrace = useCallback(async (trace: Trace) => {
    const r = await fetch(`/api/traces/${trace.id}`, { method: 'DELETE' })
    if (r.status !== 204 && r.status !== 404) return
    const remaining = traces.filter((t) => t.id !== trace.id)
    setTraces(remaining)
    setTotal((t) => t - 1)
    setSelected((sel) => (sel?.id === trace.id ? null : sel))
    if (remaining.length === 0 && filters.page > 1) {
      setFilters((f) => ({ ...f, page: f.page - 1 }))
    }
  }, [traces, filters.page])

  const handleFilterChange = useCallback((patch: Partial<FilterState>) => {
    setFilters((f) => ({ ...f, ...patch }))
  }, [])

  const handleSort = useCallback((key: SortKey) => {
    setFilters((f) => ({
      ...f,
      sort: key,
      sortDir: f.sort === key && f.sortDir === 'asc' ? 'desc' : 'asc',
      page: 1
    }))
  }, [])

  const handlePageChange = useCallback((page: number) => {
    setFilters((f) => ({ ...f, page }))
  }, [])

  const handlePageSizeChange = useCallback((size: number) => {
    setFilters((f) => ({ ...f, pageSize: size, page: 1 }))
  }, [])

  const clearFilters = useCallback(() => {
    const cleared = {
      ...initialFilters,
      sort: filters.sort,
      sortDir: filters.sortDir,
      pageSize: filters.pageSize
    }
    setFilters(cleared)
    syncFiltersToUrl(cleared)
  }, [filters.sort, filters.sortDir, filters.pageSize])

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

          <FilterBar
            filters={filters}
            onChange={handleFilterChange}
            loading={loading}
            serviceNames={serviceNames}
            operationNames={operationNames}
            sessionNames={sessionNames}
            onClear={clearFilters}
          />

          {loading && <p className="muted loading">Loading…</p>}
          {!loading && traces.length === 0 && (
            <p className="muted">
              {debouncedFilters.serviceName ||
              debouncedFilters.operationName ||
              debouncedFilters.status !== 'all' ||
              debouncedFilters.startTimeGte ||
              debouncedFilters.startTimeLte ||
              debouncedFilters.sessionId ||
              debouncedFilters.userId
                ? 'No traces match this filter.'
                : 'No traces yet. POST one to /api/traces.'}
            </p>
          )}

          {!loading && traces.length > 0 && (
            <>
              <div className="trace-table-wrapper">
                <table className="trace-table" role="grid">
                  <thead>
                    <tr>
                      {SORT_OPTIONS.map((col) => (
                        <SortableHeader
                          key={col.key}
                          column={col}
                          activeSort={debouncedFilters.sort}
                          activeDir={debouncedFilters.sortDir}
                          onSort={handleSort}
                          loading={loading}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {debouncedFilters.groupBySession ? (
                      (() => {
                        const groups = new Map<string, Trace[]>()
                        for (const t of traces) {
                          const key = t.sessionId ?? '__no_session__'
                          if (!groups.has(key)) groups.set(key, [])
                          groups.get(key)!.push(t)
                        }
                        return Array.from(groups.entries()).map(([sessionId, groupTraces]) => (
                          <React.Fragment key={sessionId}>
                            <tr className="group-header">
                              <td colSpan={SORT_OPTIONS.length}>
                                <span className="group-label">
                                  {sessionId === '__no_session__' ? (
                                    <span className="no-session">No Session</span>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        className="session-link"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          handleFilterChange({ sessionId, page: 1 })
                                        }}
                                        aria-label={`Filter by session ${sessionId}`}
                                      >
                                        {sessionId}
                                      </button>
                                      <span className="group-count">({groupTraces.length} trace{groupTraces.length === 1 ? '' : 's'})</span>
                                    </>
                                  )}
                                </span>
                              </td>
                            </tr>
                            {groupTraces.map((t) => (
                              <tr
                                key={t.id}
                                className={selected?.id === t.id ? 'active' : ''}
                                onClick={() => void selectTrace(t.id!)}
                                role="row"
                                aria-selected={selected?.id === t.id}
                              >
                                <td>{new Date(t.startTime).toLocaleTimeString()}</td>
                                <td>{fmtMs(traceDurationMs(t))}</td>
                                <td>{t.name}</td>
                                <td>{t.spans[0]?.name ?? '—'}</td>
                                <td>
                                  {t.sessionId ? (
                                    <button
                                      type="button"
                                      className="session-link"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        handleFilterChange({ sessionId: t.sessionId!, page: 1 })
                                      }}
                                      aria-label={`Filter by session ${t.sessionId}`}
                                    >
                                      {t.sessionId}
                                    </button>
                                  ) : (
                                    <span className="no-session">—</span>
                                  )}
                                </td>
                                <td>
                                  <span className={`status-badge ${traceStatus(t)}`}>
                                    {traceStatus(t).toUpperCase()}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </React.Fragment>
                        ))
                      })()
                    ) : (
                      traces.map((t) => (
                        <tr
                          key={t.id}
                          className={selected?.id === t.id ? 'active' : ''}
                          onClick={() => void selectTrace(t.id!)}
                          role="row"
                          aria-selected={selected?.id === t.id}
                        >
                          <td>{new Date(t.startTime).toLocaleTimeString()}</td>
                          <td>{fmtMs(traceDurationMs(t))}</td>
                          <td>{t.name}</td>
                          <td>{t.spans[0]?.name ?? '—'}</td>
                          <td>
                            {t.sessionId ? (
                              <button
                                type="button"
                                className="session-link"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleFilterChange({ sessionId: t.sessionId, page: 1 })
                                }}
                                aria-label={`Filter by session ${t.sessionId}`}
                              >
                                {t.sessionId}
                              </button>
                            ) : (
                              <span className="no-session">—</span>
                            )}
                          </td>
                          <td>
                            <span className={`status-badge ${traceStatus(t)}`}>
                              {traceStatus(t).toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <PaginationControls
                page={filters.page}
                pageSize={filters.pageSize}
                total={total}
                totalPages={totalPages}
                loading={loading}
                onPageChange={handlePageChange}
                onPageSizeChange={handlePageSizeChange}
              />
            </>
          )}
        </aside>

        <section className="detail">
          {selected ? (
            <>
              <h2>{selected.name}</h2>
              <p className="muted">
                {fmtMs(traceDurationMs(selected))} · {selected.spans.length} span
                {selected.spans.length === 1 ? '' : 's'}
                {selected.sessionId && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="session-badge-link"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleFilterChange({ sessionId: selected.sessionId!, page: 1 })
                      }}
                      aria-label={`Filter by session ${selected.sessionId}`}
                    >
                      Session: {selected.sessionId}
                    </button>
                  </>
                )}
                {selected.userId && (
                  <>
                    {' · '}
                    <span className="user-badge">User: {selected.userId}</span>
                  </>
                )}
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
        main { max-width: 1200px; margin: 0 auto; padding: 24px 16px 64px; }
        header h1 { margin: 0; font-size: 20px; }
        .subtitle { margin: 2px 0 0; color: #8b949e; }
        .muted { color: #8b949e; }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
        .error { background: #3d1d1d; border: 1px solid #7f2b2b; color: #ffb4b4; padding: 8px 12px; border-radius: 6px; margin-top: 12px; }
        .layout { display: grid; grid-template-columns: 420px 1fr; gap: 24px; margin-top: 16px; }
        @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
        .list h2, .detail h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; }
        .filters-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; padding: 10px; background: #161a20; border: 1px solid #232830; border-radius: 8px; }
        .filter-group { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 140px; }
        .filter-group.time-range { flex-direction: row; align-items: center; gap: 6px; min-width: auto; }
        .filter-group.group-toggle { flex-direction: row; align-items: center; gap: 6px; min-width: auto; }
        .time-input { width: 160px; }
        .time-sep { color: #8b949e; font-size: 12px; }
        .filter-input { background: #0f1115; border: 1px solid #232830; color: #e6e8eb; border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 13px; }
        .filter-input:focus { outline: none; border-color: #4c8bf5; }
        .filter-input:disabled { opacity: .6; cursor: not-allowed; }
        .checkbox-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: #e6e8eb; }
        .checkbox-input { width: 16px; height: 16px; accent-color: #4c8bf5; }
        .checkbox-input:disabled { opacity: .6; cursor: not-allowed; }
        .checkbox-text { user-select: none; }
        .clear-filters { background: #232830; border: 1px solid #38444d; color: #a5d6ff; border-radius: 6px; padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer; margin-top: 18px; }
        .clear-filters:hover { background: #3d1d1d; border-color: #7f2b2b; color: #ffb4b4; }
        .loading { text-align: center; padding: 20px; }
        .trace-table-wrapper { overflow-x: auto; }
        .trace-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .trace-table th { text-align: left; padding: 8px 12px; background: #161a20; border-bottom: 1px solid #232830; color: #8b949e; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; user-select: none; }
        .trace-table th.sorted { color: #e6e8eb; }
        .trace-table th.sorted.asc::after { content: ' ▲'; }
        .trace-table th.sorted.desc::after { content: ' ▼'; }
        .trace-table td { padding: 10px 12px; border-bottom: 1px solid #1e2228; }
        .trace-table tbody tr { background: #161a20; transition: background .1s; }
        .trace-table tbody tr:hover { background: #1a2130; }
        .trace-table tbody tr.active { background: #1a2130; border-left: 3px solid #4c8bf5; }
        .trace-table tbody tr.group-header { background: #1a1f2a; border-bottom: 2px solid #2a3542; }
        .trace-table tbody tr.group-header td { padding: 8px 12px; }
        .group-label { display: flex; align-items: center; gap: 8px; }
        .group-count { color: #8b949e; font-size: 12px; }
        .session-link { background: none; border: none; color: #a5d6ff; font: inherit; font-size: 13px; cursor: pointer; padding: 0; text-decoration: underline; text-decoration-style: dotted; }
        .session-link:hover { color: #c8e1ff; text-decoration-style: solid; }
        .session-link:focus { outline: none; color: #c8e1ff; }
        .no-session { color: #4a525a; font-style: italic; }
        .status-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
        .status-badge.ok { background: #1f3d2e; color: #2f9e44; }
        .status-badge.error { background: #3d1d1d; color: #e03131; }
        .session-badge-link { background: none; border: none; color: #a5d6ff; font: inherit; font-size: 13px; cursor: pointer; padding: 0; text-decoration: underline; text-decoration-style: dotted; }
        .session-badge-link:hover { color: #c8e1ff; text-decoration-style: solid; }
        .session-badge-link:focus { outline: none; color: #c8e1ff; }
        .user-badge { color: #ffa657; font-size: 13px; }
        .spans { list-style: none; padding: 0; margin: 0; }
        .span { display: flex; justify-content: space-between; gap: 12px; background: #161a20; border: 1px solid #232830; border-left: 3px solid #2f9e44; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; }
        .span.error { border-left-color: #e03131; }
        .span .name { font-weight: 500; }
        .span .meta { color: #8b949e; }
        .usage { color: #a5d6ff; font-weight: 500; }
        .cost { color: #ffa657; font-weight: 500; }
        .pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; padding: 10px; background: #161a20; border: 1px solid #232830; border-radius: 8px; }
        .page-size { flex: 1; min-width: 140px; }
        .page-info { flex: 1; text-align: center; color: #8b949e; font-size: 13px; }
        .page-nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .page { background: #0f1115; border: 1px solid #232830; color: #e6e8eb; border-radius: 6px; padding: 5px 12px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
        .page:disabled { opacity: .45; cursor: not-allowed; }
        .page:hover:not(:disabled) { border-color: #4c8bf5; }
        .legacy-pager { display: none; }
        @media (max-width: 600px) {
          .filters-bar { flex-direction: column; align-items: stretch; }
          .filter-group { min-width: 0; }
          .filter-group.time-range { flex-direction: column; align-items: stretch; }
          .filter-group.group-toggle { justify-content: flex-start; }
          .time-input { width: 100%; }
          .pager { flex-direction: column; align-items: stretch; }
          .page-nav { width: 100%; justify-content: space-between; }
          .page-info { text-align: center; order: -1; }
        }
      `}</style>
    </main>
  )
}
