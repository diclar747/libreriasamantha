import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, gs, useApp } from '../api'
import { printOrders, type PrintFormat } from '../printOrders'
import { EmptyRow, Field, fmtDate, fmtDateTime, Kpi, Modal, Money, Pager, plusDays, qs, Status, Tabs, today, useAsk, useDebounced, useQuery } from '../ui'

type Tab = 'pedidos' | 'comprobantes' | 'devoluciones' | 'metricas' | 'entrega' | 'cupones'
const PAY: Record<string, string> = { pending: 'Pago pendiente', in_review: 'Comprobante en revisión', approved: 'Pagado', rejected: 'Pago rechazado', refunded: 'Reembolsado', partially_refunded: 'Reembolso parcial' }
const PAY_KIND: Record<string, string> = { pending: 'warn', in_review: 'warn', approved: 'ok', rejected: 'bad', refunded: '', partially_refunded: '' }
const DEL: Record<string, string> = { pending: 'Sin preparar', preparing: 'En preparación', ready: 'Listo para retirar', dispatched: 'En camino', delivered: 'Entregado', incident: 'Incidencia' }
const NEXT = (o: any): [string, string][] => ({
  pending: [['preparing', 'Preparar']],
  preparing: [[o.delivery_method === 'pickup' ? 'ready' : 'dispatched', o.delivery_method === 'pickup' ? 'Listo para retirar' : 'Despachar']],
  ready: [['delivered', 'Entregado al cliente']], dispatched: [['delivered', 'Entregado']], incident: [['preparing', 'Retomar']], delivered: [],
} as Record<string, [string, string][]>)[o.delivery_status] ?? []

const STAGE_KIND: Record<string, string> = { pending: 'warn', confirmed: 'ok', preparing: 'warn', ready_to_ship: 'ok', shipped: 'warn', ready_pickup: 'ok', delivered: 'ok', picked_up: 'ok', cancelled: 'bad' }

function OrderDetail({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const { user, toast } = useApp()
  const ask = useAsk()
  const d = useQuery<any>(`/orders/${id}`)
  const staff = useQuery<any[]>('/orders-staff')
  const [form, setForm] = useState<null | 'ship' | 'deliver' | 'incident' | 'note' | 'return'>(null)
  const [f, setF] = useState<any>({})
  const o = d.data
  const admin = ['owner', 'admin'].includes(user!.role)
  if (!o) return <Modal title="Pedido" onClose={onClose}><p className="muted">Cargando…</p></Modal>
  const pickup = o.delivery_method === 'pickup'
  const act = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); setForm(null); setF({}); d.reload(); onChange(); return true } catch (e: any) { toast(e.message, true); return false } }
  const move = (status: string, extra: any = {}) => act(() => api(`/orders/${id}/delivery`, { body: { status, ...extra } }), 'Estado actualizado')
  const paid = o.payment_status === 'approved'
  const cod = o.payment_method === 'cod'
  const canPrepare = o.status !== 'cancelled' && (paid || (cod && o.confirmed_at))
  const ds = o.delivery_status
  const btns: [string, string, () => void, string?][] = []
  if (o.status !== 'cancelled') {
    if (cod && !o.confirmed_at) btns.push(['confirm', 'Confirmar pedido', () => act(() => api(`/orders/${id}/confirm`, { body: {} }), 'Pedido confirmado'), 'primary'])
    if (canPrepare && ds === 'pending') btns.push(['prep', 'Iniciar preparación', () => move('preparing'), 'primary'])
    if (canPrepare && ds === 'preparing') btns.push(['ready', pickup ? 'Listo para retirar' : 'Listo para envío', () => move('ready'), 'primary'])
    if (canPrepare && ds === 'ready' && !pickup) btns.push(['ship', 'Registrar despacho', () => { setF({ carrier: '', trackingNumber: '', trackingUrl: '', etaDate: '', visibleNote: '' }); setForm('ship') }, 'primary'])
    if (canPrepare && ((ds === 'ready' && pickup) || ds === 'dispatched')) btns.push(['deliver', pickup ? 'Confirmar retiro' : 'Confirmar entrega', () => { setF({ receivedBy: o.recipient_name ?? o.customer_name }); setForm('deliver') }, 'primary'])
    if (canPrepare && ['preparing', 'ready', 'dispatched'].includes(ds)) btns.push(['inc', 'Registrar incidencia', () => { setF({ reason: '', rescheduleFor: '' }); setForm('incident') }])
    if (canPrepare && ds === 'incident') btns.push(['resume', 'Reprogramar / retomar', () => move(o.dispatched_at ? 'dispatched' : o.ready_at ? 'ready' : 'preparing'), 'primary'])
    if (['pending', 'preparing', 'ready'].includes(ds) || (ds === 'incident' && !o.dispatched_at)) btns.push(['cancel', 'Cancelar pedido', async () => { const reason = await ask({ title: 'Cancelar el pedido', reason: true, confirm: 'Cancelar pedido', danger: true }); if (reason) act(() => api(`/orders/${id}/cancel`, { body: { reason } }), 'Pedido cancelado') }, 'danger'])
  }
  const doPrint = (fmt: PrintFormat) => printOrders([id], fmt).catch((e) => toast(e.message, true))
  const flowIdx = o.flow.findIndex((s: any) => s.stage === o.stage)
  return (
    <Modal title={`Pedido ${o.number} · ${o.customer_name}`} onClose={onClose} wide="xl" footer={<>{btns.map(([k, l, fn, cls]) => <button key={k} className={cls} onClick={fn}>{l}</button>)}<button onClick={() => doPrint('label')}>🖨 Etiqueta de envío</button><button onClick={() => doPrint('sheet')}>🖨 Ficha A4</button><button onClick={onClose}>Cerrar</button></>}>
      {o.late && <div className="warnbox">⏱ Este pedido supera el tiempo configurado de preparación o entrega.</div>}
      {o.exception && <div className="errbox"><b>Excepción:</b> {o.exception}</div>}
      {o.cancel_requested_at && o.status !== 'cancelled' && <div className="warnbox">El cliente pidió cancelar: “{o.cancel_request_reason}”. <button className="small primary" onClick={() => act(() => api(`/orders/${id}/cancel-request/resolve`, { body: { approve: true, response: 'Aceptado' } }), 'Pedido cancelado')}>Aceptar</button> <button className="small" onClick={async () => { const response = await ask({ title: 'Rechazar la cancelación', reason: true, confirm: 'Rechazar' }); if (response) act(() => api(`/orders/${id}/cancel-request/resolve`, { body: { approve: false, response } }), 'Respondido') }}>Rechazar</button></div>}
      {o.status === 'cancelled' && paid && <div className="warnbox">Pedido cancelado con el pago aprobado: falta registrar el reembolso. {admin && <button className="small danger" onClick={async () => { const reason = await ask({ title: 'Reembolsar el pedido', reason: true, confirm: 'Reembolsar', danger: true }); if (reason) act(() => api(`/orders/${id}/refund`, { body: { reason } }), 'Reembolso registrado') }}>Reembolsar</button>}</div>}
      <div className="grid cols-4">
        <Kpi label="Estado" value={<span className={'pill ' + (STAGE_KIND[o.stage] ?? '')}>{o.stage_label}</span>} sub={o.status === 'cancelled' ? o.cancel_reason : undefined} />
        <Kpi label="Pago" value={<span className={'pill ' + PAY_KIND[o.payment_status]}>{PAY[o.payment_status]}</span>} sub={`${o.payment_method === 'transfer' ? 'Transferencia' : o.payment_method === 'cod' ? 'Contra entrega' : 'Tarjeta en línea'} · pagado ${gs(o.paid_amount)}`} />
        <Kpi label="Total" value={gs(o.total)} sub={Number(o.delivery_fee) ? `envío ${gs(o.delivery_fee)}` : undefined} />
        <Kpi label="Responsable" value={<select value={o.assigned_to ?? ''} onChange={(e) => act(() => api(`/orders/${id}/assign`, { body: { userId: e.target.value ? Number(e.target.value) : null } }), 'Responsable asignado')}><option value="">Sin asignar</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>} />
      </div>
      {o.status !== 'cancelled' && <ol className="timeline" style={{ display: 'flex', gap: 18, flexWrap: 'wrap', borderLeft: 0, padding: 0 }}>{o.flow.map((s: any, i: number) => <li key={s.stage} style={{ paddingLeft: 0, opacity: i <= flowIdx ? 1 : .45 }}><b>{i < flowIdx ? '✓ ' : i === flowIdx ? '● ' : '○ '}{s.label}</b></li>)}</ol>}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <h3>Cliente</h3>
          <dl className="dl"><div><dt>Nombre</dt><dd>{o.customer_name}</dd></div><div><dt>Teléfono</dt><dd>{o.phone ?? '—'}</dd></div><div><dt>Correo</dt><dd>{o.email ?? '—'}</dd></div>
            <div><dt>Facturar a</dt><dd>{o.billing_name ?? o.customer_name}<br />{o.billing_ruc ?? o.ruc ?? '—'}</dd></div>
            {o.account && <div><dt>Cuenta de la tienda</dt><dd>{o.account.first_name} {o.account.last_name}{o.account.customer_id && <> · <Link to={`/customers?open=${o.account.customer_id}`}>ver ficha</Link></>}</dd></div>}</dl>
          <h3>{pickup ? 'Retiro en el local' : 'Entrega'}</h3>
          {!pickup ? <dl className="dl"><div><dt>Dirección</dt><dd>{o.address}<br />{[o.neighborhood, o.city_name, o.department].filter(Boolean).join(', ')}{o.address_reference && <><br /><span className="muted">{o.address_reference}</span></>}</dd></div>
            <div><dt>Recibe</dt><dd>{o.recipient_name ?? o.customer_name} {o.recipient_phone ?? ''}</dd></div><div><dt>Tarifa</dt><dd>{gs(o.delivery_fee)} <span className="muted">({o.tariff_source === 'city' ? 'ciudad' : o.tariff_source === 'base' ? 'base' : 'zona'})</span></dd></div>
            {o.carrier && <div><dt>Transporte</dt><dd>{o.carrier}{o.tracking_number ? ` · ${o.tracking_number}` : ''}{o.eta_date ? ` · llega ${fmtDate(o.eta_date)}` : ''}</dd></div>}</dl> : <p className="muted">El cliente retira en el mostrador; no se requiere dirección.</p>}
          {o.received_by && <p>{pickup ? 'Retiró' : 'Recibió'}: <b>{o.received_by}</b> · {fmtDateTime(o.delivered_at)}</p>}
          {!!o.delivery_attempts.length && o.delivery_attempts.map((a: any) => <div key={a.id} className="warnbox">Intento fallido {fmtDateTime(a.at)}: {a.reason}{a.rescheduled_for ? ` · reprogramado ${fmtDate(a.rescheduled_for)}` : ''}</div>)}
        </div>
        <div className="stack">
          <h3>Productos a preparar</h3>
          <table><tbody>{o.items.map((i: any) => <tr key={i.id}><td>{i.image_url ? <img className="thumb" src={i.image_url.replace('s=md', 's=thumb')} alt="" /> : <div className="thumb">▣</div>}</td><td><b>{i.name}</b><div className="muted">{i.code}</div></td><td className="num"><b>{i.qty}</b> × {gs(i.unit_price)}</td></tr>)}
            {Number(o.discount) > 0 && <tr><td /><td>Descuento {o.coupon_code ?? ''}</td><td className="num">−{gs(o.discount)}</td></tr>}<tr className="total"><td /><td>Total</td><td className="num">{gs(o.total)}</td></tr></tbody></table>
          {!!o.proofs?.length && <><h3>Comprobantes</h3><table><tbody>{o.proofs.map((p: any) => <tr key={p.id}><td>{fmtDateTime(p.created_at)}</td><td><Status value={p.status} /></td><td>{p.reference}</td><td>{p.review_reason}</td></tr>)}</tbody></table></>}
          {!!o.invoices?.length && <><h3>Facturas</h3>{o.invoices.map((i: any) => <span className="chip" key={i.id}>{i.kind === 'credit_note' ? 'NC' : 'Factura'} {i.number} · {i.status}</span>)}</>}
        </div>
      </div>

      {!!o.returns.length && <><h3>Devoluciones</h3>{o.returns.map((r: any) => <ReturnRow key={r.id} r={r} order={o} onChange={() => { d.reload(); onChange() }} />)}</>}

      <h3>Notas y mensajes</h3>
      <div className="stack">{o.notes.map((n: any) => <div key={n.id} className={n.visible || n.author_type === 'customer' ? 'okbox' : 'warnbox'}><b>{n.author_type === 'customer' ? 'Cliente' : n.user_name}</b> · {fmtDateTime(n.created_at)} · <span className="muted">{n.author_type === 'customer' ? 'consulta del cliente' : n.visible ? 'visible para el cliente' : 'nota interna'}</span><div>{n.note}</div></div>)}</div>
      <div className="row"><input style={{ flex: 1, minWidth: 220 }} placeholder="Escribir una nota…" value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <button disabled={!f.note || f.note.length < 2} onClick={() => act(() => api(`/orders/${id}/notes`, { body: { note: f.note, visible: false } }), 'Nota interna guardada')}>Nota interna</button>
        <button className="primary" disabled={!f.note || f.note.length < 2} onClick={() => act(() => api(`/orders/${id}/notes`, { body: { note: f.note, visible: true } }), 'Mensaje enviado al cliente')}>Enviar al cliente</button></div>

      <h3>Historial de cambios</h3>
      <ul className="timeline">{[...o.history].reverse().map((h: any) => <li key={h.id}><b>{h.title}</b>{h.from_state && h.to_state && <span className="muted"> ({h.from_state} → {h.to_state})</span>}{!h.visible && <span className="pill" style={{ marginLeft: 6 }}>interno</span>} · {h.user_name ?? h.customer_name ?? 'Sistema'} <span className="muted">{fmtDateTime(h.at)}</span>{h.note && <div className="muted">{h.note}</div>}</li>)}</ul>

      {form === 'ship' && <Modal title="Registrar despacho" onClose={() => setForm(null)} footer={<><button onClick={() => setForm(null)}>Cancelar</button><button className="primary" onClick={() => move('dispatched', { carrier: f.carrier || undefined, trackingNumber: f.trackingNumber || undefined, trackingUrl: f.trackingUrl || undefined, etaDate: f.etaDate || undefined, visibleNote: f.visibleNote || undefined })}>Despachar</button></>}>
        <p className="muted">Para reparto propio no hace falta número de seguimiento.</p>
        <div className="form"><Field label="Repartidor o transportadora"><input value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} /></Field><Field label="N.º de seguimiento"><input value={f.trackingNumber} onChange={(e) => setF({ ...f, trackingNumber: e.target.value })} /></Field>
          <Field label="Enlace de seguimiento"><input value={f.trackingUrl} onChange={(e) => setF({ ...f, trackingUrl: e.target.value })} placeholder="https://…" /></Field><Field label="Fecha estimada de entrega"><input type="date" value={f.etaDate} onChange={(e) => setF({ ...f, etaDate: e.target.value })} /></Field>
          <Field label="Observación para el cliente" span={2}><input value={f.visibleNote} onChange={(e) => setF({ ...f, visibleNote: e.target.value })} /></Field></div></Modal>}
      {form === 'deliver' && <Modal title={pickup ? 'Confirmar retiro' : 'Confirmar entrega'} onClose={() => setForm(null)} footer={<><button onClick={() => setForm(null)}>Cancelar</button><button className="primary" disabled={!f.receivedBy} onClick={() => move('delivered', { receivedBy: f.receivedBy, note: f.note })}>Confirmar</button></>}>
        {cod && !paid && <div className="warnbox">Pago contra entrega: se registra el cobro de <b>{gs(o.total)}</b> en efectivo en tu caja abierta.</div>}
        <Field label={pickup ? '¿Quién retiró?' : '¿Quién recibió?'}><input autoFocus value={f.receivedBy ?? ''} onChange={(e) => setF({ ...f, receivedBy: e.target.value })} /></Field><Field label="Constancia o nota (opcional)"><input value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></Modal>}
      {form === 'incident' && <Modal title="Incidencia de entrega" onClose={() => setForm(null)} footer={<><button onClick={() => setForm(null)}>Cancelar</button><button className="danger" disabled={!f.reason} onClick={() => move('incident', { reason: f.reason, rescheduleFor: f.rescheduleFor || undefined })}>Registrar</button></>}>
        <p className="muted">No marca el pedido como entregado. Se avisa al cliente y se coordina un nuevo intento.</p>
        <Field label="¿Qué pasó?"><input autoFocus value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="No había nadie, dirección incorrecta…" /></Field><Field label="Nuevo intento (fecha)"><input type="date" value={f.rescheduleFor} onChange={(e) => setF({ ...f, rescheduleFor: e.target.value })} /></Field></Modal>}
    </Modal>
  )
}

function ReturnRow({ r, order, onChange }: { r: any; order?: any; onChange: () => void }) {
  const { user, toast } = useApp()
  const ask = useAsk()
  const [f, setF] = useState<any>(null)
  const accounts = useQuery<any[]>('/money-accounts')
  const admin = ['owner', 'admin'].includes(user!.role)
  const run = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); setF(null); onChange() } catch (e: any) { toast(e.message, true) } }
  const label: any = { requested: 'Solicitada', approved: 'Aprobada: esperando el producto', rejected: 'Rechazada', received: 'Producto recibido', refunded: 'Reembolsada', closed: 'Cerrada' }
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>{r.number} {order ? '' : `· pedido ${r.order_number} · ${r.customer_name}`}</b><span className="pill warn">{label[r.status]}</span></div>
      <p style={{ margin: '6px 0' }}>{(r.items ?? []).map((i: any) => `${i.qty} × ${i.name}`).join(', ')} — <span className="muted">{r.reason}</span></p>
      {r.instructions && <p className="muted">Instrucciones: {r.instructions}</p>}{r.admin_response && <p className="muted">Respuesta: {r.admin_response}</p>}{Number(r.refund_amount) > 0 && <p>Reembolsado: <b>{gs(r.refund_amount)}</b></p>}
      <div className="row">
        {r.status === 'requested' && <><button className="small primary" onClick={() => setF({ kind: 'approve', instructions: 'Traé el producto al local con tu factura.', response: '' })}>Aprobar</button><button className="small danger" onClick={async () => { const response = await ask({ title: 'Rechazar la devolución', reason: true, confirm: 'Rechazar', danger: true }); if (response) run(() => api(`/order-returns/${r.id}/reject`, { body: { response } }), 'Devolución rechazada') }}>Rechazar</button></>}
        {r.status === 'approved' && <><button className="small primary" onClick={() => run(() => api(`/order-returns/${r.id}/receive`, { body: { restock: true } }), 'Recibido y apto para volver a stock')}>Recibido en buen estado (vuelve al stock)</button><button className="small" onClick={async () => { const condition = await ask({ title: 'Recibido con observaciones', reason: true, label: 'Estado del producto', confirm: 'Registrar' }); if (condition) run(() => api(`/order-returns/${r.id}/receive`, { body: { restock: false, condition } }), 'Recibido sin reponer stock') }}>Recibido dañado (no vuelve al stock)</button></>}
        {r.status === 'received' && admin && <button className="small primary" onClick={() => setF({ kind: 'refund', method: 'transfer', accountId: '' })}>Registrar reembolso</button>}
      </div>
      {f?.kind === 'approve' && <Modal title="Aprobar devolución" onClose={() => setF(null)} footer={<><button onClick={() => setF(null)}>Cancelar</button><button className="primary" disabled={f.instructions.length < 3} onClick={() => run(() => api(`/order-returns/${r.id}/approve`, { body: { instructions: f.instructions, response: f.response || undefined } }), 'Devolución aprobada')}>Aprobar</button></>}>
        <Field label="Cómo debe devolver el producto"><textarea rows={2} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field><Field label="Respuesta al cliente (opcional)"><input value={f.response} onChange={(e) => setF({ ...f, response: e.target.value })} /></Field></Modal>}
      {f?.kind === 'refund' && <Modal title="Registrar reembolso" onClose={() => setF(null)} footer={<><button onClick={() => setF(null)}>Cancelar</button><button className="primary" onClick={() => run(() => api(`/order-returns/${r.id}/process-refund`, { body: { method: f.method, accountId: f.accountId ? Number(f.accountId) : undefined } }), 'Reembolso registrado')}>Reembolsar</button></>}>
        <p className="muted">Se devuelve el importe de los productos recibidos{r.restock ? ' y la mercadería vuelve al stock vendible' : ' (sin reponer stock: llegó dañada)'}.</p>
        <Field label="Cómo se devuelve el dinero"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="transfer">Transferencia</option><option value="cash">Efectivo (de mi caja)</option><option value="card">Tarjeta</option></select></Field>
        {f.method === 'transfer' && <Field label="Cuenta de origen"><select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>{(accounts.data ?? []).filter((a) => a.kind === 'bank' && a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}</Modal>}
    </div>
  )
}

function Returns({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState('')
  const list = useQuery<any[]>('/order-returns' + (status ? '?status=' + status : ''))
  return (
    <div className="card stack"><div className="toolbar"><Field label="Estado"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todas</option><option value="requested">Por revisar</option><option value="approved">Esperando el producto</option><option value="received">Por reembolsar</option><option value="refunded">Reembolsadas</option><option value="rejected">Rechazadas</option></select></Field></div>
      {(list.data ?? []).map((r) => <ReturnRow key={r.id} r={r} onChange={() => { list.reload(); onChange() }} />)}{!list.data?.length && <p className="muted">No hay devoluciones.</p>}</div>
  )
}

function Metrics() {
  const [range, setRange] = useState({ from: plusDays(-29), to: today() })
  const m = useQuery<any>('/orders/metrics?' + qs(range))
  const d = m.data
  const STG: Record<string, string> = { pending: 'Pendientes', confirmed: 'Confirmados', preparing: 'En preparación', ready_to_ship: 'Listos para envío', shipped: 'En camino', ready_pickup: 'Listos para retirar', delivered: 'Entregados', picked_up: 'Retirados', cancelled: 'Cancelados' }
  return (
    <div className="stack"><div className="toolbar"><Field label="Desde"><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field><Field label="Hasta"><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field></div>
      {d && <><div className="grid cols-4"><Kpi label="Pedidos" value={d.orders} /><Kpi label="Ventas en línea (pagadas)" value={gs(d.sales)} sub={`${d.paid_orders} pedidos`} tone="ok" /><Kpi label="Cancelados" value={d.cancelled} tone={d.cancelled ? 'warn' : undefined} /><Kpi label="Devoluciones" value={d.returns} />
        <Kpi label="Tiempo medio de preparación" value={d.avg_prep_hours == null ? '—' : `${d.avg_prep_hours} h`} /><Kpi label="Tiempo medio de entrega" value={d.avg_delivery_hours == null ? '—' : `${d.avg_delivery_hours} h`} /><Kpi label="Entregados" value={d.delivered} tone="ok" /><Kpi label="Con demora" value={d.late} tone={d.late ? 'bad' : 'ok'} /></div>
        <div className="card"><h2>Pedidos por estado</h2>{Object.entries(d.stages).map(([k, n]) => <div className="hbar" key={k}><span>{STG[k] ?? k}</span><b className="num">{n as number}</b><div className="track"><div className="fill" style={{ width: `${((n as number) / Math.max(d.orders, 1)) * 100}%` }} /></div></div>)}{!Object.keys(d.stages).length && <p className="muted">Sin pedidos en el período.</p>}</div></>}</div>
  )
}

function Proofs({ onChange }: { onChange: () => void }) {
  const { toast } = useApp()
  const ask = useAsk()
  const [status, setStatus] = useState('pending')
  const list = useQuery<any[]>('/payment-proofs?status=' + status)
  const [view, setView] = useState<{ proof: any; url: string; mime: string } | null>(null)
  const [acct, setAcct] = useState('')
  const accounts = useQuery<any[]>('/money-accounts')
  const banks = (accounts.data ?? []).filter((a) => a.kind === 'bank' && a.active)
  async function show(p: any) {
    const token = localStorage.getItem('samantha.token')
    const res = await fetch(`/api/payment-proofs/${p.id}/file`, { headers: { authorization: `Bearer ${token}` } })
    const blob = await res.blob()
    setView({ proof: p, url: URL.createObjectURL(blob), mime: blob.type }); setAcct(String(p.account_id ?? banks[0]?.id ?? ''))
  }
  const done = () => { setView(null); list.reload(); onChange() }
  return (
    <div className="card stack">
      <div className="toolbar"><Field label="Estado"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Por revisar</option><option value="approved">Aprobados</option><option value="rejected">Rechazados</option><option value="">Todos</option></select></Field></div>
      <div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Pedido</th><th>Cliente</th><th className="num">Total del pedido</th><th className="num">Declarado</th><th>Referencia</th><th>Estado</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((p) => <tr key={p.id}><td>{fmtDateTime(p.created_at)}</td><td><b>{p.order_number}</b></td><td>{p.customer_name}<div className="muted">{p.phone}</div></td><td className="num">{gs(p.total)}</td><td className="num">{p.amount_declared ? gs(p.amount_declared) : '—'}</td><td>{p.reference ?? '—'}</td>
          <td><Status value={p.status} />{p.review_reason && <div className="muted">{p.review_reason}</div>}</td><td><button className="small primary" onClick={() => show(p)}>{p.status === 'pending' ? 'Revisar' : 'Ver'}</button></td></tr>)}{!list.data?.length && <EmptyRow cols={8} text="No hay comprobantes en este estado" />}</tbody></table></div>
      {view && <Modal title={`Comprobante · pedido ${view.proof.order_number}`} onClose={() => setView(null)} wide="xl" footer={view.proof.status === 'pending' ? <>
        <button className="danger" onClick={async () => { const reason = await ask({ title: 'Rechazar el comprobante', reason: true, label: 'Motivo (se le avisa al cliente)', confirm: 'Rechazar', danger: true }); if (reason) { try { await api(`/payment-proofs/${view.proof.id}/reject`, { body: { reason } }); toast('Comprobante rechazado'); done() } catch (e: any) { toast(e.message, true) } } }}>Rechazar</button>
        <button className="primary" onClick={async () => { try { await api(`/payment-proofs/${view.proof.id}/approve`, { body: { amountReceived: Number(view.proof.total), accountId: Number(acct) } }); toast('Pago aprobado: el pedido pasa a preparación'); done() } catch (e: any) { toast(e.message, true) } }}>Confirmar que llegó la transferencia</button></> : <button onClick={() => setView(null)}>Cerrar</button>}>
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <div>{view.mime === 'application/pdf' ? <iframe src={view.url} title="Comprobante" style={{ width: '100%', height: '60vh', border: 0 }} /> : <img src={view.url} alt="Comprobante" style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border)' }} />}</div>
          <div className="stack"><dl className="dl"><div><dt>Cliente</dt><dd>{view.proof.customer_name}</dd></div><div><dt>Total a cobrar</dt><dd>{gs(view.proof.total)}</dd></div><div><dt>Declaró</dt><dd>{view.proof.amount_declared ? gs(view.proof.amount_declared) : '—'}</dd></div><div><dt>Referencia</dt><dd>{view.proof.reference ?? '—'}</dd></div><div><dt>Nota del cliente</dt><dd>{view.proof.payer_note ?? '—'}</dd></div></dl>
            {view.proof.status === 'pending' && <><Field label="Cuenta donde se recibió"><select value={acct} onChange={(e) => setAcct(e.target.value)}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
              <div className="warnbox">Verificá en tu banco que la transferencia llegó por <b>{gs(view.proof.total)}</b> antes de aprobar. Al aprobar se descuenta el stock y el dinero entra a la cuenta elegida.</div></>}</div></div>
      </Modal>}
    </div>
  )
}


function Coupons() {
  const { toast } = useApp()
  const list = useQuery<any[]>('/coupons')
  const [f, setF] = useState<any>(null)
  return (
    <div className="card stack"><div className="row"><button className="primary" onClick={() => setF({ code: '', kind: 'percent', value: 10, minTotal: 0, maxUses: '', validTo: '' })}>Nuevo cupón</button></div>
      <table><thead><tr><th>Código</th><th>Descuento</th><th className="num">Compra mínima</th><th>Usos</th><th>Vence</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((c) => <tr key={c.id} style={c.active ? undefined : { opacity: .5 }}><td><b>{c.code}</b></td><td>{c.kind === 'percent' ? `${c.value}%` : gs(c.value)}</td><td className="num">{gs(c.min_total)}</td><td>{c.used_count}{c.max_uses ? ` / ${c.max_uses}` : ''}</td><td>{c.valid_to ? fmtDate(c.valid_to) : '—'}</td>
          <td><button className="small" onClick={async () => { await api('/coupons/' + c.id, { method: 'PUT', body: { active: !c.active } }); list.reload() }}>{c.active ? 'Desactivar' : 'Activar'}</button></td></tr>)}{!list.data?.length && <EmptyRow cols={6} />}</tbody></table>
      {f && <Modal title="Nuevo cupón" onClose={() => setF(null)} footer={<><button onClick={() => setF(null)}>Cancelar</button><button className="primary" onClick={async () => { try { await api('/coupons', { body: { code: f.code, kind: f.kind, value: f.value, minTotal: f.minTotal, maxUses: f.maxUses ? Number(f.maxUses) : null, validTo: f.validTo || null } }); toast('Cupón creado'); setF(null); list.reload() } catch (e: any) { toast(e.message, true) } }}>Crear</button></>}>
        <div className="form"><Field label="Código"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field><Field label="Tipo"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="percent">Porcentaje</option><option value="amount">Monto fijo</option></select></Field>
          <Field label="Valor"><Money value={f.value} onChange={(n) => setF({ ...f, value: n })} /></Field><Field label="Compra mínima"><Money value={f.minTotal} onChange={(n) => setF({ ...f, minTotal: n })} /></Field>
          <Field label="Usos máximos"><input type="number" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} /></Field><Field label="Vence"><input type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} /></Field></div></Modal>}
    </div>
  )
}

export default function Orders() {
  const { user, toast } = useApp()
  const [sp, setSp] = useSearchParams()
  const tab = (sp.get('tab') as Tab) || 'pedidos'
  const [f, setF] = useState<any>({ q: '', stage: '', payment: '', method: '', payMethod: '', assigned: '', from: '', to: '', todo: sp.get('todo') ?? '', late: '' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(30)
  const q = useDebounced(f.q)
  const list = useQuery<any>(tab === 'pedidos' ? '/orders?' + qs({ ...f, q, page, pageSize }) : null)
  const counters = useQuery<any>('/orders/counters')
  const staff = useQuery<any[]>('/orders-staff')
  const [open, setOpen] = useState<number | null>(null)
  const [sel, setSel] = useState<number[]>([])
  const admin = ['owner', 'admin'].includes(user!.role)
  const refresh = () => { list.reload(); counters.reload() }
  useEffect(() => { const t = setInterval(() => { if (tab === 'pedidos') list.reload(); counters.reload() }, 20000); return () => clearInterval(t) }, [tab])
  const set = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.value }); setPage(1) }
  const c = counters.data
  const items: any[] = list.data?.items ?? []
  const printSel = (ids: number[], fmt: PrintFormat) => printOrders(ids, fmt).catch((e) => toast(e.message, true))
  const printAllTodo = async (fmt: PrintFormat) => { try { const r = await api('/orders?' + qs({ todo: '1', method: 'delivery', page: 1, pageSize: 100 })); if (!r.items.length) return toast('No hay pedidos de delivery por preparar o entregar', true); await printOrders(r.items.map((x: any) => x.id), fmt) } catch (e: any) { toast(e.message, true) } }
  const chip = (label: string, n: number | undefined, patch: any, tone?: string) => <button className={'card kpi'} style={{ textAlign: 'left', cursor: 'pointer', minHeight: 0, padding: '12px 16px' }} onClick={() => { setSp({ tab: 'pedidos' }); setF({ ...f, q: '', stage: '', payment: '', todo: '', late: '', ...patch }); setPage(1) }}><div className="label">{label}</div><div className="value" style={tone && n ? { color: `var(--${tone})` } : undefined}>{n ?? '…'}</div></button>
  return (
    <>
      <div className="head"><div><h1>Pedidos de la tienda</h1><span className="muted">Pedido, pago y entrega se administran por separado</span></div></div>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        {chip('Pendientes de revisión', c?.pending, { stage: 'pending' }, 'warn')}{chip('En preparación', c?.preparing, { stage: 'preparing' })}{chip('Pendientes de entrega', c?.to_deliver, { stage: 'shipped', todo: '1' }, 'warn')}{chip('Con demora', c?.late, { late: '1' }, 'danger')}
      </div>
      <Tabs value={tab} onChange={(t) => setSp({ tab: t })} tabs={[['pedidos', 'Pedidos'], ['comprobantes', 'Comprobantes de transferencia', c?.in_review], ['devoluciones', 'Devoluciones', c?.returns], ['metricas', 'Métricas'], ...(admin ? [['cupones', 'Cupones'] as ['cupones', string]] : [])]} />
      {tab === 'pedidos' && <div className="card">
        <div className="toolbar"><Field label="Buscar"><input value={f.q} onChange={set('q')} placeholder="N.º, nombre, teléfono, documento" /></Field>
          <Field label="Estado"><select value={f.stage} onChange={set('stage')}><option value="">Todos</option><option value="pending">Pendiente</option><option value="confirmed">Confirmado</option><option value="preparing">En preparación</option><option value="ready">Listo (envío o retiro)</option><option value="shipped">Enviado / en camino</option><option value="delivered">Entregado / retirado</option><option value="cancelled">Cancelado</option></select></Field>
          <Field label="Pago"><select value={f.payment} onChange={set('payment')}><option value="">Todos</option>{Object.entries(PAY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Entrega"><select value={f.method} onChange={set('method')}><option value="">Todas</option><option value="pickup">Retiro en local</option><option value="delivery">Delivery</option></select></Field>
          <Field label="Medio de pago"><select value={f.payMethod} onChange={set('payMethod')}><option value="">Todos</option><option value="bancard">Tarjeta</option><option value="transfer">Transferencia</option><option value="cod">Contra entrega</option></select></Field>
          <Field label="Responsable"><select value={f.assigned} onChange={set('assigned')}><option value="">Todos</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Desde"><input type="date" value={f.from} onChange={set('from')} /></Field><Field label="Hasta"><input type="date" value={f.to} onChange={set('to')} /></Field>
          <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={!!f.todo} onChange={(e) => { setF({ ...f, todo: e.target.checked ? '1' : '' }); setPage(1) }} /> Por preparar o entregar</label>
          <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={!!f.late} onChange={(e) => { setF({ ...f, late: e.target.checked ? '1' : '' }); setPage(1) }} /> Con demora</label></div>
        <div className="row no-print" style={{ margin: '4px 0 10px', flexWrap: 'wrap' }}>
          <b>Imprimir:</b>
          <button disabled={!sel.length} onClick={() => printSel(sel, 'label')}>🖨 Etiquetas de envío ({sel.length})</button>
          <button disabled={!sel.length} onClick={() => printSel(sel, 'sheet')}>🖨 Fichas A4 ({sel.length})</button>
          <button onClick={() => printAllTodo('label')}>🖨 Etiquetas de todos los delivery por entregar</button>
          <span className="muted">Marcá los pedidos con la casilla, o abrí uno para imprimirlo solo.</span></div>
        <div className="table-wrap"><table><thead><tr><th><input type="checkbox" style={{ width: 'auto' }} aria-label="Elegir todos" checked={items.length > 0 && sel.length === items.length} onChange={(e) => setSel(e.target.checked ? items.map((x) => x.id) : [])} /></th><th>Pedido</th><th>Cliente</th><th className="num">Prod.</th><th className="num">Total</th><th>Estado</th><th>Pago</th><th>Entrega</th><th>Responsable</th></tr></thead>
          <tbody>{(list.data?.items ?? []).map((o: any) => <tr key={o.id} className="clickable" onClick={() => setOpen(o.id)}><td onClick={(e) => e.stopPropagation()}><input type="checkbox" style={{ width: 'auto' }} aria-label={`Elegir ${o.number}`} checked={sel.includes(o.id)} onChange={(e) => setSel(e.target.checked ? [...sel, o.id] : sel.filter((x) => x !== o.id))} /></td><td><b>{o.number}</b><div className="muted">{fmtDateTime(o.created_at)}</div></td><td>{o.customer_name}<div className="muted">{o.phone}</div></td><td className="num">{o.units}</td><td className="num">{gs(o.total)}</td>
            <td><span className={'pill ' + (STAGE_KIND[o.stage] ?? '')}>{o.stage_label}</span>{o.late && <span className="pill bad" style={{ marginLeft: 4 }} title="Con demora">⏱</span>}{o.cancel_requested_at && o.status !== 'cancelled' && <span className="pill warn" style={{ marginLeft: 4 }}>pide cancelar</span>}{o.open_returns > 0 && <span className="pill warn" style={{ marginLeft: 4 }}>devolución</span>}</td>
            <td><span className={'pill ' + PAY_KIND[o.payment_status]}>{PAY[o.payment_status]}</span><div className="muted">{o.payment_method === 'transfer' ? 'Transferencia' : o.payment_method === 'cod' ? 'Contra entrega' : 'Tarjeta'}</div></td>
            <td>{o.delivery_method === 'pickup' ? 'Retiro en local' : <>Delivery · {o.city_name ?? ''}<div className="muted">{[o.address, o.neighborhood].filter(Boolean).join(', ')}</div></>}</td><td>{o.assigned_name ?? <span className="muted">—</span>}</td></tr>)}
            {!list.data?.items?.length && <EmptyRow cols={9} text="No hay pedidos con estos filtros" />}</tbody></table></div>
        {list.data && <Pager page={list.data.page} pages={list.data.pages} total={list.data.total} pageSize={pageSize} onPage={setPage} onSize={(s) => { setPageSize(s); setPage(1) }} />}</div>}
      {tab === 'comprobantes' && <Proofs onChange={refresh} />}
      {tab === 'devoluciones' && <Returns onChange={refresh} />}
      {tab === 'metricas' && <Metrics />}
      {tab === 'cupones' && admin && <Coupons />}
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} onChange={refresh} />}
    </>
  )
}
