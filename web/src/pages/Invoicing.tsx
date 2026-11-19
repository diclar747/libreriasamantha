import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, gs, openKude, paymentMethodLabel, useApp } from '../api'
import ReceptorPicker from '../components/ReceptorPicker'
import { EmptyRow, Field, fmtDateTime, Kpi, Modal, Money, NumInput, Pager, qs, Tabs, today, useDebounced, useQuery } from '../ui'

const STATUS: Record<string, [string, string]> = {
  approved: ['Aprobado', 'ok'], rejected: ['Rechazado', 'bad'], pending: ['Pendiente', 'warn'], cancelled: ['Cancelado', ''],
}
const KIND: Record<string, string> = { invoice: 'Factura', credit_note: 'Nota de crédito', debit_note: 'Nota de débito' }
const pill = (s: string) => <span className={'pill ' + (STATUS[s]?.[1] ?? '')}>{STATUS[s]?.[0] ?? s}</span>
const docNo = (i: any) => i.provider_number ? `N.º ${i.provider_number}` : i.number

// Rangos rápidos (hora de Paraguay).
function range(k: string): { from: string; to: string } {
  const t = today(), [y, m] = t.split('-').map(Number)
  const ym = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}`
  if (k === 'today') return { from: t, to: t }
  if (k === 'month') return { from: `${ym(y, m)}-01`, to: t }
  if (k === 'prev') { const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; const last = new Date(Date.UTC(py, pm, 0)).getUTCDate(); return { from: `${ym(py, pm)}-01`, to: `${ym(py, pm)}-${last}` } }
  if (k === 'year') return { from: `${y}-01-01`, to: t }
  return { from: '', to: '' }
}

const CANCEL_PRESETS: [string, boolean][] = [
  ['Error en los datos del cliente (RUC o nombre)', false],
  ['Error en el importe o en los productos facturados', true],
  ['Venta anulada: el cliente desistió de la compra', true],
  ['Factura emitida por duplicado', false],
]

export default function Invoicing() {
  const { user } = useApp()
  const [sp, setSp] = useSearchParams()
  const [period, setPeriod] = useState('month')
  const [f, setF] = useState({ ...range('month'), kind: '', q: '' })
  const [tab, setTab] = useState<'all' | 'approved' | 'problem' | 'cancelled'>('all')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(30)
  const [open, setOpen] = useState<number | null>(sp.get('open') ? Number(sp.get('open')) : null)
  const [help, setHelp] = useState(false)
  const q = useDebounced(f.q)
  const list = useQuery<any[]>('/invoices?' + qs({ from: f.from, to: f.to, kind: f.kind, q }))
  const sum = useQuery<any>('/invoices/summary?' + qs({ from: f.from, to: f.to }))
  const all = list.data ?? []
  const counts = useMemo(() => ({
    all: all.length, approved: all.filter((i) => i.status === 'approved').length,
    problem: all.filter((i) => i.status === 'rejected' || i.status === 'pending').length, cancelled: all.filter((i) => i.status === 'cancelled').length,
  }), [all])
  const rows = all.filter((i) => tab === 'all' || (tab === 'problem' ? ['rejected', 'pending'].includes(i.status) : i.status === tab))
  const view = rows.slice((page - 1) * size, page * size)

  const g = (kind: string, status?: string) => (sum.data?.groups ?? []).filter((x: any) => x.kind === kind && (!status || x.status === status))
  const tot = (arr: any[]) => ({ count: arr.reduce((a, x) => a + x.count, 0), total: arr.reduce((a, x) => a + x.total, 0) })
  const inv = tot(g('invoice', 'approved')), nc = tot(g('credit_note', 'approved')), nd = tot(g('debit_note', 'approved'))
  const bad = tot([...g('invoice', 'rejected'), ...g('invoice', 'pending'), ...g('credit_note', 'rejected'), ...g('credit_note', 'pending'), ...g('debit_note', 'rejected'), ...g('debit_note', 'pending')])
  const cfg = sum.data?.config
  const reload = () => { list.reload(); sum.reload() }

  function exportCsv() {
    const head = ['Fecha', 'Tipo', 'Número SET', 'Número interno', 'Cliente', 'RUC', 'Total', 'Gravado 10%', 'Gravado 5%', 'Exento', 'Estado', 'CDC', 'Venta', 'Motivo/Error']
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = rows.map((i) => [fmtDateTime(i.created_at), KIND[i.kind], i.provider_number, i.number, i.customer_name, i.customer_ruc, i.total, i.tax10, i.tax5, i.exempt, STATUS[i.status]?.[0], i.cdc, i.sale_number, i.cancel_reason || i.error || i.reason].map(esc).join(';'))
    const blob = new Blob(['﻿' + [head.map(esc).join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `facturacion_${f.from || 'todo'}_${f.to || ''}.csv`; a.click()
  }

  return (
    <>
      <div className="head"><div><h1>Facturación electrónica</h1>
        <span className="muted">Todas las facturas, notas de crédito y de débito emitidas ante SET. {cfg && (!cfg.enabled
          ? <b style={{ color: 'var(--danger)' }}>La facturación está desactivada: las ventas no generan factura.</b>
          : cfg.mode === 'oietema' ? <>Proveedor OñeTema · empresa <b>{cfg.tenant}</b> · punto {cfg.establishment}-{cfg.point}{!cfg.keyLoaded && <b style={{ color: 'var(--danger)' }}> · falta la clave de la API</b>}</>
            : <b>Modo simulado (no se envía a SET).</b>)}{['owner', 'admin'].includes(user!.role) && <> · <Link to="/settings">Configurar</Link></>}</span></div>
        <div className="row"><button onClick={() => setHelp(!help)}>¿Cómo facturo?</button><button onClick={exportCsv} disabled={!rows.length}>Exportar CSV</button></div>
      </div>

      {help && <div className="card stack" style={{ marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>Cómo funciona la facturación</h3>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
          <li><b>Automática en cada venta.</b> Al cobrar en el Punto de venta (y al confirmarse el pago de un pedido en línea) se emite la factura sola. Sin cliente, sale a <i>Consumidor final</i>.</li>
          <li><b>Factura con RUC:</b> en el Punto de venta, antes de cobrar, escribí el RUC o cédula del cliente y tocá <i>Buscar</i> (lo trae de SET si no está guardado).</li>
          <li><b>Si te piden la factura después</b> o salió con un dato mal: abrí el comprobante acá → <i>Cancelar</i> (dentro de las 48 h) sin anular la venta → <i>Volver a facturar</i> al cliente correcto. Una venta sin factura se factura desde <Link to="/sales">Ventas</Link> → <i>Emitir factura</i>.</li>
          <li><b>Cancelar</b> solo se puede dentro de las <b>48 h</b> de aprobada (regla de SET). Si además anulás la venta, se devuelve el dinero, se repone el stock y el movimiento queda como <i>Anulación de factura</i>.</li>
          <li><b>Pasadas las 48 h</b> se usa <b>Nota de crédito</b>: por devolución de productos, por descuento/bonificación, por crédito incobrable o por la anulación total.</li>
          <li><b>Nota de débito</b> para cobrar de más sobre una factura: intereses por mora, flete o gastos recuperados, ajuste de precio.</li>
          <li>Si SET <b>rechaza</b> un comprobante, aparece en <i>Con problemas</i> con el motivo: corregí el cliente o reintentá.</li>
        </ol>
      </div>}

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Kpi label="Facturas aprobadas" value={gs(inv.total)} sub={`${inv.count} facturas`} tone="ok" />
        <Kpi label="Notas de crédito" value={gs(nc.total)} sub={`${nc.count} notas · restan`} tone={nc.count ? 'warn' : undefined} />
        <Kpi label="Notas de débito" value={gs(nd.total)} sub={`${nd.count} notas · suman`} />
        <Kpi label="Con problemas" value={bad.count} sub={bad.count ? 'rechazados o pendientes' : 'todo enviado'} tone={bad.count ? 'bad' : 'ok'} />
      </div>

      <div className="card">
        <div className="toolbar">
          <Field label="Período"><select value={period} onChange={(e) => { setPeriod(e.target.value); if (e.target.value !== 'custom') setF({ ...f, ...range(e.target.value) }); setPage(1) }}>
            <option value="today">Hoy</option><option value="month">Este mes</option><option value="prev">Mes anterior</option><option value="year">Este año</option><option value="all">Todo</option><option value="custom">Rango…</option></select></Field>
          {period === 'custom' && <><Field label="Desde"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field><Field label="Hasta"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field></>}
          <Field label="Tipo"><select value={f.kind} onChange={(e) => { setF({ ...f, kind: e.target.value }); setPage(1) }}><option value="">Todos</option><option value="invoice">Facturas</option><option value="credit_note">Notas de crédito</option><option value="debit_note">Notas de débito</option></select></Field>
          <Field label="Buscar"><input value={f.q} onChange={(e) => { setF({ ...f, q: e.target.value }); setPage(1) }} placeholder="N.º, cliente, RUC, CDC, venta" /></Field>
        </div>
        <Tabs value={tab} onChange={(t) => { setTab(t); setPage(1) }} tabs={[['all', 'Todos', counts.all], ['approved', 'Aprobados', counts.approved], ['problem', 'Con problemas', counts.problem], ['cancelled', 'Cancelados', counts.cancelled]]} />
        <div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Documento</th><th>Cliente</th><th>Venta</th><th className="num">Total</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {!list.data && <EmptyRow cols={7} text="Cargando…" />}
            {view.map((i) => (
              <tr key={i.id} className="clickable" onClick={() => setOpen(i.id)}>
                <td>{fmtDateTime(i.created_at)}</td>
                <td><b>{KIND[i.kind]}</b><div className="muted">{docNo(i)}{i.related_number && ` · de factura ${i.related_provider_number ?? i.related_number}`}</div></td>
                <td>{i.customer_name}<div className="muted">{i.customer_ruc || 'Sin RUC'}</div></td>
                <td>{i.sale_number ?? '—'}{i.sale_status === 'void' && <div><span className="pill bad">venta anulada</span></div>}</td>
                <td className="num">{i.kind === 'credit_note' ? '−' : ''}{gs(i.total)}</td>
                <td>{pill(i.status)}
                  {i.status === 'approved' && i.kind === 'invoice' && i.cancel_window_open && <div className="muted" style={{ fontSize: 12 }}>cancelable {i.cancel_hours_left} h más</div>}
                  {(i.error && i.status !== 'approved') && <div className="muted" style={{ fontSize: 12, maxWidth: 260 }}>{i.error}</div>}
                  {i.status === 'cancelled' && i.cancel_reason && <div className="muted" style={{ fontSize: 12, maxWidth: 260 }}>{i.cancel_reason}</div>}</td>
                <td className="num" onClick={(e) => e.stopPropagation()}>{i.cdc && <button className="small" onClick={() => openKude(i.id).catch(() => {})}>🖨</button>}</td>
              </tr>
            ))}
            {list.data && !view.length && <EmptyRow cols={7} text="No hay comprobantes con estos filtros" />}
          </tbody></table></div>
        <Pager page={page} pages={Math.max(1, Math.ceil(rows.length / size))} total={rows.length} pageSize={size} onPage={setPage} onSize={(s) => { setSize(s); setPage(1) }} />
      </div>
      {open && <InvoiceDetail id={open} onOpen={setOpen} onClose={() => { setOpen(null); if (sp.get('open')) setSp({}) }} onChange={reload} />}
    </>
  )
}

// ---------------------------------------------------------------- Detalle de un comprobante y sus acciones
function InvoiceDetail({ id, onClose, onChange, onOpen }: { id: number; onClose: () => void; onChange: () => void; onOpen: (id: number) => void }) {
  const { user, toast } = useApp()
  const d = useQuery<any>(`/invoices/${id}`, [id])
  const [modal, setModal] = useState<null | 'cancel' | 'credit' | 'debit' | 'reinvoice' | 'receptor'>(null)
  const [busy, setBusy] = useState(false)
  const i = d.data
  const manage = ['owner', 'admin', 'accountant'].includes(user!.role)
  const issue = manage || ['cashier', 'seller'].includes(user!.role)
  const done = (msg: string) => { toast(msg); setModal(null); d.reload(); onChange() }

  if (!i) return <Modal title="Comprobante" onClose={onClose}><p className="muted">Cargando…</p></Modal>
  const isInv = i.kind === 'invoice'
  const saleOk = i.sale?.status === 'completed'
  const canCancel = manage && isInv && i.status === 'approved' && i.cancel_window_open && !i.has_active_notes
  const canNotes = manage && isInv && i.status === 'approved' && saleOk && i.is_active
  const canRetry = ['rejected', 'pending'].includes(i.status) && !(isInv && i.sale?.status === 'void')
  const canReceptor = issue && isInv && ['rejected', 'pending'].includes(i.status) && saleOk
  const canReinvoice = issue && isInv && i.status === 'cancelled' && saleOk && Number(i.sale?.returned_total) === 0 && !i.siblings?.some((s: any) => s.status !== 'cancelled')

  async function retry() {
    setBusy(true)
    try { const r = await api(`/invoices/${id}/retry`, { body: {} }); r.status === 'approved' ? done('Aprobado por SET') : (toast(`Sigue ${STATUS[r.status]?.[0].toLowerCase()}: ${r.error ?? ''}`, true), d.reload(), onChange()) }
    catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }

  return (
    <Modal title={`${KIND[i.kind]} ${docNo(i)}`} onClose={onClose} wide="xl" footer={<>
      {i.cdc && <><button onClick={() => openKude(i.id).catch((e) => toast(e.message, true))}>🖨 Imprimir A4</button><button onClick={() => openKude(i.id, 'ticket').catch((e) => toast(e.message, true))}>Ticket</button></>}
      {canRetry && <button onClick={retry} disabled={busy}>{busy ? 'Enviando…' : 'Reintentar envío'}</button>}
      {canReceptor && <button onClick={() => setModal('receptor')}>Cambiar cliente y reenviar</button>}
      {canReinvoice && <button className="primary" onClick={() => setModal('reinvoice')}>Volver a facturar</button>}
      {canNotes && <><button onClick={() => setModal('debit')}>Nota de débito</button><button onClick={() => setModal('credit')}>Nota de crédito</button></>}
      {canCancel && <button className="danger" onClick={() => setModal('cancel')}>Cancelar factura</button>}
    </>}>
      <div className="stack">
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{pill(i.status)}
          {isInv && i.status === 'approved' && (i.has_active_notes
            ? <span className="muted">Tiene notas emitidas: ya no se cancela, se ajusta con notas de crédito o débito.</span>
            : i.cancel_window_open
              ? <span className="muted">Se puede cancelar durante {i.cancel_hours_left} h más (hasta {fmtDateTime(i.cancel_deadline)}).</span>
              : <span className="muted">Pasaron las 48 h: para dejarla sin efecto o corregirla, usá una nota de crédito.</span>)}
        </div>
        {i.error && i.status !== 'approved' && <div className="card" style={{ borderColor: 'var(--danger)', padding: 12 }}><b>Respuesta de SET:</b> {i.error}</div>}
        {i.status === 'cancelled' && <div className="card" style={{ padding: 12 }}><b>Cancelado</b> el {fmtDateTime(i.cancelled_at)}{i.cancelled_by_name && ` por ${i.cancelled_by_name}`}. Motivo: {i.cancel_reason}{i.cancel_protocol && <> · Protocolo SIFEN <b>{i.cancel_protocol}</b></>}</div>}
        <dl className="dl">
          <div><dt>Número SET</dt><dd>{i.provider_number ?? '—'}</dd></div>
          <div><dt>Número interno</dt><dd>{i.number}</dd></div>
          <div><dt>Emitido</dt><dd>{fmtDateTime(i.created_at)}{i.created_by_name && ` · ${i.created_by_name}`}</dd></div>
          <div><dt>Aprobado</dt><dd>{i.approved_at ? fmtDateTime(i.approved_at) : '—'}</dd></div>
          <div><dt>Cliente</dt><dd>{i.customer_name}<br /><span className="muted">{i.customer_ruc || 'Consumidor final (sin RUC)'}</span></dd></div>
          <div><dt>Total</dt><dd><b>{gs(i.total)}</b><br /><span className="muted">Grav. 10% {gs(i.tax10)} · 5% {gs(i.tax5)} · Exento {gs(i.exempt)}</span></dd></div>
          {i.sale && <div><dt>Venta</dt><dd><Link to={`/sales?open=${i.sale.id}`}>{i.sale.number}</Link> {i.sale.status === 'void' && <span className="pill bad">anulada</span>}{Number(i.sale.returned_total) > 0 && <span className="muted"> · acreditado {gs(i.sale.returned_total)}</span>}</dd></div>}
          {i.related_invoice_id && <div><dt>Factura original</dt><dd><a href="#" onClick={(e) => { e.preventDefault(); onOpen(i.related_invoice_id) }}>{i.related_provider_number ?? i.related_number}</a></dd></div>}
          {i.motive && <div><dt>Motivo</dt><dd>{i.motive} — {i.motive_label}{i.reason && <><br /><span className="muted">{i.reason}</span></>}</dd></div>}
          <div style={{ gridColumn: '1 / -1' }}><dt>CDC</dt><dd style={{ wordBreak: 'break-all', fontFamily: 'monospace' }}>{i.cdc ?? '—'} {i.cdc && <button className="small" onClick={() => navigator.clipboard?.writeText(i.cdc).then(() => toast('CDC copiado'))}>Copiar</button>}</dd></div>
        </dl>

        <h3 style={{ margin: '6px 0 0' }}>Detalle</h3>
        <table><thead><tr><th>Descripción</th><th className="num">Cant.</th><th className="num">IVA</th><th className="num">Importe</th></tr></thead><tbody>
          {(Array.isArray(i.lines) && i.lines.length ? i.lines.map((l: any, k: number) => ({ k, name: l.description, qty: l.qty, tax: l.tax_rate, total: l.amount }))
            : i.items.map((it: any) => ({ k: it.id, name: it.name, qty: it.qty, tax: it.tax_rate, total: it.total }))).map((l: any) =>
            <tr key={l.k}><td>{l.name}</td><td className="num">{l.qty}</td><td className="num">{l.tax ? l.tax + '%' : 'Exento'}</td><td className="num">{gs(l.total)}</td></tr>)}
          {!i.lines?.length && Number(i.sale?.discount) > 0 && <tr><td colSpan={3} className="muted">Descuento general prorrateado</td><td className="num">−{gs(i.sale.discount)}</td></tr>}
        </tbody></table>

        {(!!i.notes?.length || !!i.siblings?.length) && <><h3 style={{ margin: '6px 0 0' }}>Documentos relacionados</h3>
          <table><tbody>{[...i.notes, ...i.siblings].map((n: any) => <tr key={n.id} className="clickable" onClick={() => onOpen(n.id)}>
            <td>{KIND[n.kind]} <b>{docNo(n)}</b>{n.motive_label && <div className="muted">{n.motive_label}</div>}</td><td>{fmtDateTime(n.created_at)}</td>
            <td className="num">{n.kind === 'credit_note' ? '−' : ''}{gs(n.total)}</td><td>{pill(n.status)}</td></tr>)}</tbody></table></>}
      </div>

      {modal === 'cancel' && <CancelModal inv={i} onClose={() => setModal(null)} onDone={(r) => {
        done(r.sale_voided ? 'Factura cancelada en SET y venta anulada (dinero y stock devueltos)' : 'Factura cancelada en SET')
        if (r.warning) toast(r.warning, true)
      }} />}
      {modal === 'credit' && <CreditModal inv={i} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'debit' && <DebitModal inv={i} onClose={() => setModal(null)} onDone={done} />}
      {(modal === 'reinvoice' || modal === 'receptor') && <Modal title={modal === 'reinvoice' ? `Volver a facturar la venta ${i.sale?.number}` : 'Cambiar el cliente y reenviar'} onClose={() => setModal(null)} wide>
        <p className="muted" style={{ marginTop: 0 }}>{modal === 'reinvoice' ? 'Se emite una factura nueva por el total de la venta, al cliente que elijas.' : 'Se corrige el cliente de esta factura y se vuelve a enviar a SET.'}</p>
        <ReceptorPicker busy={busy} onPick={async (c) => {
          setBusy(true)
          try {
            const r = modal === 'reinvoice'
              ? await api(`/sales/${i.sale.id}/invoice`, { body: { customerId: c?.id ?? null } })
              : await api(`/invoices/${id}/receptor`, { method: 'PUT', body: { customerId: c?.id ?? null } })
            if (r.status === 'approved') { done('Factura aprobada por SET'); if (modal === 'reinvoice') onOpen(r.id) }
            else { toast(`SET no la aprobó: ${r.error ?? 'quedó pendiente'}`, true); setModal(null); d.reload(); onChange(); if (modal === 'reinvoice') onOpen(r.id) }
          } catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
        }} />
      </Modal>}
    </Modal>
  )
}

function CancelModal({ inv, onClose, onDone }: { inv: any; onClose: () => void; onDone: (r: any) => void }) {
  const { toast } = useApp()
  const [preset, setPreset] = useState(0)
  const [other, setOther] = useState('')
  const [voidSale, setVoidSale] = useState(CANCEL_PRESETS[0][1])
  const [busy, setBusy] = useState(false)
  const saleVoid = inv.sale?.status === 'void'
  const reason = preset === -1 ? other.trim() : CANCEL_PRESETS[preset][0] + (other.trim() ? `. ${other.trim()}` : '')
  async function go() {
    setBusy(true)
    try { onDone(await api(`/invoices/${inv.id}/cancel`, { body: { reason, voidSale: !saleVoid && voidSale } })) }
    catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }
  return (
    <Modal title={`Cancelar la factura ${docNo(inv)}`} onClose={onClose} wide footer={<>
      <button onClick={onClose}>Volver</button>
      <button className="danger" disabled={busy || reason.length < 5 || (voidSale && !saleVoid && !!inv.void_block)} onClick={go}>{busy ? 'Enviando a SET…' : 'Cancelar en SET'}</button></>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Se envía el evento de <b>cancelación</b> a SET (queda {inv.cancel_hours_left} h de plazo). No se puede deshacer.</p>
        <div className="stack" style={{ gap: 6 }}><b>Motivo</b>
          {CANCEL_PRESETS.map(([label, v], k) => <label key={k} className="inline"><input type="radio" style={{ width: 'auto' }} checked={preset === k} onChange={() => { setPreset(k); setVoidSale(v) }} /> {label}</label>)}
          <label className="inline"><input type="radio" style={{ width: 'auto' }} checked={preset === -1} onChange={() => setPreset(-1)} /> Otro motivo</label>
          <textarea rows={2} value={other} onChange={(e) => setOther(e.target.value)} placeholder={preset === -1 ? 'Escribí el motivo (mínimo 5 letras)' : 'Detalle opcional'} />
        </div>
        {saleVoid ? <p className="muted">La venta {inv.sale?.number} ya está anulada: solo se cancela el documento fiscal.</p> : <>
          <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={voidSale} onChange={(e) => setVoidSale(e.target.checked)} /> <span><b>Anular también la venta {inv.sale?.number}</b>: devuelve el dinero cobrado, repone el stock y revierte el crédito. En Dinero queda como <i>Anulación de factura</i>.</span></label>
          {!voidSale && <p className="muted" style={{ margin: 0 }}>La venta queda vigente y <b>sin factura</b>: después tocá <i>Volver a facturar</i> para emitirla al cliente correcto.</p>}
          {voidSale && inv.void_block && <p style={{ color: 'var(--danger)', margin: 0 }}>No se puede anular la venta: {inv.void_block}</p>}
        </>}
      </div>
    </Modal>
  )
}

function CreditModal({ inv, onClose, onDone }: { inv: any; onClose: () => void; onDone: (msg: string) => void }) {
  const { toast } = useApp()
  const remaining = Number(inv.sale.total) - Number(inv.sale.returned_total)
  const mainRate = (() => { const by: Record<number, number> = {}; inv.items.forEach((it: any) => { by[it.tax_rate] = (by[it.tax_rate] ?? 0) + Number(it.total) }); return Number(Object.entries(by).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10) })()
  const [mode, setMode] = useState<'items' | 'amount' | 'total'>('items')
  const [qty, setQty] = useState<Record<number, number>>({})
  const [restock, setRestock] = useState(true)
  const [method, setMethod] = useState(Number(inv.sale.open_debt) > 0 ? 'none' : 'cash')
  const [motive, setMotive] = useState(3)
  const [amount, setAmount] = useState(0)
  const [rate, setRate] = useState<0 | 5 | 10>(mainRate as 0 | 5 | 10)
  const [concept, setConcept] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const debt = Number(inv.sale.open_debt)
  const pickedTotal = inv.items.reduce((a: number, it: any) => a + Math.round(Number(it.total) / it.qty * (qty[it.id] ?? 0)), 0)
  const fullTotal = remaining === Number(inv.sale.total)

  async function go() {
    setBusy(true)
    try {
      if (mode === 'total') {
        const r = await api(`/sales/${inv.sale.id}/void`, { body: { reason } })
        onDone(`Venta anulada. ${r.fiscal?.message ?? ''}`)
      } else if (mode === 'items') {
        const items = Object.entries(qty).filter(([, n]) => n > 0).map(([saleItemId, n]) => ({ saleItemId: Number(saleItemId), qty: n }))
        const r = await api(`/invoices/${inv.id}/credit-note`, { body: { mode: 'items', motive: 2, reason, items, restock, refundMethod: method === 'none' ? 'cash' : method } })
        onDone(r.note ? `Nota de crédito ${r.note.status === 'approved' ? 'aprobada' : r.note.status === 'rejected' ? 'RECHAZADA: ' + (r.note.error ?? '') : 'pendiente'} · devolución ${r.return.number}` : `Devolución ${r.return.number} registrada`)
      } else {
        const r = await api(`/invoices/${inv.id}/credit-note`, { body: { mode: 'amount', motive, reason, concept: concept || MOTIVE_CONCEPT[motive], amount, taxRate: rate, refundMethod: method } })
        onDone(`Nota de crédito aprobada${r.return.applied ? ` · ${gs(r.return.applied)} descontados de la deuda` : ''}${r.return.refunded ? ` · ${gs(r.return.refunded)} devueltos` : ''}`)
      }
    } catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }
  const valid = reason.trim().length >= 3 && (mode === 'total' ? !inv.void_block && fullTotal : mode === 'items' ? pickedTotal > 0 : amount > 0 && amount <= remaining)

  return (
    <Modal title={`Nota de crédito sobre ${docNo(inv)}`} onClose={onClose} wide="xl" footer={<>
      <button onClick={onClose}>Volver</button>
      <button className="primary" disabled={busy || !valid} onClick={go}>{busy ? 'Emitiendo…' : mode === 'total' ? 'Anular venta y factura' : 'Emitir nota de crédito'}</button></>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Queda por acreditar de esta venta: <b>{gs(remaining)}</b>{debt > 0 && <> · deuda pendiente del cliente en esta venta: <b>{gs(debt)}</b> (se descuenta primero de ahí)</>}.</p>
        <Tabs value={mode} onChange={setMode} tabs={[['items', 'Devolución de productos'], ['amount', 'Descuento, bonificación o incobrable'], ['total', 'Anular todo']]} />

        {mode === 'items' && <>
          <table><thead><tr><th>Producto</th><th className="num">Vendido</th><th className="num">Ya devuelto</th><th className="num">Devolver</th></tr></thead><tbody>
            {inv.items.map((it: any) => <tr key={it.id}><td>{it.name}</td><td className="num">{it.qty}</td><td className="num">{it.returned_qty}</td>
              <td className="num"><NumInput min={0} max={it.qty - it.returned_qty} style={{ width: 80 }} value={qty[it.id] ?? 0} disabled={it.qty - it.returned_qty <= 0}
                onChange={(e) => setQty({ ...qty, [it.id]: Math.min(it.qty - it.returned_qty, Math.max(0, Number(e.target.value) || 0)) })} /></td></tr>)}
          </tbody></table>
          <p className="num" style={{ margin: 0 }}>Importe aproximado: <b>{gs(pickedTotal)}</b></p>
          <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={restock} onChange={(e) => setRestock(e.target.checked)} /> La mercadería vuelve al stock (desmarcá si está dañada)</label>
          <Field label="Devolver el dinero en"><select value={method === 'none' ? 'cash' : method} onChange={(e) => setMethod(e.target.value)}>{['cash', 'transfer', 'card', 'qr'].map((m) => <option key={m} value={m}>{paymentMethodLabel(m)}</option>)}</select></Field>
        </>}

        {mode === 'amount' && <div className="form">
          <Field label="Motivo (SET)"><select value={motive} onChange={(e) => { setMotive(Number(e.target.value)); setConcept('') }}>
            {[3, 4, 5, 1].map((m) => <option key={m} value={m}>{m} — {inv.motives[m]}</option>)}</select></Field>
          <Field label="Concepto que figura en la nota"><input value={concept} placeholder={MOTIVE_CONCEPT[motive]} onChange={(e) => setConcept(e.target.value)} /></Field>
          <Field label="Importe (IVA incluido)" hint={`Máximo ${gs(remaining)}`}><Money value={amount} onChange={setAmount} /></Field>
          <Field label="IVA"><select value={rate} onChange={(e) => setRate(Number(e.target.value) as 0 | 5 | 10)}><option value={10}>10%</option><option value={5}>5%</option><option value={0}>Exento</option></select></Field>
          <Field label="El cliente recibe" span={2}><select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="none">{debt > 0 ? 'Solo se descuenta de su deuda (no se devuelve dinero)' : 'Nada en dinero (solo si tiene deuda)'}</option>
            {['cash', 'transfer', 'card', 'qr'].map((m) => <option key={m} value={m}>Devolución en {paymentMethodLabel(m).toLowerCase()}</option>)}</select></Field>
        </div>}

        {mode === 'total' && (fullTotal
          ? <div className="stack"><p style={{ margin: 0 }}>Se <b>anula la venta {inv.sale.number}</b> (dinero, stock y crédito) y se revierte la factura: {inv.cancel_window_open ? 'como está dentro de las 48 h, se cancela en SET.' : 'como pasaron las 48 h, se emite una nota de crédito por el total.'}</p>
            {inv.void_block && <p style={{ color: 'var(--danger)', margin: 0 }}>{inv.void_block}</p>}</div>
          : <p style={{ color: 'var(--danger)', margin: 0 }}>La venta ya tiene devoluciones o notas: acreditá el resto con <i>Devolución</i> o <i>Descuento</i>.</p>)}

        <Field label="Explicación (queda en el historial)"><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: el cliente devolvió el libro en buen estado" /></Field>
      </div>
    </Modal>
  )
}

const MOTIVE_CONCEPT: Record<number, string> = { 1: 'Ajuste de precio', 3: 'Descuento otorgado', 4: 'Bonificación comercial', 5: 'Crédito incobrable', 6: 'Recupero de costo', 7: 'Recupero de gastos (flete/envío)', 8: 'Interés por mora' }

function DebitModal({ inv, onClose, onDone }: { inv: any; onClose: () => void; onDone: (msg: string) => void }) {
  const { toast } = useApp()
  const [motive, setMotive] = useState(8)
  const [concept, setConcept] = useState('')
  const [amount, setAmount] = useState(0)
  const [rate, setRate] = useState<0 | 5 | 10>(10)
  const [settle, setSettle] = useState<'collect' | 'account'>('collect')
  const [method, setMethod] = useState('cash')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const hasCustomer = !!inv.sale.customer_id
  async function go() {
    setBusy(true)
    try {
      await api(`/invoices/${inv.id}/debit-note`, { body: { motive, concept: concept || MOTIVE_CONCEPT[motive], amount, taxRate: rate, settle, method, reason } })
      onDone(settle === 'collect' ? `Nota de débito aprobada y cobrada en ${paymentMethodLabel(method).toLowerCase()}` : 'Nota de débito aprobada y cargada a la cuenta del cliente')
    } catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }
  return (
    <Modal title={`Nota de débito sobre ${docNo(inv)}`} onClose={onClose} wide footer={<>
      <button onClick={onClose}>Volver</button>
      <button className="primary" disabled={busy || amount <= 0 || reason.trim().length < 3} onClick={go}>{busy ? 'Emitiendo…' : 'Emitir nota de débito'}</button></>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Suma un importe a la factura (intereses, flete, ajuste de precio). Primero se emite en SET; el cobro se registra solo si SET la aprueba.</p>
        <div className="form">
          <Field label="Motivo (SET)"><select value={motive} onChange={(e) => { setMotive(Number(e.target.value)); setConcept('') }}>
            {[8, 7, 6].map((m) => <option key={m} value={m}>{m} — {inv.motives[m]}</option>)}</select></Field>
          <Field label="Concepto que figura en la nota"><input value={concept} placeholder={MOTIVE_CONCEPT[motive]} onChange={(e) => setConcept(e.target.value)} /></Field>
          <Field label="Importe (IVA incluido)"><Money value={amount} onChange={setAmount} /></Field>
          <Field label="IVA"><select value={rate} onChange={(e) => setRate(Number(e.target.value) as 0 | 5 | 10)}><option value={10}>10%</option><option value={5}>5%</option><option value={0}>Exento</option></select></Field>
          <Field label="¿Cómo se cobra?"><select value={settle} onChange={(e) => setSettle(e.target.value as any)}>
            <option value="collect">Se cobra ahora</option>{hasCustomer && <option value="account">A cuenta del cliente (cuota a 30 días)</option>}</select></Field>
          {settle === 'collect' && <Field label="Medio de cobro"><select value={method} onChange={(e) => setMethod(e.target.value)}>{['cash', 'transfer', 'card', 'qr'].map((m) => <option key={m} value={m}>{paymentMethodLabel(m)}</option>)}</select></Field>}
        </div>
        <Field label="Explicación (queda en el historial)"><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: 15 días de atraso en la cuota 2" /></Field>
      </div>
    </Modal>
  )
}
