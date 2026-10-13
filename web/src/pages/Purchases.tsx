import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, gs, paymentMethodLabel, useApp } from '../api'
import { ProductPicker } from '../components/ProductPicker'
import { Attachments, EmptyRow, Field, fmtDate, fmtDateTime, Kpi, Modal, Money, openAuthed, Pager, plusDays, qs, Status, Tabs, today, useAsk, useDebounced, useQuery } from '../ui'
import { PayModal } from './Suppliers'

type Tab = 'ordenes' | 'recepciones' | 'facturas' | 'deudas' | 'devoluciones'
const VAT = (net: number, rate: number) => Math.round((net * rate) / 100)

// ---------------------------------------------------------------- Orden de compra
function OrderForm({ id, onClose, onSaved, canApprove }: { id: number | null; onClose: () => void; onSaved: (id: number) => void; canApprove: boolean }) {
  const { toast } = useApp()
  const suppliers = useQuery<any[]>('/suppliers')
  const detail = useQuery<any>(id ? `/purchases/${id}` : null)
  const [f, setF] = useState<any>({ supplierId: '', expectedDate: plusDays(7), receivingPlace: 'Depósito', reference: '', notes: '', extraCosts: 0, items: [] as any[] })
  useEffect(() => {
    if (detail.data) setF({ supplierId: detail.data.supplier_id, expectedDate: detail.data.expected_date?.slice(0, 10) ?? '', receivingPlace: detail.data.receiving_place ?? '', reference: detail.data.reference ?? '', notes: detail.data.notes ?? '', extraCosts: Number(detail.data.extra_costs),
      items: detail.data.items.map((i: any) => ({ productId: i.product_id, name: i.name, qty: i.qty_ordered, unitCost: Number(i.unit_cost), discount: Number(i.discount), taxRate: i.tax_rate, presentation: i.presentation, unitsPerPresentation: i.units_per_presentation, includesVat: i.cost_includes_vat })) })
  }, [detail.data])
  const add = (p: any) => {
    if (f.items.some((i: any) => i.productId === p.id)) { toast('Ese producto ya está en la orden', true); return }
    const cost = p.cost != null ? Math.round(Number(p.cost) * p.units_per_purchase) : 0
    setF((c: any) => ({ ...c, items: [...c.items, { productId: p.id, name: p.name, qty: 1, unitCost: cost, discount: 0, taxRate: p.tax_rate, presentation: p.purchase_unit, unitsPerPresentation: p.units_per_purchase, includesVat: false }] }))
  }
  const upd = (i: number, patch: any) => setF({ ...f, items: f.items.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) })
  const lines = f.items.map((i: any) => { const gross = i.qty * i.unitCost - i.discount; const net = i.includesVat ? gross - Math.round(gross * i.taxRate / (100 + i.taxRate)) : gross; const tax = i.includesVat ? gross - net : VAT(net, i.taxRate); return { net, tax } })
  const net = lines.reduce((a: number, l: any) => a + l.net, 0), tax = lines.reduce((a: number, l: any) => a + l.tax, 0)
  async function save(action?: 'submit' | 'issue') {
    if (!f.supplierId) { toast('Elegí el proveedor', true); return }
    if (!f.items.length) { toast('Agregá al menos un producto', true); return }
    const body = { supplierId: Number(f.supplierId), expectedDate: f.expectedDate || null, receivingPlace: f.receivingPlace || null, reference: f.reference || null, notes: f.notes || null, extraCosts: f.extraCosts,
      items: f.items.map((i: any) => ({ productId: i.productId, qty: i.qty, unitCost: i.unitCost, discount: i.discount, taxRate: i.taxRate, presentation: i.presentation, unitsPerPresentation: i.unitsPerPresentation, includesVat: i.includesVat })) }
    try {
      const o = id ? await api('/purchases/' + id, { method: 'PUT', body }) : await api('/purchases', { body })
      const oid = id ?? o.id
      if (action === 'submit') await api(`/purchases/${oid}/submit`, { body: {} })
      if (action === 'issue') { await api(`/purchases/${oid}/approve`, { body: {} }); await api(`/purchases/${oid}/issue`, { body: {} }) }
      toast(action === 'issue' ? 'Orden emitida' : action === 'submit' ? 'Orden enviada a aprobación' : 'Borrador guardado'); onSaved(oid)
    } catch (e: any) { toast(e.message, true) }
  }
  return (
    <Modal title={id ? 'Editar orden de compra' : 'Nueva orden de compra'} onClose={onClose} wide="xl" footer={<>
      <button onClick={onClose}>Cancelar</button><button onClick={() => save()}>Guardar borrador</button>
      {!canApprove && <button className="primary" onClick={() => save('submit')}>Enviar a aprobación</button>}
      {canApprove && <button className="primary" onClick={() => save('issue')}>Aprobar y emitir</button>}</>}>
      <div className="form wide">
        <Field label="Proveedor *"><select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">Elegí…</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Entrega prevista"><input type="date" min={today()} value={f.expectedDate} onChange={(e) => setF({ ...f, expectedDate: e.target.value })} /></Field>
        <Field label="Lugar de recepción"><input value={f.receivingPlace} onChange={(e) => setF({ ...f, receivingPlace: e.target.value })} /></Field>
        <Field label="Referencia / pedido del proveedor"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
      <ProductPicker showCost onPick={add} placeholder="Agregar producto: buscá por nombre, código o escaneá…" />
      <div className="table-wrap"><table>
        <thead><tr><th>Producto</th><th>Presentación</th><th className="num">Cantidad</th><th className="num">Costo por presentación</th><th>IVA incl.</th><th className="num">Descuento</th><th className="num">IVA</th><th className="num">Total línea</th><th /></tr></thead>
        <tbody>{f.items.map((i: any, k: number) => (
          <tr key={i.productId}><td><b>{i.name}</b></td><td>{i.presentation} × {i.unitsPerPresentation}</td>
            <td className="num"><input type="number" min={1} style={{ width: 80 }} value={i.qty} onChange={(e) => upd(k, { qty: Math.max(1, Number(e.target.value)) })} /></td>
            <td className="num"><Money style={{ width: 120, textAlign: 'right' }} value={i.unitCost} onChange={(n) => upd(k, { unitCost: n })} /></td>
            <td><input type="checkbox" style={{ width: 'auto' }} checked={i.includesVat} onChange={(e) => upd(k, { includesVat: e.target.checked })} /></td>
            <td className="num"><Money style={{ width: 100, textAlign: 'right' }} value={i.discount} onChange={(n) => upd(k, { discount: n })} /></td>
            <td><select value={i.taxRate} onChange={(e) => upd(k, { taxRate: Number(e.target.value) })}><option value={10}>10%</option><option value={5}>5%</option><option value={0}>0%</option></select></td>
            <td className="num">{gs(lines[k].net + lines[k].tax)}</td><td><button className="small danger" onClick={() => setF({ ...f, items: f.items.filter((_: any, j: number) => j !== k) })}>✕</button></td></tr>))}
          {!f.items.length && <EmptyRow cols={9} text="Todavía no agregaste productos" />}</tbody></table></div>
      <div className="form"><Field label="Costos adicionales (flete, etc.)"><Money value={f.extraCosts} onChange={(n) => setF({ ...f, extraCosts: n })} /></Field><Field label="Observaciones" span={2}><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field></div>
      <div className="calc"><span>Subtotal {gs(net)} · IVA {gs(tax)} · adicionales {gs(f.extraCosts)}</span><b style={{ fontSize: 18 }}>Total {gs(net + tax + f.extraCosts)}</b></div>
    </Modal>
  )
}

function ReceiveModal({ order, onClose, onDone, canApprove }: { order: any; onClose: () => void; onDone: () => void; canApprove: boolean }) {
  const { toast } = useApp()
  const [rows, setRows] = useState<any[]>(order.items.filter((i: any) => i.qty_pending > 0).map((i: any) => ({ itemId: i.id, productId: i.product_id, name: i.name, pending: i.qty_pending, upp: i.units_per_presentation, presentation: i.presentation, received: 0, rejected: 0, reason: '', resolution: 'return' })))
  const [extra, setExtra] = useState<any[]>([])
  const [f, setF] = useState({ deliveryNote: '', place: order.receiving_place ?? '', notes: '', authorizeExtra: false })
  // lector: cada lectura suma una presentación del producto escaneado (si no está en la orden se ofrece agregarlo)
  const onScanProduct = (p: any) => {
    const idx = rows.findIndex((r) => r.productId === p.id)
    if (idx >= 0) { setRows(rows.map((r, i) => (i === idx ? { ...r, received: r.received + 1 } : r))); toast(`+1 ${p.name}`); return }
    if (!canApprove) { toast(`"${p.name}" no está en esta orden: pedile a un responsable que lo autorice`, true); return }
    setExtra([...extra, { productId: p.id, name: p.name, received: 1, unitCost: p.cost ? Math.round(Number(p.cost) * p.units_per_purchase) : 0 }]); setF({ ...f, authorizeExtra: true })
  }
  const upd = (i: number, patch: any) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const over = rows.some((r) => r.received - r.rejected > r.pending)
  async function submit() {
    const items = [
      ...rows.filter((r) => r.received > 0).map((r) => ({ orderItemId: r.itemId, qtyReceived: r.received, qtyRejected: r.rejected, rejectReason: r.rejected ? r.reason : undefined, rejectResolution: r.rejected ? r.resolution : undefined })),
      ...extra.filter((r) => r.received > 0).map((r) => ({ productId: r.productId, qtyReceived: r.received, unitCost: r.unitCost })),
    ]
    if (!items.length) { toast('Indicá lo que llegó', true); return }
    try { const r = await api(`/purchases/${order.id}/receptions`, { body: { items, deliveryNote: f.deliveryNote || null, place: f.place || null, notes: f.notes || null, authorizeExtra: f.authorizeExtra || undefined } }); toast(`Recepción ${r.number} registrada`); onDone() } catch (e: any) { toast(e.message, true) }
  }
  return (
    <Modal title={`Recibir mercadería · ${order.number}`} onClose={onClose} wide="xl" footer={<><button onClick={onClose}>Cancelar</button><button className="primary" onClick={submit}>Confirmar recepción</button></>}>
      <ProductPicker onPick={onScanProduct} placeholder="Escaneá o buscá el producto que llegó (cada lectura suma 1)…" />
      <div className="table-wrap"><table>
        <thead><tr><th>Producto</th><th className="num">Pendiente</th><th className="num">Recibido</th><th className="num">Rechazado</th><th>Motivo del rechazo</th><th>Qué hacer</th><th className="num">Aceptado → stock</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={r.itemId}><td><b>{r.name}</b><div className="muted">{r.presentation} × {r.upp}</div></td><td className="num">{r.pending}</td>
            <td className="num"><input type="number" min={0} style={{ width: 80 }} value={r.received} onChange={(e) => upd(i, { received: Math.max(0, Number(e.target.value)) })} /></td>
            <td className="num"><input type="number" min={0} max={r.received} style={{ width: 80 }} value={r.rejected} onChange={(e) => upd(i, { rejected: Math.min(r.received, Math.max(0, Number(e.target.value))) })} /></td>
            <td>{r.rejected > 0 && <input placeholder="Dañado, vencido…" value={r.reason} onChange={(e) => upd(i, { reason: e.target.value })} />}</td>
            <td>{r.rejected > 0 && <select value={r.resolution} onChange={(e) => upd(i, { resolution: e.target.value })}><option value="return">Devolver</option><option value="credit">Pedir nota de crédito</option><option value="replace">Pedir reposición</option><option value="pending">Decidir después</option></select>}</td>
            <td className="num"><b>{r.received - r.rejected}</b> × {r.upp} = {(r.received - r.rejected) * r.upp} u.{r.received - r.rejected > r.pending && <span className="pill warn" style={{ marginLeft: 6 }}>Sobrante</span>}</td></tr>))}
          {extra.map((r, i) => <tr key={'x' + r.productId}><td><b>{r.name}</b><div><span className="pill warn">No estaba en la orden</span></div></td><td className="num">—</td><td className="num"><input type="number" min={1} style={{ width: 80 }} value={r.received} onChange={(e) => setExtra(extra.map((x, j) => (j === i ? { ...x, received: Number(e.target.value) } : x)))} /></td><td colSpan={2}>Costo por presentación <Money style={{ width: 120 }} value={r.unitCost} onChange={(n) => setExtra(extra.map((x, j) => (j === i ? { ...x, unitCost: n } : x)))} /></td><td /><td><button className="small danger" onClick={() => setExtra(extra.filter((_, j) => j !== i))}>✕</button></td></tr>)}
        </tbody></table></div>
      <div className="form"><Field label="N.º de remito del proveedor"><input value={f.deliveryNote} onChange={(e) => setF({ ...f, deliveryNote: e.target.value })} /></Field><Field label="Lugar"><input value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} /></Field><Field label="Observaciones" span={2}><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field></div>
      {(over || extra.length > 0) && (canApprove
        ? <label className="warnbox inline"><input type="checkbox" style={{ width: 'auto' }} checked={f.authorizeExtra} onChange={(e) => setF({ ...f, authorizeExtra: e.target.checked })} /> Autorizo recibir de más / productos no pedidos (queda registrado a mi nombre)</label>
        : <div className="warnbox">Hay cantidades de más o productos que no estaban en la orden: lo autoriza un responsable.</div>)}
    </Modal>
  )
}

function OrderDetail({ id, onClose, onChange, canApprove, canReceive }: { id: number; onClose: () => void; onChange: () => void; canApprove: boolean; canReceive: boolean }) {
  const { toast } = useApp()
  const ask = useAsk()
  const d = useQuery<any>(`/purchases/${id}`)
  const [edit, setEdit] = useState(false)
  const [recv, setRecv] = useState(false)
  const o = d.data
  if (!o) return <Modal title="Orden de compra" onClose={onClose}><p className="muted">Cargando…</p></Modal>
  const act = async (path: string, ok: string, withReason?: string) => {
    let body: any = {}
    if (withReason) { const reason = await ask({ title: withReason, reason: true, confirm: 'Confirmar', danger: true }); if (!reason) return; body = { reason } }
    try { await api(`/purchases/${id}/${path}`, { body }); toast(ok); d.reload(); onChange() } catch (e: any) { toast(e.message, true) }
  }
  const costs = o.items[0] && 'unit_cost' in o.items[0]
  const status = o.status
  return (
    <Modal title={`${o.number} · ${o.supplier_name}`} onClose={onClose} wide="xl" footer={<>
      <button onClick={() => openAuthed(`/purchases/${id}/pdf`).catch((e) => toast(e.message, true))}>PDF</button>
      {status === 'draft' && <><button onClick={() => setEdit(true)}>Editar</button><button onClick={() => act('submit', 'Enviada a aprobación')}>Enviar a aprobación</button></>}
      {['draft', 'pending_approval'].includes(status) && canApprove && <button className="primary" onClick={() => act('approve', 'Orden aprobada')}>Aprobar</button>}
      {status === 'pending_approval' && canApprove && <button onClick={() => act('reject', 'Devuelta a borrador', 'Motivo del rechazo')}>Rechazar</button>}
      {status === 'approved' && canApprove && <button className="primary" onClick={() => act('issue', 'Orden emitida')}>Emitir al proveedor</button>}
      {['issued', 'partial'].includes(status) && canReceive && <button className="primary" onClick={() => setRecv(true)}>Recibir mercadería</button>}
      {status === 'partial' && <button onClick={() => act('close', 'Orden cerrada', 'Motivo del cierre incompleto')}>Cerrar sin recibir el resto</button>}
      {['draft', 'pending_approval', 'approved', 'issued'].includes(status) && <button className="danger" onClick={() => act('cancel', 'Orden anulada', 'Motivo de la anulación')}>Anular</button>}</>}>
      <div className="grid cols-4"><Kpi label="Estado" value={<Status value={status} />} /><Kpi label="Total" value={costs ? gs(o.total) : '—'} sub={costs ? `IVA ${gs(o.tax)}` : undefined} /><Kpi label="Recibido" value={`${o.progress.received}/${o.progress.ordered}`} sub={o.progress.rejected ? `${o.progress.rejected} rechazadas` : undefined} /><Kpi label="Facturado / Pagado" value={costs ? gs(o.invoiced) : '—'} sub={costs ? `pagado ${gs(o.paid)}` : undefined} /></div>
      <dl className="dl"><div><dt>Fecha</dt><dd>{fmtDate(o.order_date)}</dd></div><div><dt>Entrega prevista</dt><dd>{fmtDate(o.expected_date)}</dd></div><div><dt>Lugar</dt><dd>{o.receiving_place ?? '—'}</dd></div><div><dt>Referencia</dt><dd>{o.reference ?? '—'}</dd></div><div><dt>Notas</dt><dd>{o.notes ?? '—'}</dd></div></dl>
      <div className="table-wrap"><table><thead><tr><th>Producto</th><th>Presentación</th><th className="num">Pedido</th><th className="num">Recibido</th><th className="num">Rechazado</th><th className="num">Pendiente</th><th className="num">Facturado</th>{costs && <th className="num">Costo</th>}{costs && <th className="num">Total</th>}</tr></thead>
        <tbody>{o.items.map((i: any) => <tr key={i.id}><td><b>{i.name}</b><div className="muted">{i.code}</div></td><td>{i.presentation} × {i.units_per_presentation}</td><td className="num">{i.qty_ordered}</td><td className="num">{i.qty_received}</td><td className="num">{i.qty_rejected || ''}</td><td className="num">{i.qty_pending}</td><td className="num">{i.qty_invoiced}</td>{costs && <><td className="num">{gs(i.unit_cost)}</td><td className="num">{gs(Number(i.line_net) + Number(i.line_tax))}</td></>}</tr>)}</tbody></table></div>
      <div className="grid cols-2">
        <div><h3>Recepciones</h3><table><tbody>{o.receptions.map((r: any) => <tr key={r.id}><td>{r.number}</td><td>{fmtDateTime(r.received_at)}</td><td>{r.delivery_note ?? ''}</td><td><Status value={r.status} /></td></tr>)}{!o.receptions.length && <EmptyRow cols={4} />}</tbody></table>
          <h3>Facturas del proveedor</h3><table><tbody>{o.invoices.map((i: any) => <tr key={i.id}><td>{i.doc_number}</td><td>{fmtDate(i.doc_date)}</td><td className="num">{gs(i.total)}</td><td><Status value={i.status} /></td></tr>)}{!o.invoices.length && <EmptyRow cols={4} />}</tbody></table></div>
        <div><h3>Historial</h3><ul className="timeline">{o.events.map((e: any, i: number) => <li key={i}><b>{e.action.replace('purchase_order.', '').replace('_', ' ')}</b> · {e.user_name} <span className="muted">{fmtDateTime(e.at)}</span>{e.detail?.reason && <div className="muted">{e.detail.reason}</div>}</li>)}</ul>
          <h3>Comprobantes</h3><Attachments ownerType="purchase_order" ownerId={id} /></div>
      </div>
      {edit && <OrderForm id={id} canApprove={canApprove} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); d.reload(); onChange() }} />}
      {recv && <ReceiveModal order={o} canApprove={canApprove} onClose={() => setRecv(false)} onDone={() => { setRecv(false); d.reload(); onChange() }} />}
    </Modal>
  )
}

// ---------------------------------------------------------------- Factura de compra
function InvoiceForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp()
  const suppliers = useQuery<any[]>('/suppliers')
  const accounts = useQuery<any[]>('/money-accounts')
  const [f, setF] = useState<any>({ supplierId: '', docNumber: '', timbrado: '', docDate: today(), paymentCondition: 'credit', installments: 1, firstDays: 30, extraCosts: 0, notes: '', payNow: false, method: 'transfer', accountId: '', mode: 'received' })
  const pend = useQuery<any[]>(f.supplierId ? `/suppliers/${f.supplierId}/uninvoiced` : null)
  const [picked, setPicked] = useState<Record<number, number>>({})
  const [direct, setDirect] = useState<any[]>([])
  const sup = (suppliers.data ?? []).find((s) => String(s.id) === String(f.supplierId))
  useEffect(() => { setPicked(Object.fromEntries((pend.data ?? []).map((p) => [p.reception_item_id, p.pending]))) }, [pend.data])
  useEffect(() => { if (sup) setF((c: any) => ({ ...c, paymentCondition: sup.payment_condition, firstDays: sup.payment_days || 30 })) }, [sup?.id])
  const banks = (accounts.data ?? []).filter((a) => a.kind === 'bank' && a.active)
  const lines = (pend.data ?? []).filter((p) => picked[p.reception_item_id] > 0).map((p) => { const net = Math.round(Number(p.unit_cost) * picked[p.reception_item_id]); return { p, qty: picked[p.reception_item_id], net, tax: VAT(net, p.tax_rate) } })
  const dLines = direct.map((d) => { const gross = d.qty * d.unitCost - d.discount; const net = d.includesVat ? gross - Math.round(gross * d.taxRate / (100 + d.taxRate)) : gross; return { net, tax: d.includesVat ? gross - net : VAT(net, d.taxRate) } })
  const net = lines.reduce((a, l) => a + l.net, 0) + dLines.reduce((a, l) => a + l.net, 0)
  const tax = lines.reduce((a, l) => a + l.tax, 0) + dLines.reduce((a, l) => a + l.tax, 0)
  const total = net + tax + f.extraCosts
  const schedule = useMemo(() => {
    if (f.paymentCondition === 'cash') return [{ dueDate: f.docDate, amount: total }]
    const n = Math.max(1, f.installments); const base = Math.floor(total / n)
    return Array.from({ length: n }, (_, i) => ({ dueDate: new Date(new Date(f.docDate + 'T12:00:00').getTime() + (f.firstDays + 30 * i) * 86400_000).toISOString().slice(0, 10), amount: i === n - 1 ? total - base * (n - 1) : base }))
  }, [total, f.paymentCondition, f.installments, f.firstDays, f.docDate])
  const formatOk = /^\d{3}-\d{3}-\d{7}$/.test(f.docNumber)
  async function save() {
    try {
      const body: any = { supplierId: Number(f.supplierId), docType: 'invoice', docNumber: f.docNumber.trim(), timbrado: f.timbrado || null, docDate: f.docDate, paymentCondition: f.paymentCondition, extraCosts: f.extraCosts, notes: f.notes || null,
        installments: f.paymentCondition === 'credit' && f.installments > 1 ? schedule : undefined, dueDate: f.paymentCondition === 'credit' && f.installments === 1 ? schedule[0].dueDate : undefined }
      if (f.mode === 'received') body.lines = lines.map((l) => ({ receptionItemId: l.p.reception_item_id, qty: l.qty }))
      else body.directLines = direct.map((d) => ({ productId: d.productId, qty: d.qty, unitCost: d.unitCost, discount: d.discount, taxRate: d.taxRate, includesVat: d.includesVat }))
      if (f.paymentCondition === 'cash' && f.payNow) body.payNow = { method: f.method, accountId: f.method !== 'cash' && (f.accountId || banks[0]?.id) ? Number(f.accountId || banks[0]?.id) : null }
      await api('/purchase-invoices', { body }); toast('Factura registrada'); onSaved()
    } catch (e: any) { toast(e.message, true) }
  }
  return (
    <Modal title="Registrar factura de compra" onClose={onClose} wide="xl" footer={<><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!f.supplierId || !f.docNumber || total <= 0} onClick={save}>Registrar factura</button></>}>
      <div className="form wide">
        <Field label="Proveedor *"><select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">Elegí…</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="N.º de factura *" error={f.docNumber && !formatOk ? 'Formato 001-001-0000001' : undefined}><input value={f.docNumber} onChange={(e) => setF({ ...f, docNumber: e.target.value })} placeholder="001-001-0000001" /></Field>
        <Field label="Timbrado (8 dígitos)"><input value={f.timbrado} onChange={(e) => setF({ ...f, timbrado: e.target.value })} maxLength={8} /></Field>
        <Field label="Fecha de la factura"><input type="date" max={today()} value={f.docDate} onChange={(e) => setF({ ...f, docDate: e.target.value })} /></Field>
        <Field label="Condición"><select value={f.paymentCondition} onChange={(e) => setF({ ...f, paymentCondition: e.target.value })}><option value="credit">Crédito</option><option value="cash">Contado</option></select></Field>
        {f.paymentCondition === 'credit' && <><Field label="Cuotas"><input type="number" min={1} max={24} value={f.installments} onChange={(e) => setF({ ...f, installments: Number(e.target.value) })} /></Field><Field label="Primer vencimiento (días)"><input type="number" min={0} value={f.firstDays} onChange={(e) => setF({ ...f, firstDays: Number(e.target.value) })} /></Field></>}
        <Field label="Costos adicionales"><Money value={f.extraCosts} onChange={(n) => setF({ ...f, extraCosts: n })} /></Field>
      </div>
      <Tabs value={f.mode} onChange={(m) => setF({ ...f, mode: m })} tabs={[['received', 'Mercadería ya recibida'], ['direct', 'Compra directa (sin orden)']]} />
      {f.mode === 'received' && <>
        {!f.supplierId ? <p className="muted">Elegí el proveedor para ver la mercadería recibida que falta facturar. Una factura puede cubrir varias órdenes y recepciones.</p> :
          <div className="table-wrap"><table><thead><tr><th /><th>Orden</th><th>Recepción</th><th>Producto</th><th className="num">Pendiente de facturar</th><th className="num">Facturar</th><th className="num">Costo</th><th className="num">Total c/IVA</th></tr></thead>
            <tbody>{(pend.data ?? []).map((p) => { const q = picked[p.reception_item_id] ?? 0; return <tr key={p.reception_item_id}><td><input type="checkbox" style={{ width: 'auto' }} checked={q > 0} onChange={(e) => setPicked({ ...picked, [p.reception_item_id]: e.target.checked ? p.pending : 0 })} /></td><td>{p.order_number ?? 'Sin orden'}</td><td>{p.reception_number}</td><td>{p.name}</td><td className="num">{p.pending}</td>
              <td className="num"><input type="number" min={0} max={p.pending} style={{ width: 80 }} value={q} onChange={(e) => setPicked({ ...picked, [p.reception_item_id]: Math.min(p.pending, Math.max(0, Number(e.target.value))) })} /></td><td className="num">{gs(p.unit_cost)}</td><td className="num">{gs(Math.round(Number(p.unit_cost) * q * (1 + p.tax_rate / 100)))}</td></tr> })}
              {!pend.data?.length && <EmptyRow cols={8} text="Este proveedor no tiene mercadería recibida pendiente de facturar" />}</tbody></table></div>}</>}
      {f.mode === 'direct' && <div className="stack">
        <ProductPicker showCost onPick={(p) => setDirect([...direct, { productId: p.id, name: p.name, qty: 1, unitCost: p.cost ? Math.round(Number(p.cost)) : 0, discount: 0, taxRate: p.tax_rate, includesVat: false }])} />
        <table><thead><tr><th>Producto</th><th className="num">Cantidad (unidades)</th><th className="num">Costo unitario</th><th>IVA incl.</th><th className="num">Descuento</th><th className="num">IVA</th><th /></tr></thead>
          <tbody>{direct.map((d, i) => <tr key={i}><td>{d.name}</td><td className="num"><input type="number" min={1} style={{ width: 80 }} value={d.qty} onChange={(e) => setDirect(direct.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x)))} /></td>
            <td className="num"><Money style={{ width: 110, textAlign: 'right' }} value={d.unitCost} onChange={(n) => setDirect(direct.map((x, j) => (j === i ? { ...x, unitCost: n } : x)))} /></td>
            <td><input type="checkbox" style={{ width: 'auto' }} checked={d.includesVat} onChange={(e) => setDirect(direct.map((x, j) => (j === i ? { ...x, includesVat: e.target.checked } : x)))} /></td>
            <td className="num"><Money style={{ width: 90, textAlign: 'right' }} value={d.discount} onChange={(n) => setDirect(direct.map((x, j) => (j === i ? { ...x, discount: n } : x)))} /></td>
            <td><select value={d.taxRate} onChange={(e) => setDirect(direct.map((x, j) => (j === i ? { ...x, taxRate: Number(e.target.value) } : x)))}><option value={10}>10%</option><option value={5}>5%</option><option value={0}>0%</option></select></td><td><button className="small danger" onClick={() => setDirect(direct.filter((_, j) => j !== i))}>✕</button></td></tr>)}
            {!direct.length && <EmptyRow cols={7} text="Agregá los productos de la factura: entran al stock al registrarla" />}</tbody></table></div>}
      <div className="calc"><span>Subtotal {gs(net)} · IVA crédito fiscal {gs(tax)} · adicionales {gs(f.extraCosts)}</span><b style={{ fontSize: 18 }}>Total de la factura {gs(total)}</b>
        {f.paymentCondition === 'credit' && f.installments > 1 && <span>{schedule.map((s, i) => `Cuota ${i + 1}: ${gs(s.amount)} vence ${fmtDate(s.dueDate)}`).join(' · ')}</span>}</div>
      {f.paymentCondition === 'cash' && <div className="stack"><label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={f.payNow} onChange={(e) => setF({ ...f, payNow: e.target.checked })} /> Pagar ahora</label>
        {f.payNow && <div className="form"><Field label="Medio"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="transfer">Transferencia</option><option value="cash">Efectivo (de mi caja)</option><option value="check">Cheque</option></select></Field>
          {f.method !== 'cash' && <Field label="Cuenta"><select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}</div>}</div>}
      <Field label="Observaciones"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
    </Modal>
  )
}

function InvoiceDetail({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const { toast } = useApp()
  const ask = useAsk()
  const d = useQuery<any>(`/purchase-invoices/${id}`)
  const i = d.data
  if (!i) return <Modal title="Factura" onClose={onClose}><p className="muted">Cargando…</p></Modal>
  return (
    <Modal title={`Factura ${i.doc_number} · ${i.supplier_name}`} onClose={onClose} wide="xl" footer={<>{i.status !== 'void' && <button className="danger" onClick={async () => { const reason = await ask({ title: 'Anular la factura', reason: true, confirm: 'Anular', danger: true }); if (reason) { try { await api(`/purchase-invoices/${id}/void`, { body: { reason } }); toast('Factura anulada'); d.reload(); onChange() } catch (e: any) { toast(e.message, true) } } }}>Anular</button>}<button onClick={onClose}>Cerrar</button></>}>
      <div className="grid cols-4"><Kpi label="Total" value={gs(i.total)} /><Kpi label="Pagado" value={gs(i.paid)} tone="ok" /><Kpi label="Notas de crédito" value={gs(i.credited)} /><Kpi label="Saldo" value={gs(i.pending)} tone={i.pending ? 'warn' : 'ok'} /></div>
      <dl className="dl"><div><dt>Interno</dt><dd>{i.number}</dd></div><div><dt>Fecha</dt><dd>{fmtDate(i.doc_date)}</dd></div><div><dt>Timbrado</dt><dd>{i.timbrado ?? '—'}</dd></div><div><dt>Condición</dt><dd>{i.payment_condition === 'cash' ? 'Contado' : 'Crédito'}</dd></div><div><dt>Órdenes</dt><dd>{i.orders.map((o: any) => o.number).join(', ') || 'Compra directa'}</dd></div><div><dt>Estado</dt><dd><Status value={i.status} /></dd></div></dl>
      <table><thead><tr><th>Producto</th><th className="num">Cantidad</th><th className="num">Costo</th><th className="num">Neto</th><th className="num">IVA</th><th className="num">Total</th></tr></thead>
        <tbody>{i.items.map((x: any) => <tr key={x.id}><td>{x.description}</td><td className="num">{x.qty}</td><td className="num">{gs(x.unit_cost)}</td><td className="num">{gs(x.net)}</td><td className="num">{gs(x.tax)}</td><td className="num">{gs(x.total)}</td></tr>)}</tbody></table>
      <div className="grid cols-2"><div><h3>Vencimientos</h3><table><tbody>{i.payables.map((p: any) => <tr key={p.id}><td>Cuota {p.number}</td><td>{fmtDate(p.due_date)}</td><td className="num">{gs(p.amount)}</td><td className="num">{gs(p.pending)}</td></tr>)}</tbody></table></div>
        <div><h3>Pagos aplicados</h3><table><tbody>{i.payments.map((p: any) => <tr key={p.id} style={p.voided ? { opacity: .5 } : undefined}><td>{fmtDateTime(p.at)}</td><td>{paymentMethodLabel(p.method)}</td><td className="num">{gs(p.amount)}</td></tr>)}{!i.payments.length && <EmptyRow cols={3} />}</tbody></table></div></div>
      <h3>Factura escaneada / comprobantes</h3><Attachments ownerType="purchase_invoice" ownerId={id} />
    </Modal>
  )
}

// ---------------------------------------------------------------- Devoluciones y notas de crédito
function ReturnForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp()
  const suppliers = useQuery<any[]>('/suppliers')
  const [sid, setSid] = useState('')
  const [reason, setReason] = useState('')
  const recs = useQuery<any[]>(sid ? `/receptions?supplierId=${sid}` : null)
  const [items, setItems] = useState<any[]>([])
  const [qty, setQty] = useState<Record<number, number>>({})
  useEffect(() => { (async () => { const out: any[] = []; for (const r of (recs.data ?? []).filter((x) => x.status === 'posted').slice(0, 15)) { const d = await api('/receptions/' + r.id); for (const it of d.items) if (it.qty_accepted - it.returned_qty > 0) out.push({ ...it, rec: r.number, avail: it.qty_accepted - it.returned_qty }) } setItems(out) })().catch(() => {}) }, [recs.data])
  const lines = Object.entries(qty).filter(([, n]) => n > 0).map(([id, n]) => ({ receptionItemId: Number(id), qty: n }))
  return (
    <Modal title="Devolución a proveedor" onClose={onClose} wide footer={<><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!lines.length || reason.length < 3} onClick={async () => { try { await api('/supplier-returns', { body: { supplierId: Number(sid), reason, lines } }); toast('Devolución registrada: salió del stock'); onSaved() } catch (e: any) { toast(e.message, true) } }}>Registrar devolución</button></>}>
      <div className="form"><Field label="Proveedor"><select value={sid} onChange={(e) => setSid(e.target.value)}><option value="">Elegí…</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label="Motivo" span={2}><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Defectuoso, equivocado, vencido…" /></Field></div>
      <table><thead><tr><th>Recepción</th><th>Producto</th><th className="num">Aceptado</th><th className="num">Ya devuelto</th><th className="num">A devolver</th></tr></thead>
        <tbody>{items.map((it) => <tr key={it.id}><td>{it.rec}</td><td>{it.name}</td><td className="num">{it.qty_accepted}</td><td className="num">{it.returned_qty}</td><td className="num"><input type="number" min={0} max={it.avail} style={{ width: 80 }} value={qty[it.id] ?? 0} onChange={(e) => setQty({ ...qty, [it.id]: Math.min(it.avail, Math.max(0, Number(e.target.value))) })} /></td></tr>)}{!items.length && <EmptyRow cols={5} text={sid ? 'No hay mercadería recibida para devolver' : 'Elegí un proveedor'} />}</tbody></table>
    </Modal>
  )
}

function CreditNoteForm({ ret, onClose, onSaved }: { ret?: any; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp()
  const suppliers = useQuery<any[]>('/suppliers')
  const accounts = useQuery<any[]>('/money-accounts')
  const [f, setF] = useState<any>({ supplierId: ret?.supplier_id ?? '', returnId: ret?.id ?? '', docNumber: '', docDate: today(), net: ret ? Number(ret.invoiced_value) - Number(ret.credited) : 0, vat: ret ? VAT(Number(ret.invoiced_value) - Number(ret.credited), 10) : 0, resolution: 'applied', refundMethod: 'transfer', refundAccountId: '' })
  const banks = (accounts.data ?? []).filter((a) => a.kind === 'bank' && a.active)
  return (
    <Modal title="Nota de crédito del proveedor" onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!f.supplierId || !f.docNumber || !f.net} onClick={async () => { try { await api('/supplier-credit-notes', { body: { supplierId: Number(f.supplierId), returnId: f.returnId ? Number(f.returnId) : null, docNumber: f.docNumber, docDate: f.docDate, net: f.net, vat: f.vat, resolution: f.resolution, refundMethod: f.resolution === 'refund' ? f.refundMethod : null, refundAccountId: f.resolution === 'refund' && f.refundMethod === 'transfer' ? Number(f.refundAccountId || banks[0]?.id) : null } }); toast('Nota de crédito registrada'); onSaved() } catch (e: any) { toast(e.message, true) } }}>Registrar</button></>}>
      <div className="form">
        <Field label="Proveedor"><select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })} disabled={!!ret}><option value="">Elegí…</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="N.º de la nota"><input value={f.docNumber} onChange={(e) => setF({ ...f, docNumber: e.target.value })} /></Field><Field label="Fecha"><input type="date" max={today()} value={f.docDate} onChange={(e) => setF({ ...f, docDate: e.target.value })} /></Field>
        <Field label="Importe sin IVA"><Money value={f.net} onChange={(n) => setF({ ...f, net: n, vat: VAT(n, 10) })} /></Field><Field label="IVA"><Money value={f.vat} onChange={(n) => setF({ ...f, vat: n })} /></Field>
        <Field label="Qué se hace con el crédito"><select value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })}><option value="applied">Descontar de la deuda</option><option value="credit_balance">Dejar como saldo a favor</option><option value="refund">Me devuelven el dinero</option></select></Field>
        {f.resolution === 'refund' && <><Field label="Cómo"><select value={f.refundMethod} onChange={(e) => setF({ ...f, refundMethod: e.target.value })}><option value="transfer">Transferencia</option><option value="cash">Efectivo (a mi caja)</option></select></Field>
          {f.refundMethod === 'transfer' && <Field label="Cuenta"><select value={f.refundAccountId} onChange={(e) => setF({ ...f, refundAccountId: e.target.value })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}</>}
      </div>
      <div className="calc">Total de la nota: <b>{gs(f.net + f.vat)}</b></div>
    </Modal>
  )
}

// ---------------------------------------------------------------- Pantalla
export default function Purchases() {
  const { user } = useApp()
  const [sp, setSp] = useSearchParams()
  const tab = (sp.get('tab') as Tab) || 'ordenes'
  const canApprove = ['owner', 'admin'].includes(user!.role)
  const canWrite = ['owner', 'admin', 'buyer'].includes(user!.role)
  const canReceive = ['owner', 'admin', 'warehouse'].includes(user!.role)
  const canInvoice = ['owner', 'admin', 'buyer', 'accountant'].includes(user!.role)
  const [open, setOpen] = useState<number | null>(sp.get('open') && tab === 'ordenes' ? Number(sp.get('open')) : null)
  const [form, setForm] = useState<{ id: number | null } | null>(null)
  const [invForm, setInvForm] = useState(false)
  const [invOpen, setInvOpen] = useState<number | null>(sp.get('open') && tab === 'facturas' ? Number(sp.get('open')) : null)
  const [retForm, setRetForm] = useState(false)
  const [cnForm, setCnForm] = useState<any>(null)
  const [pay, setPay] = useState<any>(null)
  const [f, setF] = useState<any>({ q: '', status: '', supplierId: '', from: '', to: '' })
  const [page, setPage] = useState(1)
  const q = useDebounced(f.q)
  const suppliers = useQuery<any[]>('/suppliers?all=1')
  const orders = useQuery<any>(tab === 'ordenes' ? '/purchases?' + qs({ ...f, q, page, pageSize: 30 }) : null)
  const recs = useQuery<any[]>(tab === 'recepciones' ? '/receptions?' + qs({ supplierId: f.supplierId, from: f.from, to: f.to }) : null)
  const invs = useQuery<any[]>(tab === 'facturas' ? '/purchase-invoices?' + qs({ supplierId: f.supplierId, status: f.status, from: f.from, to: f.to, q }) : null)
  const ap = useQuery<any>(tab === 'deudas' ? '/payables?' + qs({ supplierId: f.supplierId, status: f.status, from: f.from, to: f.to, q }) : null)
  const rets = useQuery<any[]>(tab === 'devoluciones' ? '/supplier-returns' : null)
  const notes = useQuery<any[]>(tab === 'devoluciones' ? '/supplier-credit-notes' : null)
  const setTab = (t: Tab) => { setSp({ tab: t }); setF({ q: '', status: '', supplierId: '', from: '', to: '' }); setPage(1) }
  const reloadAll = () => { orders.reload(); recs.reload(); invs.reload(); ap.reload(); rets.reload(); notes.reload() }
  const supplierSelect = <Field label="Proveedor"><select value={f.supplierId} onChange={(e) => { setF({ ...f, supplierId: e.target.value }); setPage(1) }}><option value="">Todos</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
  const dates = <><Field label="Desde"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field><Field label="Hasta"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field></>
  const search = <Field label="Buscar"><input value={f.q} onChange={(e) => { setF({ ...f, q: e.target.value }); setPage(1) }} /></Field>

  return (
    <>
      <div className="head"><div><h1>Compras</h1><span className="muted">Órdenes, recepciones, facturas y deudas con proveedores</span></div>
        <div className="row">{canWrite && <button className="primary" onClick={() => setForm({ id: null })}>Nueva orden de compra</button>}{canInvoice && <button onClick={() => setInvForm(true)}>Registrar factura</button>}</div></div>
      <Tabs value={tab} onChange={setTab} tabs={[['ordenes', 'Órdenes de compra'], ['recepciones', 'Recepciones'], ['facturas', 'Facturas'], ['deudas', 'Cuentas por pagar'], ['devoluciones', 'Devoluciones y notas de crédito']]} />

      {tab === 'ordenes' && <div className="card">
        <div className="toolbar">{search}{supplierSelect}<Field label="Estado"><select value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setPage(1) }}><option value="">Todos</option><option value="draft">Borrador</option><option value="pending_approval">Por aprobar</option><option value="approved">Aprobada</option><option value="issued,partial">Por recibir</option><option value="received">Recibida</option><option value="closed_short">Cerrada incompleta</option><option value="cancelled">Anulada</option></select></Field>{dates}</div>
        <div className="table-wrap"><table><thead><tr><th>Orden</th><th>Fecha</th><th>Proveedor</th><th>Estado</th><th>Entrega prevista</th><th>Recibido</th><th className="num">Total</th><th className="num">Facturado</th></tr></thead>
          <tbody>{(orders.data?.items ?? []).map((o: any) => <tr key={o.id} className="clickable" onClick={() => setOpen(o.id)}><td><b>{o.number}</b></td><td>{fmtDate(o.order_date)}</td><td>{o.supplier_name}</td><td><Status value={o.status} /></td><td>{fmtDate(o.expected_date)}</td>
            <td><div className="progress"><i style={{ width: `${Math.round(Number(o.received_ratio) * 100)}%` }} /></div></td><td className="num">{gs(o.total)}</td><td className="num">{gs(o.invoiced)}</td></tr>)}{!orders.data?.items?.length && <EmptyRow cols={8} />}</tbody></table></div>
        {orders.data && <Pager page={orders.data.page} pages={orders.data.pages} total={orders.data.total} pageSize={30} onPage={setPage} />}</div>}

      {tab === 'recepciones' && <div className="card"><div className="toolbar">{supplierSelect}{dates}</div>
        <div className="table-wrap"><table><thead><tr><th>Recepción</th><th>Fecha</th><th>Proveedor</th><th>Orden</th><th>Remito</th><th className="num">Aceptado</th><th className="num">Rechazado</th><th>Recibió</th><th>Estado</th></tr></thead>
          <tbody>{(recs.data ?? []).map((r) => <tr key={r.id}><td><b>{r.number}</b></td><td>{fmtDateTime(r.received_at)}</td><td>{r.supplier_name}</td><td>{r.order_number ?? 'Compra directa'}</td><td>{r.delivery_note ?? ''}</td><td className="num">{r.accepted}</td><td className="num">{r.rejected || ''}</td><td>{r.user_name}</td><td><Status value={r.status} /></td></tr>)}{!recs.data?.length && <EmptyRow cols={9} />}</tbody></table></div></div>}

      {tab === 'facturas' && <div className="card"><div className="toolbar">{search}{supplierSelect}<Field label="Estado"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Todas</option><option value="open">Pendientes</option><option value="paid">Pagadas</option><option value="void">Anuladas</option></select></Field>{dates}</div>
        <div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Factura</th><th>Proveedor</th><th>Órdenes</th><th className="num">Total</th><th className="num">Pagado</th><th className="num">Saldo</th><th>Vence</th><th>Estado</th></tr></thead>
          <tbody>{(invs.data ?? []).map((i) => <tr key={i.id} className="clickable" onClick={() => setInvOpen(i.id)}><td>{fmtDate(i.doc_date)}</td><td><b>{i.doc_number}</b></td><td>{i.supplier_name}</td><td>{i.orders ?? 'Directa'}</td><td className="num">{gs(i.total)}</td><td className="num">{gs(i.paid)}</td><td className="num">{gs(i.pending)}</td><td>{i.next_due ? fmtDate(i.next_due) : '—'}</td><td><Status value={i.status} /></td></tr>)}{!invs.data?.length && <EmptyRow cols={9} />}</tbody></table></div></div>}

      {tab === 'deudas' && <div className="stack">
        <div className="grid cols-4"><Kpi label="Deuda total" value={gs(ap.data?.totals.pending ?? 0)} /><Kpi label="Vencida" value={gs(ap.data?.totals.overdue ?? 0)} tone="bad" /><Kpi label="Vence en 7 días" value={gs(ap.data?.totals.due_soon ?? 0)} tone="warn" /><Kpi label="Al día" value={gs(ap.data?.totals.current ?? 0)} tone="ok" /></div>
        <div className="card"><div className="toolbar">{search}{supplierSelect}<Field label="Estado"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Pendientes</option><option value="overdue">Vencidas</option><option value="due_soon">Vencen pronto</option></select></Field>{dates}</div>
          <div className="table-wrap"><table><thead><tr><th>Proveedor</th><th>Factura</th><th>Cuota</th><th>Vence</th><th className="num">Importe</th><th className="num">Pagado</th><th className="num">Saldo</th><th /></tr></thead>
            <tbody>{(ap.data?.items ?? []).map((p: any) => <tr key={p.id}><td>{p.supplier}</td><td><button className="link" onClick={() => setInvOpen(p.invoice_id)}>{p.doc_number}</button></td><td>{p.installment}</td><td><Status value={p.state} label={fmtDate(p.due_date)} /></td><td className="num">{gs(p.amount)}</td><td className="num">{gs(Number(p.paid) + Number(p.credited))}</td><td className="num">{gs(p.pending)}</td>
              <td><button className="small primary" onClick={() => setPay({ id: p.supplier_id, name: p.supplier })}>Pagar</button></td></tr>)}{!ap.data?.items?.length && <EmptyRow cols={8} text="No hay deudas pendientes" />}</tbody></table></div></div></div>}

      {tab === 'devoluciones' && <div className="stack">
        <div className="row">{canWrite && <button onClick={() => setRetForm(true)}>Nueva devolución</button>}{canInvoice && <button onClick={() => setCnForm({})}>Registrar nota de crédito</button>}</div>
        <div className="card"><h2>Devoluciones</h2><table><thead><tr><th>N.º</th><th>Fecha</th><th>Proveedor</th><th>Motivo</th><th className="num">Valor</th><th>Crédito</th><th /></tr></thead>
          <tbody>{(rets.data ?? []).map((r) => <tr key={r.id}><td>{r.number}</td><td>{fmtDate(r.created_at)}</td><td>{r.supplier_name}</td><td>{r.reason}</td><td className="num">{gs(r.total)}</td><td><Status value={r.credit_status} /></td><td>{canInvoice && ['pending', 'partial'].includes(r.credit_status) && <button className="small" onClick={() => setCnForm(r)}>Cargar nota de crédito</button>}</td></tr>)}{!rets.data?.length && <EmptyRow cols={7} />}</tbody></table></div>
        <div className="card"><h2>Notas de crédito</h2><table><thead><tr><th>Fecha</th><th>Nota</th><th>Proveedor</th><th>Devolución</th><th>Resolución</th><th className="num">Importe</th></tr></thead>
          <tbody>{(notes.data ?? []).map((n) => <tr key={n.id}><td>{fmtDate(n.doc_date)}</td><td>{n.doc_number}</td><td>{n.supplier_name}</td><td>{n.return_number ?? '—'}</td><td>{{ applied: 'Descontada de la deuda', credit_balance: 'Saldo a favor', refund: 'Reembolso' }[n.resolution as string]}</td><td className="num">{gs(n.amount)}</td></tr>)}{!notes.data?.length && <EmptyRow cols={6} />}</tbody></table></div></div>}

      {open && <OrderDetail id={open} canApprove={canApprove} canReceive={canReceive} onClose={() => { setOpen(null); if (sp.get('open')) setSp({}) }} onChange={reloadAll} />}
      {form && <OrderForm id={form.id} canApprove={canApprove} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); reloadAll(); setOpen(id) }} />}
      {invForm && <InvoiceForm onClose={() => setInvForm(false)} onSaved={() => { setInvForm(false); reloadAll() }} />}
      {invOpen && <InvoiceDetail id={invOpen} onClose={() => setInvOpen(null)} onChange={reloadAll} />}
      {retForm && <ReturnForm onClose={() => setRetForm(false)} onSaved={() => { setRetForm(false); reloadAll() }} />}
      {cnForm && <CreditNoteForm ret={cnForm.id ? cnForm : undefined} onClose={() => setCnForm(null)} onSaved={() => { setCnForm(null); reloadAll() }} />}
      {pay && <PayModal supplierId={pay.id} supplierName={pay.name} onClose={() => setPay(null)} onDone={() => { setPay(null); reloadAll() }} />}
    </>
  )
}
