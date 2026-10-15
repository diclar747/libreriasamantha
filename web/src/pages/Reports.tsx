import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, gs, useApp } from '../api'
import { Field, fmtDate, fmtDateTime, openAuthed, Pager, qs, Status, useDebounced } from '../ui'

interface Col { key: string; label: string; type: string; width?: number }
const RANGES: [string, string][] = [['today', 'Hoy'], ['yesterday', 'Ayer'], ['week', 'Esta semana'], ['month', 'Este mes'], ['last7', 'Últimos 7 días'], ['last30', 'Últimos 30 días'], ['year', 'Este año'], ['custom', 'Personalizado']]
const OPTS: Record<string, [string, string][]> = {
  channel: [['pos', 'Mostrador'], ['web', 'Tienda en línea'], ['whatsapp', 'WhatsApp']],
  method: [['cash', 'Efectivo'], ['card', 'Tarjeta'], ['qr', 'QR'], ['transfer', 'Transferencia'], ['check', 'Cheque'], ['online', 'Pago en línea'], ['advance', 'Anticipo']],
  condition: [['cash', 'Contado'], ['credit', 'Crédito']],
  state: [['valid', 'Vigentes'], ['void', 'Anuladas'], ['returned', 'Devueltas'], ['partial_return', 'Devolución parcial'], ['all', 'Todas']],
  collection: [['paid', 'Cobradas'], ['partial', 'Cobro parcial'], ['pending', 'Pendientes de cobro']],
  orderStatus: [['draft', 'Borrador'], ['confirmed', 'Confirmado'], ['completed', 'Completado'], ['cancelled', 'Cancelado']],
  paymentStatus: [['pending', 'Pendiente de pago'], ['in_review', 'En revisión'], ['approved', 'Aprobado'], ['rejected', 'Rechazado'], ['refunded', 'Reembolsado']],
  deliveryStatus: [['pending', 'Sin preparar'], ['preparing', 'En preparación'], ['ready', 'Listo'], ['dispatched', 'En camino'], ['delivered', 'Entregado'], ['incident', 'Incidencia']],
  deliveryMethod: [['pickup', 'Retiro en local'], ['delivery', 'Delivery']],
  expenseStatus: [['pending', 'Pendiente'], ['partial', 'Pago parcial'], ['paid', 'Pagado'], ['void', 'Anulado']],
  cashStatus: [['open', 'Abiertas'], ['closed', 'Cerradas']],
  poStatus: [['draft', 'Borrador'], ['pending_approval', 'Por aprobar'], ['approved', 'Aprobada'], ['issued', 'Emitida'], ['partial', 'Recibida parcial'], ['received', 'Recibida'], ['closed_short', 'Cerrada incompleta'], ['cancelled', 'Anulada']],
  invStatus: [['open', 'Pendiente de pago'], ['paid', 'Pagada'], ['void', 'Anulada']],
  stockState: [['low', 'Stock bajo'], ['out', 'Agotados']],
  stockType: [['sale', 'Venta'], ['purchase', 'Compra'], ['adjustment', 'Ajuste'], ['count', 'Conteo físico'], ['return', 'Devolución de cliente'], ['supplier_return', 'Devolución a proveedor'], ['void', 'Anulación'], ['online_sale', 'Venta online']],
  direction: [['in', 'Ingresos'], ['out', 'Egresos']],
  settlement: [['pending', 'Pendiente'], ['settled', 'Acreditado'], ['rejected', 'Rechazado']],
}
const LABELS: Record<string, string> = {
  channel: 'Canal', method: 'Medio de pago', condition: 'Condición', state: 'Estado de la venta', collection: 'Cobro', orderStatus: 'Estado del pedido', paymentStatus: 'Estado del pago', deliveryStatus: 'Entrega',
  deliveryMethod: 'Tipo de entrega', expenseStatus: 'Estado del gasto', cashStatus: 'Estado de la caja', poStatus: 'Estado', invStatus: 'Estado', stockState: 'Existencias', stockType: 'Tipo de movimiento', direction: 'Dirección', settlement: 'Acreditación',
  customer: 'Cliente', supplier: 'Proveedor', account: 'Cuenta', expenseCategory: 'Categoría de gasto', category: 'Categoría', brand: 'Marca', product: 'Producto', seller: 'Vendedor', user: 'Usuario', session: 'Turno de caja',
}
const NUMERIC_ID = ['customer', 'supplier', 'account', 'expenseCategory', 'product', 'seller', 'user', 'session']

function Cell({ c, v, row }: { c: Col; v: any; row: any }) {
  if (v === null || v === undefined || v === '') return <>{c.type === 'money' || c.type === 'int' ? '—' : ''}</>
  switch (c.type) {
    case 'money': return <>{gs(v)}</>
    case 'int': return <>{Number(v).toLocaleString('es-PY')}</>
    case 'percent': return <>{Number(v).toLocaleString('es-PY', { maximumFractionDigits: 1 })}%</>
    case 'date': return <>{fmtDate(String(v))}</>
    case 'datetime': return <>{fmtDateTime(String(v))}</>
    case 'status': return <Status value={String(row[c.key + '_code'] ?? v)} label={String(v)} />
    default: return <>{String(v)}</>
  }
}

function DataTable({ cols, rows, totals, onRow }: { cols: Col[]; rows: any[]; totals?: Record<string, any>; onRow: (r: any) => void }) {
  const right = (c: Col) => ['money', 'int', 'percent'].includes(c.type)
  return (
    <div className="table-wrap">
      <table className="report-table">
        <thead><tr>{cols.map((c) => <th key={c.key} className={right(c) ? 'money' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.link ? 'clickable' : ''} onClick={() => r.link && onRow(r)}>{cols.map((c) => <td key={c.key} className={right(c) ? 'money' : ''}><Cell c={c} v={r[c.key]} row={r} /></td>)}</tr>
          ))}
          {!rows.length && <tr><td colSpan={cols.length} className="muted empty">No hay datos con estos filtros</td></tr>}
        </tbody>
        {totals && !!rows.length && <tfoot><tr>{cols.map((c) => <td key={c.key} className={right(c) ? 'money' : ''}>{totals[c.key] === undefined ? '' : <Cell c={c} v={totals[c.key]} row={totals} />}</td>)}</tr></tfoot>}
      </table>
    </div>
  )
}

export default function Reports() {
  const { toast, user } = useApp()
  const nav = useNavigate()
  const { id: routeId } = useParams()
  const [sp, setSp] = useSearchParams()
  const [catalog, setCatalog] = useState<any[]>([])
  const [lookups, setLookups] = useState<Record<string, [number, string][]>>({})
  const [res, setRes] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(15)
  const [cols, setCols] = useState<string[] | null>(null)
  const [showCols, setShowCols] = useState(false)
  const [printAll, setPrintAll] = useState(false) // al imprimir se traen TODAS las filas, no solo la página visible

  const id = routeId ?? sp.get('report') ?? 'sales'
  const def = catalog.find((d) => d.id === id)
  const f = useMemo(() => Object.fromEntries([...sp.entries()].filter(([k]) => k !== 'report')), [sp])
  const q = useDebounced(f.q ?? '', 350)
  const range = f.range ?? (f.from || f.to ? 'custom' : 'month')

  useEffect(() => { api('/reports/catalog').then(setCatalog).catch((e) => toast(e.message, true)) }, [])
  // listas para los filtros por cliente, proveedor, cuenta, etc.
  useEffect(() => {
    if (!def) return
    const need = (k: string) => def.filters.includes(k) && !lookups[k]
    const put = (k: string, rows: any[], name = (r: any) => r.name, key = (r: any) => r.id) => setLookups((l) => ({ ...l, [k]: rows.map((r) => [key(r), name(r)] as [number, string]) }))
    if (need('customer')) api('/customers').then((r) => put('customer', r)).catch(() => {})
    if (need('supplier')) api('/suppliers?all=1').then((r) => put('supplier', r)).catch(() => {})
    if (need('account')) api('/money-accounts').then((r) => put('account', r)).catch(() => {})
    if (need('expenseCategory')) api('/expense-categories').then((r) => put('expenseCategory', r, (x) => x.name)).catch(() => {})
    if (need('category') && !lookups.category) api('/products/categories').then((r: string[]) => setLookups((l) => ({ ...l, category: r.map((c, i) => [i, c] as [number, string]) }))).catch(() => {})
    if ((need('seller') || need('user')) && user && ['owner', 'admin'].includes(user.role)) api('/users').then((r) => { put('seller', r); put('user', r) }).catch(() => {})
  }, [def?.id])

  const params = useMemo(() => {
    const p: Record<string, any> = { ...f, q: q || undefined, page: printAll ? 1 : page, pageSize: printAll ? 'all' : pageSize, cols: undefined }
    if (range !== 'custom') { delete p.from; delete p.to; p.range = range }
    return p
  }, [f, q, page, pageSize, range, printAll])
  useEffect(() => {
    if (!def) return
    setLoading(true)
    api('/reports/' + id + '?' + qs(params)).then((r) => { setRes(r); setCols(null) }).catch((e) => toast(e.message, true)).finally(() => setLoading(false))
  }, [id, def?.id, JSON.stringify(params)])

  useEffect(() => {
    if (!printAll || loading || !res) return
    const done = () => { setPrintAll(false); window.removeEventListener('afterprint', done) }
    window.addEventListener('afterprint', done)
    const t = setTimeout(() => window.print(), 250)
    return () => clearTimeout(t)
  }, [printAll, loading, res])
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === '') next.delete(k); else next.set(k, v) }
    if (!routeId) next.set('report', id)
    setSp(next, { replace: true }); setPage(1)
  }
  const pick = (rid: string) => { setRes(null); setPage(1); if (routeId || true) nav('/reports/' + rid) }
  const groups = useMemo(() => [...new Set(catalog.map((d) => d.group))], [catalog])
  const visibleCols: Col[] = useMemo(() => (res ? res.columns.filter((c: Col) => !cols || cols.includes(c.key)) : []), [res, cols])

  async function exportAs(format: 'xlsx' | 'pdf' | 'csv') {
    try {
      const p = { ...params, page: undefined, pageSize: undefined, format, cols: cols?.join(',') }
      await openAuthed(`/reports/${id}/export?${qs(p)}`, format === 'pdf' ? {} : { download: `${id}.${format}` })
    } catch (e: any) { toast(e.message, true) }
  }
  const onRow = (r: any) => { if (r.link) nav(r.link) }
  const sections = res?.sections as { title: string; columns: Col[]; rows: any[]; totals?: any }[] | undefined

  return (
    <>
      <div className="head"><div><h1>Reportes</h1><span className="muted">{res?.title ?? 'Ventas, caja, compras, deudas e inventario'} {res?.subtitle ? `· ${res.subtitle}` : ''}</span></div>
        <div className="row no-print">
          {res?.canExport && <><button onClick={() => exportAs('xlsx')}>Excel</button><button onClick={() => exportAs('pdf')}>PDF</button><button onClick={() => exportAs('csv')}>CSV</button></>}
          <button onClick={() => setPrintAll(true)}>Imprimir</button>
        </div>
      </div>

      <div className="report-layout">
        <nav className="report-nav card no-print" aria-label="Reportes">
          {groups.map((g) => (
            <Fragment key={g}>
              <div className="group">{g}</div>
              {catalog.filter((d) => d.group === g).map((d) => <button key={d.id} className={d.id === id ? 'on' : ''} onClick={() => pick(d.id)}>{d.title}</button>)}
            </Fragment>
          ))}
        </nav>

        <div className="stack" style={{ minWidth: 0 }}>
          {def && (
            <div className="card no-print">
              <div className="toolbar" style={{ marginBottom: 0 }}>
                {def.filters.includes('period') && <>
                  <Field label="Período"><select value={range} onChange={(e) => e.target.value === 'custom' ? set({ range: undefined, from: f.from ?? '', to: f.to ?? '' }) : set({ range: e.target.value, from: undefined, to: undefined })}>{RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                  {range === 'custom' && <><Field label="Desde"><input type="date" value={f.from ?? ''} onChange={(e) => set({ from: e.target.value })} /></Field><Field label="Hasta"><input type="date" value={f.to ?? ''} onChange={(e) => set({ to: e.target.value })} /></Field></>}
                </>}
                {def.filters.includes('asOf') && <Field label="A la fecha"><input type="date" value={f.asOf ?? ''} onChange={(e) => set({ asOf: e.target.value })} /></Field>}
                {def.dateFields && <Field label="Fecha analizada"><select value={f.dateField ?? def.dateFields[0].key} onChange={(e) => set({ dateField: e.target.value })}>{def.dateFields.map((d: any) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></Field>}
                {def.filters.filter((k: string) => OPTS[k]).map((k: string) => (
                  <Field key={k} label={LABELS[k] ?? k}><select value={f[k] ?? ''} onChange={(e) => set({ [k]: e.target.value })}><option value="">Todos</option>{OPTS[k].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
                ))}
                {def.filters.filter((k: string) => NUMERIC_ID.includes(k) && lookups[k]).map((k: string) => (
                  <Field key={k} label={LABELS[k] ?? k}><select value={f[k] ?? ''} onChange={(e) => set({ [k]: e.target.value })}><option value="">Todos</option>{lookups[k].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
                ))}
                {def.filters.includes('category') && lookups.category && <Field label="Categoría"><select value={f.category ?? ''} onChange={(e) => set({ category: e.target.value })}><option value="">Todas</option>{lookups.category.map(([, l]) => <option key={l}>{l}</option>)}</select></Field>}
                {def.filters.includes('overdue') && <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={f.overdue === '1'} onChange={(e) => set({ overdue: e.target.checked ? '1' : undefined })} /> Solo vencidos</label>}
                {def.groups && <Field label="Agrupar por"><select value={f.groupBy ?? ''} onChange={(e) => set({ groupBy: e.target.value })}><option value="">Sin agrupar</option>{Object.entries(def.groups).map(([k, l]) => <option key={k} value={k}>{String(l)}</option>)}</select></Field>}
                {def.views && !f.groupBy && <Field label="Vista"><select value={f.view ?? 'summary'} onChange={(e) => set({ view: e.target.value })}><option value="summary">Resumen</option><option value="detail">Detalle</option></select></Field>}
                <Field label="Buscar"><input placeholder="Número, nombre…" value={f.q ?? ''} onChange={(e) => set({ q: e.target.value })} /></Field>
                <button onClick={() => { setSp(routeId ? new URLSearchParams() : new URLSearchParams({ report: id })); setPage(1) }}>Limpiar</button>
                {res && <div style={{ position: 'relative' }}><button onClick={() => setShowCols(!showCols)}>Columnas</button>
                  {showCols && <div className="popover" style={{ position: 'absolute', right: 0, top: '110%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 12, zIndex: 20, minWidth: 220, display: 'grid', gap: 6 }}>
                    {res.columns.map((c: Col) => <label key={c.key} className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={!cols || cols.includes(c.key)} onChange={(e) => { const cur = cols ?? res.columns.map((x: Col) => x.key); setCols(e.target.checked ? [...cur, c.key] : cur.filter((k: string) => k !== c.key)) }} />{c.label}</label>)}
                  </div>}</div>}
              </div>
              {res?.filtersText && <p className="muted" style={{ margin: '10px 0 0' }}>Filtros: {res.filtersText}</p>}
            </div>
          )}

          {res?.meta && Object.keys(res.meta).length > 0 && !sections && (
            <div className="chips">{Object.entries(res.meta).filter(([, v]) => typeof v === 'number' || typeof v === 'string').slice(0, 12).map(([k, v]) => <span className="chip" key={k}>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}: <b>{typeof v === 'number' && Math.abs(v) >= 1000 ? gs(v) : String(v)}</b></span>)}</div>
          )}

          <div className="card" style={{ opacity: loading ? 0.6 : 1 }}>
            {!res ? <p className="muted">Cargando…</p> : (
              <>
                <h2 style={{ marginTop: 0 }}>{res.title}</h2>
                <DataTable cols={visibleCols} rows={res.rows} totals={res.totals} onRow={onRow} />
                {res.pagination && res.pagination.pages >= 1 && <Pager page={res.pagination.page} pages={res.pagination.pages} total={res.pagination.total} pageSize={pageSize} onPage={setPage} onSize={(s) => { setPageSize(s); setPage(1) }} />}
              </>
            )}
          </div>
          {sections?.map((s, i) => <div className="card" key={i}><h2 style={{ marginTop: 0 }}>{s.title}</h2><DataTable cols={s.columns} rows={s.rows} totals={s.totals} onRow={onRow} /></div>)}
        </div>
      </div>
    </>
  )
}
