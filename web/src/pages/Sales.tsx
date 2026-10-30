import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, gs, openKude, paymentMethodLabel, useApp } from '../api'
import { EmptyRow, Field, fmtDateTime, Modal, Pager, qs, Status, useAsk, useDebounced, useQuery, NumInput } from '../ui'

function SaleDetail({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const { user, toast } = useApp()
  const ask = useAsk()
  const d = useQuery<any>(`/sales/${id}`)
  const [ret, setRet] = useState<any>(null)
  const s = d.data
  const canVoid = ['owner', 'admin'].includes(user!.role)
  if (!s) return <Modal title="Venta" onClose={onClose}><p className="muted">Cargando…</p></Modal>
  async function doVoid() {
    const reason = await ask({ title: `Anular la venta ${s.number}`, reason: true, confirm: 'Anular venta', danger: true })
    if (!reason) return
    try { await api(`/sales/${id}/void`, { body: { reason } }); toast('Venta anulada'); d.reload(); onChange() } catch (e: any) { toast(e.message, true) }
  }
  async function doReturn() {
    const items = Object.entries(ret.qty).filter(([, n]) => Number(n) > 0).map(([saleItemId, qty]) => ({ saleItemId: Number(saleItemId), qty: Number(qty) }))
    try { const r = await api(`/sales/${id}/returns`, { body: { items, reason: ret.reason, restock: ret.restock, refundMethod: ret.method } }); toast(`Devolución registrada por ${gs(r.refunded ?? r.total ?? 0)}`); setRet(null); d.reload(); onChange() } catch (e: any) { toast(e.message, true) }
  }
  return (
    <Modal title={`Comprobante ${s.number}`} onClose={onClose} wide="xl" footer={<>
      <button onClick={() => window.print()}>Imprimir</button>
      {s.status !== 'void' && s.return_status !== 'full' && <button onClick={() => setRet({ qty: {}, reason: '', restock: true, method: 'cash' })}>Devolución</button>}
      {canVoid && s.status !== 'void' && <button className="danger" onClick={doVoid}>Anular venta</button>}</>}>
      <div className="print-area stack">
        <p className="muted">{fmtDateTime(s.created_at)} · {s.user_name} · {s.customer_name ?? 'Consumidor final'} {s.status === 'void' && <span className="pill bad">Anulada</span>}{s.return_status !== 'none' && s.status !== 'void' && <span className="pill warn" style={{ marginLeft: 6 }}>{s.return_status === 'full' ? 'Devuelta' : 'Devolución parcial'}</span>}</p>
        <table><thead><tr><th>Producto</th><th className="num">Cant.</th><th className="num">Precio</th><th className="num">Desc.</th><th className="num">Total</th></tr></thead>
          <tbody>{s.items.map((i: any) => <tr key={i.id}><td>{i.name}{i.promo_label && <span className="pill ok" style={{ marginLeft: 6 }}>{i.promo_label}</span>}{i.list_price && Number(i.list_price) !== Number(i.unit_price) && <div className="muted">Precio de lista {gs(i.list_price)}</div>}{i.returned_qty > 0 && <div className="muted">Devueltos: {i.returned_qty}</div>}</td><td className="num">{i.qty}</td><td className="num">{gs(i.unit_price)}</td><td className="num">{Number(i.discount) ? gs(i.discount) : ''}</td><td className="num">{gs(i.total)}</td></tr>)}</tbody></table>
        {Number(s.discount) > 0 && <p className="num">Descuento general: {gs(s.discount)}{s.discount_reason ? ` — ${s.discount_reason}` : ''}</p>}
        <p className="num total" style={{ fontSize: 22 }}>Total {gs(s.total)}</p>
        <p className="muted num">Pagos: {s.payments.filter((p: any) => p.kind === 'sale').map((p: any) => `${paymentMethodLabel(p.method)} ${gs(p.amount)}`).join(' · ') || '—'}{s.credit_amount > 0 && ` · a crédito ${gs(s.credit_amount)}`}{Number(s.change_given) > 0 && ` · vuelto ${gs(s.change_given)}`}</p>
        {!!s.installments?.length && <><h3>Cuotas</h3><table><tbody>{s.installments.map((i: any) => <tr key={i.id}><td>Cuota {i.number}</td><td>{new Date(i.due_date).toLocaleDateString('es-PY')}</td><td className="num">{gs(i.amount)}</td><td><Status value={i.status} label={i.status === 'open' ? 'Pendiente' : 'Pagada'} /></td></tr>)}</tbody></table></>}
        {!!s.returns?.length && <><h3>Devoluciones</h3><table><tbody>{s.returns.map((r: any) => <tr key={r.id}><td>{fmtDateTime(r.created_at)}</td><td>{r.reason}</td><td>{r.user_name}</td><td className="num">{gs(r.total)}</td></tr>)}</tbody></table></>}
        {s.status === 'void' && <p className="muted">Motivo de anulación: {s.void_reason}</p>}
        {!!s.invoices?.length && <div className="no-print"><h3>Facturación electrónica</h3>
          {s.invoices.map((i: any) => <div key={i.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <span>{i.kind === 'invoice' ? 'Factura' : 'Nota de crédito'} <b>{i.provider_number ? `N.º ${i.provider_number}` : i.number}</b> <span className={'pill ' + (i.status === 'approved' ? 'ok' : i.status === 'rejected' ? 'bad' : 'warn')}>{i.status === 'approved' ? 'Aprobada' : i.status === 'rejected' ? 'Rechazada' : 'Pendiente'}</span>{i.error && <div className="muted">{i.error}</div>}</span>
            {i.cdc && <button className="small" onClick={() => openKude(i.id).catch((e) => toast(e.message, true))}>Comprobante</button>}
          </div>)}
          {s.status === 'void' && s.invoices.some((i: any) => i.kind === 'credit_note') && <p className="muted" style={{ marginTop: 8 }}>La factura se anuló con una nota de crédito electrónica; el monto se descontó del movimiento de ventas.</p>}
        </div>}
      </div>
      {ret && <Modal title="Devolución de mercadería" onClose={() => setRet(null)} wide footer={<><button onClick={() => setRet(null)}>Cancelar</button><button className="primary" disabled={ret.reason.length < 3 || !Object.values(ret.qty).some((n) => Number(n) > 0)} onClick={doReturn}>Registrar devolución</button></>}>
        <table><thead><tr><th>Producto</th><th className="num">Vendido</th><th className="num">Ya devuelto</th><th className="num">Devolver</th></tr></thead>
          <tbody>{s.items.map((i: any) => <tr key={i.id}><td>{i.name}</td><td className="num">{i.qty}</td><td className="num">{i.returned_qty}</td><td className="num"><NumInput min={0} max={i.qty - i.returned_qty} style={{ width: 80 }} value={ret.qty[i.id] ?? 0} onChange={(e) => setRet({ ...ret, qty: { ...ret.qty, [i.id]: Math.min(i.qty - i.returned_qty, Math.max(0, Number(e.target.value))) } })} /></td></tr>)}</tbody></table>
        <div className="form"><Field label="Motivo" span={2}><input value={ret.reason} onChange={(e) => setRet({ ...ret, reason: e.target.value })} /></Field>
          <Field label="Devolver el dinero en"><select value={ret.method} onChange={(e) => setRet({ ...ret, method: e.target.value })}><option value="cash">Efectivo</option><option value="transfer">Transferencia</option><option value="card">Tarjeta</option><option value="qr">QR</option></select></Field></div>
        <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={ret.restock} onChange={(e) => setRet({ ...ret, restock: e.target.checked })} /> La mercadería vuelve al stock (desmarcá si está dañada)</label>
      </Modal>}
    </Modal>
  )
}

export default function Sales() {
  const [sp, setSp] = useSearchParams()
  const [f, setF] = useState({ from: '', to: '', q: '' })
  const q = useDebounced(f.q)
  const [page, setPage] = useState(1)
  const list = useQuery<any[]>('/sales?' + qs({ from: f.from, to: f.to ? f.to + 'T23:59:59' : '', limit: 300 }))
  const [open, setOpen] = useState<number | null>(sp.get('open') ? Number(sp.get('open')) : null)
  const rows = (list.data ?? []).filter((s) => !q || [s.number, s.customer_name, s.user_name].some((v) => String(v ?? '').toLowerCase().includes(q.toLowerCase())))
  const size = 30
  const view = rows.slice((page - 1) * size, page * size)
  return (
    <>
      <div className="head"><div><h1>Ventas</h1><span className="muted">{rows.length} ventas · para análisis y exportación usá Reportes</span></div></div>
      <div className="card">
        <div className="toolbar"><Field label="Buscar"><input value={f.q} onChange={(e) => { setF({ ...f, q: e.target.value }); setPage(1) }} placeholder="N.º, cliente, cajero" /></Field><Field label="Desde"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field><Field label="Hasta"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field></div>
        <div className="table-wrap"><table><thead><tr><th>N.º</th><th>Fecha</th><th>Canal</th><th>Cliente</th><th>Usuario</th><th className="num">Total</th><th>Estado</th></tr></thead>
          <tbody>{view.map((s) => <tr key={s.id} className="clickable" onClick={() => setOpen(s.id)}><td><b>{s.number}</b></td><td>{fmtDateTime(s.created_at)}</td><td>{{ pos: 'Mostrador', web: 'Tienda', whatsapp: 'WhatsApp' }[s.channel as string] ?? s.channel}</td><td>{s.customer_name ?? '—'}</td><td>{s.user_name}</td><td className="num">{gs(s.total)}</td>
            <td><span className={'pill ' + (s.status === 'void' ? 'bad' : s.return_status !== 'none' ? 'warn' : 'ok')}>{s.status === 'void' ? 'Anulada' : s.return_status === 'full' ? 'Devuelta' : s.return_status === 'partial' ? 'Devolución parcial' : 'Completada'}</span></td></tr>)}
            {!view.length && <EmptyRow cols={7} text="Sin ventas" />}</tbody></table></div>
        <Pager page={page} pages={Math.max(1, Math.ceil(rows.length / size))} total={rows.length} pageSize={size} onPage={setPage} />
      </div>
      {open && <SaleDetail id={open} onClose={() => { setOpen(null); if (sp.get('open')) setSp({}) }} onChange={list.reload} />}
    </>
  )
}
