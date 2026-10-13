import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, gs, paymentMethodLabel, useApp } from '../api'
import { EmptyRow, Field, fmtDate, fmtDateTime, Kpi, Modal, Money, Pager, Status, Tabs, useDebounced, useQuery } from '../ui'

const agingLabel = (d: number) => (d <= 0 ? 'Al día' : d <= 30 ? '1–30 días' : d <= 60 ? '31–60 días' : d <= 90 ? '61–90 días' : 'Más de 90 días')

function Statement({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const { user, toast } = useApp()
  const d = useQuery<any>(`/customers/${id}/statement`)
  const accounts = useQuery<any[]>('/money-accounts')
  const [tab, setTab] = useState<'cuotas' | 'movimientos' | 'cobros' | 'tienda'>('cuotas')
  const portal = useQuery<any>(`/customers/${id}/portal`)
  const [pay, setPay] = useState<any>(null)
  const collect = ['owner', 'admin', 'cashier'].includes(user!.role)
  const s = d.data
  if (!s) return <Modal title="Cliente" onClose={onClose}><p className="muted">Cargando…</p></Modal>
  const c = s.customer
  const aging = [0, 0, 0, 0, 0]
  for (const i of s.installments) { const dl = Number(i.days_late); aging[dl <= 0 ? 0 : dl <= 30 ? 1 : dl <= 60 ? 2 : dl <= 90 ? 3 : 4] += Number(i.pending) }
  const banks = (accounts.data ?? []).filter((a) => a.kind === 'bank' && a.active)
  async function submit() {
    const details: any = {}
    if (pay.method === 'card') { details.type = pay.cardType; details.processor = pay.processor || undefined; details.last4 = pay.last4 || undefined }
    if (pay.method === 'transfer') { details.accountId = pay.accountId ? Number(pay.accountId) : undefined; details.bank = pay.bank || undefined }
    if (pay.method === 'check') Object.assign(details, { number: pay.checkNumber, bank: pay.bank, holder: pay.holder, date: pay.checkDate || undefined })
    try { const r = await api(`/customers/${id}/payments`, { body: { amount: pay.amount, method: pay.method, details, reference: pay.reference || null } }); toast(`Pago registrado. Saldo: ${gs(r.balance)}`); setPay(null); d.reload(); onChange() } catch (e: any) { toast(e.message, true) }
  }
  return (
    <Modal title={c.name} onClose={onClose} wide="xl" footer={<>{collect && Number(c.balance) > 0 && <button className="primary" onClick={() => setPay({ amount: Math.min(Number(c.balance), Number(s.overdue) || Number(c.balance)), method: 'cash', cardType: 'credit', processor: '', last4: '', accountId: banks[0]?.id ?? '', bank: '', checkNumber: '', holder: c.name, checkDate: '', reference: '' })}>Registrar cobro</button>}<button onClick={onClose}>Cerrar</button></>}>
      <div className="grid cols-4"><Kpi label="Deuda" value={gs(c.balance)} tone={Number(c.balance) ? 'warn' : undefined} /><Kpi label="Vencida" value={gs(s.overdue)} tone={s.overdue ? 'bad' : undefined} /><Kpi label="Límite de crédito" value={gs(c.credit_limit)} /><Kpi label="Disponible" value={gs(Math.max(Number(c.credit_limit) - Number(c.balance), 0))} tone="ok" /></div>
      <div className="chips">{['Al día', '1–30', '31–60', '61–90', '+90'].map((l, i) => <span className="chip" key={l}>{l}: <b>{gs(aging[i])}</b></span>)}</div>
      <Tabs value={tab} onChange={setTab} tabs={[['cuotas', 'Cuotas pendientes', s.installments.length], ['movimientos', 'Movimientos'], ['cobros', 'Cobros'], ['tienda', 'Tienda en línea', portal.data?.orders?.length]]} />
      {tab === 'cuotas' && <table><thead><tr><th>Venta</th><th>Cuota</th><th>Vence</th><th className="num">Importe</th><th className="num">Pendiente</th><th>Antigüedad</th></tr></thead>
        <tbody>{s.installments.map((i: any) => <tr key={i.id}><td>{i.sale_number ?? '—'}</td><td>{i.number}</td><td>{fmtDate(i.due_date)}</td><td className="num">{gs(i.amount)}</td><td className="num">{gs(i.pending)}</td><td><span className={'pill ' + (i.overdue ? 'bad' : 'ok')}>{i.overdue ? `Vencida ${i.days_late} días` : 'Al día'}</span> <span className="muted">{agingLabel(Number(i.days_late))}</span></td></tr>)}{!s.installments.length && <EmptyRow cols={6} text="Sin cuotas pendientes" />}</tbody></table>}
      {tab === 'movimientos' && <table><thead><tr><th>Fecha</th><th>Detalle</th><th className="num">Importe</th></tr></thead><tbody>{s.ledger.map((l: any) => <tr key={l.id}><td>{fmtDateTime(l.at)}</td><td>{l.note}</td><td className="num">{gs(l.amount)}</td></tr>)}{!s.ledger.length && <EmptyRow cols={3} />}</tbody></table>}
      {tab === 'cobros' && <table><thead><tr><th>Fecha</th><th>Medio</th><th>Referencia</th><th className="num">Importe</th></tr></thead><tbody>{s.payments.map((p: any) => <tr key={p.id}><td>{fmtDateTime(p.at)}</td><td>{paymentMethodLabel(p.method)}</td><td>{p.reference ?? ''}</td><td className="num">{gs(p.amount)}</td></tr>)}{!s.payments.length && <EmptyRow cols={4} />}</tbody></table>}
      {tab === 'tienda' && portal.data && <div className="stack">
        <div className="grid cols-4"><Kpi label="Compras del local" value={portal.data.stats.purchases} /><Kpi label="Total comprado" value={gs(portal.data.stats.total)} /><Kpi label="Pedidos en línea" value={portal.data.stats.onlineOrders} /><Kpi label="Última compra" value={portal.data.stats.lastPurchase ? fmtDate(portal.data.stats.lastPurchase) : '—'} sub={portal.data.stats.pendingPayments ? portal.data.stats.pendingPayments + ' pagos pendientes' : undefined} tone={portal.data.stats.pendingPayments ? 'warn' : undefined} /></div>
        {portal.data.account ? <dl className="dl"><div><dt>Cuenta de la tienda</dt><dd>{portal.data.account.email} {portal.data.account.email_verified ? <span className="pill ok">verificado</span> : <span className="pill warn">sin verificar</span>}</dd></div><div><dt>Contacto</dt><dd>{portal.data.account.phone ?? '—'} · WhatsApp {portal.data.account.whatsapp ?? '—'}</dd></div><div><dt>Documento</dt><dd>{portal.data.account.document ?? '—'}</dd></div><div><dt>Facturación</dt><dd>{portal.data.account.billing_name ?? '—'} {portal.data.account.billing_doc}</dd></div><div><dt>Último ingreso</dt><dd>{portal.data.account.last_login ? fmtDateTime(portal.data.account.last_login) : '—'}</dd></div></dl> : <p className="muted">Este cliente todavía no tiene cuenta en la tienda en línea.</p>}
        {!!portal.data.addresses.length && <><h3>Direcciones</h3>{portal.data.addresses.map((a: any, i: number) => <p key={i} style={{ margin: 0 }}><b>{a.label ?? 'Dirección'}</b>{a.is_default && ' (predeterminada)'} — {a.street} {a.house_number}, {[a.neighborhood, a.city_name].filter(Boolean).join(', ')} {a.reference ? '· ' + a.reference : ''}</p>)}</>}
        <h3>Pedidos de la tienda</h3><table><tbody>{portal.data.orders.map((o: any) => <tr key={o.id}><td><Link to={'/orders?tab=pedidos&q=' + o.number}>{o.number}</Link></td><td>{fmtDate(o.created_at)}</td><td>{o.stage_label}</td><td>{o.payment_status}</td><td className="num">{gs(o.total)}</td></tr>)}{!portal.data.orders.length && <EmptyRow cols={5} text="Sin pedidos en línea" />}</tbody></table></div>}
      {pay && <Modal title="Registrar cobro" onClose={() => setPay(null)} footer={<><button onClick={() => setPay(null)}>Cancelar</button><button className="primary" disabled={!pay.amount || pay.amount > Number(c.balance)} onClick={submit}>Cobrar {gs(pay.amount)}</button></>}>
        <p className="muted">El cobro se aplica a las cuotas más antiguas primero. Deuda actual: {gs(c.balance)}.</p>
        <div className="form"><Field label="Importe"><Money value={pay.amount} onChange={(n) => setPay({ ...pay, amount: n })} /></Field>
          <Field label="Medio"><select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option value="cash">Efectivo</option><option value="transfer">Transferencia</option><option value="card">Tarjeta</option><option value="qr">QR</option><option value="check">Cheque</option></select></Field>
          {pay.method === 'card' && <><Field label="Tipo"><select value={pay.cardType} onChange={(e) => setPay({ ...pay, cardType: e.target.value })}><option value="credit">Crédito</option><option value="debit">Débito</option></select></Field><Field label="Procesador"><input value={pay.processor} onChange={(e) => setPay({ ...pay, processor: e.target.value })} /></Field><Field label="Últimos 4 dígitos"><input maxLength={4} value={pay.last4} onChange={(e) => setPay({ ...pay, last4: e.target.value })} /></Field></>}
          {pay.method === 'transfer' && <><Field label="Cuenta destino"><select value={pay.accountId} onChange={(e) => setPay({ ...pay, accountId: e.target.value })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field><Field label="Banco de origen"><input value={pay.bank} onChange={(e) => setPay({ ...pay, bank: e.target.value })} /></Field></>}
          {pay.method === 'check' && <><Field label="N.º de cheque *"><input value={pay.checkNumber} onChange={(e) => setPay({ ...pay, checkNumber: e.target.value })} /></Field><Field label="Banco *"><input value={pay.bank} onChange={(e) => setPay({ ...pay, bank: e.target.value })} /></Field><Field label="Titular *"><input value={pay.holder} onChange={(e) => setPay({ ...pay, holder: e.target.value })} /></Field><Field label="Fecha de cobro"><input type="date" value={pay.checkDate} onChange={(e) => setPay({ ...pay, checkDate: e.target.value })} /></Field></>}
          <Field label="Referencia"><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field></div>
        {['card', 'qr', 'check'].includes(pay.method) && <div className="warnbox">Este cobro queda <b>pendiente de acreditación</b> hasta que lo liquides en Dinero y gastos → Liquidaciones.</div>}
      </Modal>}
    </Modal>
  )
}

export default function Customers() {
  const { user, toast } = useApp()
  const [sp, setSp] = useSearchParams()
  const [q, setQ] = useState('')
  const [debt, setDebt] = useState(false)
  const [form, setForm] = useState<any>(null)
  const [open, setOpen] = useState<number | null>(sp.get('open') ? Number(sp.get('open')) : null)
  const [page, setPage] = useState(1)
  const dq = useDebounced(q)
  const list = useQuery<any[]>('/customers?q=' + encodeURIComponent(dq))
  const admin = ['owner', 'admin'].includes(user!.role)
  const rows = (list.data ?? []).filter((c) => !debt || Number(c.balance) > 0)
  const view = rows.slice((page - 1) * 30, page * 30)
  async function save() {
    if (form.name.trim().length < 2) { toast('El nombre es obligatorio', true); return }
    try {
      if (form.id) await api('/customers/' + form.id, { method: 'PUT', body: { name: form.name, ruc: form.ruc || null, phone: form.phone || null, email: form.email || null, address: form.address || null, ...(admin ? { credit_limit: Number(form.credit_limit) } : {}) } })
      else await api('/customers', { body: { name: form.name, ruc: form.ruc || null, phone: form.phone || null, email: form.email || null, address: form.address || null } })
      toast('Cliente guardado'); setForm(null); list.reload()
    } catch (e: any) { toast(e.message, true) }
  }
  return (
    <>
      <div className="head"><div><h1>Clientes y crédito</h1><span className="muted">{rows.length} clientes · deuda total {gs(rows.reduce((a, c) => a + Number(c.balance), 0))}</span></div><button className="primary" onClick={() => setForm({ name: '', ruc: '', phone: '', email: '', address: '', credit_limit: 0 })}>Nuevo cliente</button></div>
      <div className="card">
        <div className="toolbar"><Field label="Buscar"><input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Nombre, RUC, teléfono" /></Field><label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={debt} onChange={(e) => setDebt(e.target.checked)} /> Solo con deuda</label></div>
        <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>RUC</th><th>Teléfono</th><th className="num">Límite</th><th className="num">Deuda</th><th /></tr></thead>
          <tbody>{view.map((c) => <tr key={c.id}><td><button className="link" onClick={() => setOpen(c.id)}>{c.name}</button></td><td>{c.ruc}</td><td>{c.phone}</td><td className="num">{gs(c.credit_limit)}</td><td className="num">{Number(c.balance) > 0 ? <span className="pill warn">{gs(c.balance)}</span> : gs(c.balance)}</td>
            <td className="row" style={{ justifyContent: 'flex-end' }}><button className="small" onClick={() => setOpen(c.id)}>Cuenta</button><button className="small" onClick={() => setForm({ ...c })}>Editar</button></td></tr>)}{!view.length && <EmptyRow cols={6} text="Sin clientes" />}</tbody></table></div>
        <Pager page={page} pages={Math.max(1, Math.ceil(rows.length / 30))} total={rows.length} pageSize={30} onPage={setPage} />
      </div>
      {open && <Statement id={open} onClose={() => { setOpen(null); if (sp.get('open')) setSp({}) }} onChange={list.reload} />}
      {form && <Modal title={form.id ? 'Editar cliente' : 'Nuevo cliente'} onClose={() => setForm(null)} footer={<><button onClick={() => setForm(null)}>Cancelar</button><button className="primary" onClick={save}>Guardar</button></>}>
        <div className="form"><Field label="Nombre *"><input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field><Field label="RUC / CI"><input value={form.ruc ?? ''} onChange={(e) => setForm({ ...form, ruc: e.target.value })} /></Field>
          <Field label="Teléfono"><input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field><Field label="Correo"><input value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Dirección" span={2}><input value={form.address ?? ''} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
          {admin && form.id && <Field label="Límite de crédito"><Money value={form.credit_limit} onChange={(n) => setForm({ ...form, credit_limit: n })} /></Field>}</div></Modal>}
    </>
  )
}
