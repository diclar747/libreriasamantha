import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, gs, paymentMethodLabel, useApp } from '../api'
import { EmptyRow, Field, fmtDate, fmtDateTime, Kpi, Modal, Money, Pager, qs, Status, Tabs, today, useAsk, useDebounced, useQuery } from '../ui'

const DEPARTMENTS = ['Capital', 'Central', 'Concepción', 'San Pedro', 'Cordillera', 'Guairá', 'Caaguazú', 'Caazapá', 'Itapúa', 'Misiones', 'Paraguarí', 'Alto Paraná', 'Ñeembucú', 'Amambay', 'Canindeyú', 'Presidente Hayes', 'Boquerón', 'Alto Paraguay']
const EMPTY = { name: '', legal_name: '', ruc: '', supplier_type: '', address: '', department: '', city: '', website: '', contact_name: '', contact_role: '', contact_phone: '', contact_email: '', phone: '', whatsapp: '', email: '', terms: '', notes: '',
  extra_contacts: [] as any[], payment_condition: 'credit', payment_days: 30, bank_name: '', bank_account: '', bank_holder: '', bank_alias: '', active: true }

export function PayModal({ supplierId, supplierName, onClose, onDone }: { supplierId: number; supplierName: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp()
  const sup = useQuery<any>(`/suppliers/${supplierId}`)
  const accounts = useQuery<any[]>('/money-accounts')
  const [f, setF] = useState<any>({ amount: 0, method: 'transfer', accountId: '', reference: '', paidOn: today(), useCredit: 0, advance: false, picked: {} as Record<number, number> })
  const payables: any[] = sup.data?.payables ?? []
  const picked = Object.entries(f.picked).filter(([, v]) => Number(v) > 0).map(([id, amount]) => ({ payableId: Number(id), amount: Number(amount) }))
  const pickedSum = picked.reduce((a, p) => a + p.amount, 0)
  const banks = (accounts.data ?? []).filter((a) => a.kind === 'bank' && a.active)
  const credit = Number(sup.data?.credit_balance ?? 0)
  const total = f.amount + f.useCredit
  async function submit() {
    try {
      await api(`/suppliers/${supplierId}/payments`, { body: { amount: f.amount, method: f.method, accountId: f.method !== 'cash' && (f.accountId || banks[0]?.id) ? Number(f.accountId || banks[0]?.id) : null, reference: f.reference || null, paidOn: f.paidOn, useCredit: f.useCredit || undefined, advance: f.advance || undefined, allocations: picked.length ? picked : undefined } })
      toast('Pago registrado'); onDone()
    } catch (e: any) { toast(e.message, true) }
  }
  return (
    <Modal title={`Pagar a ${supplierName}`} onClose={onClose} wide footer={<><button onClick={onClose}>Cancelar</button><button className="primary" disabled={total <= 0} onClick={submit}>Registrar pago</button></>}>
      <div className="grid cols-4"><Kpi label="Deuda total" value={gs(sup.data?.totals?.owed ?? 0)} /><Kpi label="Vencida" value={gs(sup.data?.totals?.overdue ?? 0)} tone="bad" /><Kpi label="Saldo a favor" value={gs(credit)} tone="ok" /></div>
      <div className="form">
        <Field label="Importe a pagar"><Money value={f.amount} onChange={(n) => setF({ ...f, amount: n })} /></Field>
        <Field label="Medio"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="transfer">Transferencia</option><option value="cash">Efectivo (de mi caja)</option><option value="check">Cheque</option><option value="card">Tarjeta</option></select></Field>
        {f.method !== 'cash' && <Field label="Cuenta bancaria"><select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
        <Field label="Referencia / comprobante"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Fecha de pago"><input type="date" max={today()} value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></Field>
        {credit > 0 && <Field label={`Usar saldo a favor (hasta ${gs(credit)})`}><Money value={f.useCredit} onChange={(n) => setF({ ...f, useCredit: Math.min(n, credit) })} /></Field>}
      </div>
      <h3>Aplicar a facturas <span className="muted">(si no elegís, se paga de la más vieja a la más nueva)</span></h3>
      <table><thead><tr><th>Factura</th><th>Cuota</th><th>Vence</th><th className="num">Saldo</th><th className="num">Aplicar</th></tr></thead>
        <tbody>{payables.map((p) => <tr key={p.id}><td>{p.doc_number}</td><td>{p.number}</td><td><Status value={p.state} label={fmtDate(p.due_date)} /></td><td className="num">{gs(p.pending)}</td>
          <td className="num"><Money value={f.picked[p.id]} onChange={(n) => setF({ ...f, picked: { ...f.picked, [p.id]: Math.min(n, Number(p.pending)) } })} style={{ width: 130, textAlign: 'right' }} /></td></tr>)}
          {!payables.length && <EmptyRow cols={5} text="No hay deudas pendientes" />}</tbody></table>
      {picked.length > 0 && pickedSum !== total && <div className="warnbox">Elegiste aplicar {gs(pickedSum)} pero el pago es de {gs(total)}.</div>}
      {total > Number(sup.data?.totals?.owed ?? 0) && <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={f.advance} onChange={(e) => setF({ ...f, advance: e.target.checked })} /> Registrar el excedente como anticipo al proveedor</label>}
    </Modal>
  )
}

function Ficha({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const { toast } = useApp()
  const ask = useAsk()
  const d = useQuery<any>(`/suppliers/${id}`)
  const st = useQuery<any>(`/suppliers/${id}/statement`)
  const [tab, setTab] = useState<'resumen' | 'cuenta' | 'productos' | 'documentos' | 'pagos'>('resumen')
  const [pay, setPay] = useState(false)
  const s = d.data
  if (!s) return <Modal title="Proveedor" onClose={onClose}><p className="muted">Cargando…</p></Modal>
  const reload = () => { d.reload(); st.reload(); onChange() }
  return (
    <Modal title={s.name} onClose={onClose} wide="xl" footer={<><button onClick={onClose}>Cerrar</button><button className="primary" disabled={!s.totals.owed && !s.totals.credit_balance} onClick={() => setPay(true)}>Pagar</button></>}>
      <div className="grid cols-4"><Kpi label="Deuda" value={gs(s.totals.owed)} tone={s.totals.owed ? 'warn' : undefined} /><Kpi label="Vencida" value={gs(s.totals.overdue)} tone={s.totals.overdue ? 'bad' : undefined} /><Kpi label="Saldo a favor" value={gs(s.totals.credit_balance)} tone="ok" /><Kpi label="Próximo vencimiento" value={s.totals.next_due ? fmtDate(s.totals.next_due) : '—'} /></div>
      <Tabs value={tab} onChange={setTab} tabs={[['resumen', 'Datos'], ['cuenta', 'Estado de cuenta'], ['productos', 'Productos', s.products.length], ['documentos', 'Órdenes y facturas'], ['pagos', 'Pagos y notas']]} />
      {tab === 'resumen' && <dl className="dl">
        <div><dt>Razón social</dt><dd>{s.legal_name ?? '—'}</dd></div><div><dt>RUC</dt><dd>{s.ruc ?? '—'}</dd></div><div><dt>Tipo</dt><dd>{s.supplier_type ?? '—'}</dd></div>
        <div><dt>Dirección</dt><dd>{[s.address, s.city, s.department].filter(Boolean).join(', ') || '—'}</dd></div><div><dt>Teléfono</dt><dd>{s.phone ?? '—'}</dd></div><div><dt>WhatsApp</dt><dd>{s.whatsapp ?? '—'}</dd></div><div><dt>Correo</dt><dd>{s.email ?? '—'}</dd></div><div><dt>Sitio web</dt><dd>{s.website ?? '—'}</dd></div>
        <div><dt>Contacto</dt><dd>{[s.contact_name, s.contact_role].filter(Boolean).join(' · ') || '—'}<br />{s.contact_phone} {s.contact_email}</dd></div>
        <div><dt>Condición de pago</dt><dd>{s.payment_condition === 'cash' ? 'Contado' : `Crédito a ${s.payment_days} días`}</dd></div>
        <div><dt>Banco</dt><dd>{[s.bank_name, s.bank_account, s.bank_holder, s.bank_alias].filter(Boolean).join(' · ') || '—'}</dd></div><div><dt>Notas</dt><dd>{s.notes ?? '—'}</dd></div>
      </dl>}
      {tab === 'cuenta' && <table><thead><tr><th>Fecha</th><th>Concepto</th><th className="num">Debe (factura)</th><th className="num">Haber (pago/nota)</th><th className="num">Saldo</th></tr></thead>
        <tbody>{(st.data?.lines ?? []).map((l: any, i: number) => <tr key={i}><td>{fmtDate(l.date)}</td><td>{l.concept}</td><td className="num">{l.debit ? gs(l.debit) : ''}</td><td className="num">{l.credit ? gs(l.credit) : ''}</td><td className="num">{gs(l.balance)}</td></tr>)}
          {!st.data?.lines?.length && <EmptyRow cols={5} text="Sin movimientos" />}</tbody></table>}
      {tab === 'productos' && <table><thead><tr><th>Código</th><th>Producto</th><th className="num">Stock</th>{s.products[0] && 'last_cost' in s.products[0] && <th className="num">Último costo</th>}<th /></tr></thead>
        <tbody>{s.products.map((p: any) => <tr key={p.id}><td>{p.code}</td><td>{p.name}</td><td className="num">{p.stock}</td>{'last_cost' in p && <td className="num">{p.last_cost ? gs(p.last_cost) : '—'}</td>}<td>{p.preferred && <span className="pill ok">Preferido</span>}</td></tr>)}{!s.products.length && <EmptyRow cols={5} text="Sin productos asociados" />}</tbody></table>}
      {tab === 'documentos' && <div className="stack">
        <h3>Facturas</h3><table><thead><tr><th>Fecha</th><th>Factura</th><th className="num">Total</th><th className="num">Pagado</th><th className="num">N. crédito</th><th>Estado</th></tr></thead>
          <tbody>{s.invoices.map((i: any) => <tr key={i.id}><td>{fmtDate(i.doc_date)}</td><td>{i.doc_number}</td><td className="num">{gs(i.total)}</td><td className="num">{gs(i.paid)}</td><td className="num">{gs(i.credited)}</td><td><Status value={i.status} /></td></tr>)}{!s.invoices.length && <EmptyRow cols={6} />}</tbody></table>
        <h3>Órdenes de compra</h3><table><tbody>{s.orders.map((o: any) => <tr key={o.id}><td>{o.number}</td><td>{fmtDate(o.order_date)}</td><td><Status value={o.status} /></td><td className="num">{gs(o.total)}</td></tr>)}{!s.orders.length && <EmptyRow cols={4} />}</tbody></table>
        <h3>Recepciones</h3><table><tbody>{s.receptions.map((r: any) => <tr key={r.id}><td>{r.number}</td><td>{fmtDateTime(r.received_at)}</td><td>{r.delivery_note ?? ''}</td><td><Status value={r.status} /></td></tr>)}{!s.receptions.length && <EmptyRow cols={4} />}</tbody></table></div>}
      {tab === 'pagos' && <div className="stack">
        <h3>Pagos</h3><table><thead><tr><th>Fecha</th><th>Medio</th><th>Referencia</th><th className="num">Importe</th><th /></tr></thead>
          <tbody>{s.payments.map((p: any) => <tr key={p.id} style={p.voided ? { opacity: .5 } : undefined}><td>{fmtDateTime(p.at)}</td><td>{p.method === 'credit' ? 'Saldo a favor' : paymentMethodLabel(p.method)}</td><td>{p.reference}</td><td className="num">{gs(Number(p.amount) + Number(p.credit_applied && p.method !== 'credit' ? p.credit_applied : 0))}{p.advance_amount > 0 ? ` (anticipo ${gs(p.advance_amount)})` : ''}</td>
            <td>{!p.voided && <button className="small danger" onClick={async () => { const reason = await ask({ title: 'Anular el pago', reason: true, confirm: 'Anular pago', danger: true }); if (reason) { try { await api(`/supplier-payments/${p.id}/void`, { body: { reason } }); toast('Pago anulado'); reload() } catch (e: any) { toast(e.message, true) } } }}>Anular</button>}{p.voided && <span className="pill bad">Anulado</span>}</td></tr>)}{!s.payments.length && <EmptyRow cols={5} />}</tbody></table>
        <h3>Devoluciones</h3><table><tbody>{s.returns.map((r: any) => <tr key={r.id}><td>{r.number}</td><td>{fmtDate(r.created_at)}</td><td>{r.reason}</td><td className="num">{gs(r.total)}</td><td><Status value={r.credit_status} /></td></tr>)}{!s.returns.length && <EmptyRow cols={5} />}</tbody></table>
        <h3>Notas de crédito</h3><table><tbody>{s.credit_notes.map((n: any) => <tr key={n.id}><td>{n.doc_number}</td><td>{fmtDate(n.doc_date)}</td><td>{{ applied: 'Aplicada a la deuda', credit_balance: 'Saldo a favor', refund: 'Reembolso' }[n.resolution as string]}</td><td className="num">{gs(n.amount)}</td></tr>)}{!s.credit_notes.length && <EmptyRow cols={4} />}</tbody></table></div>}
      {pay && <PayModal supplierId={id} supplierName={s.name} onClose={() => setPay(false)} onDone={() => { setPay(false); reload() }} />}
    </Modal>
  )
}

export default function Suppliers() {
  const { toast } = useApp()
  const ask = useAsk()
  const [sp, setSp] = useSearchParams()
  const [f, setF] = useState({ q: '', status: 'active', debt: '' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(30)
  const q = useDebounced(f.q)
  const list = useQuery<any>('/suppliers?' + qs({ ...f, q, page, pageSize }))
  const [form, setForm] = useState<any>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<number | null>(sp.get('open') ? Number(sp.get('open')) : null)
  const d = list.data

  const validate = (x: any) => {
    const e: Record<string, string> = {}
    if (x.name.trim().length < 2) e.name = 'El nombre comercial es obligatorio'
    if (x.ruc && !/^[0-9A-Za-z.-]{3,20}$/.test(x.ruc)) e.ruc = 'RUC no válido'
    for (const k of ['email', 'contact_email']) if (x[k] && !/^\S+@\S+\.\S+$/.test(x[k])) e[k] = 'Correo no válido'
    for (const k of ['phone', 'whatsapp', 'contact_phone']) if (x[k] && !/^[+\d][\d\s().-]{5,24}$/.test(x[k])) e[k] = 'Teléfono no válido'
    return e
  }
  async function save() {
    const e = validate(form); setErrs(e); if (Object.keys(e).length) return
    const body = { ...form }; for (const k of Object.keys(body)) if (body[k] === '') body[k] = null
    try { if (form.id) await api('/suppliers/' + form.id, { method: 'PUT', body }); else await api('/suppliers', { body }); toast('Proveedor guardado'); setForm(null); list.reload() } catch (er: any) { toast(er.message, true) }
  }
  async function remove(s: any) {
    if (!(await ask({ title: `Eliminar a ${s.name}`, confirm: 'Eliminar o desactivar', danger: true }))) return
    try { const r = await api('/suppliers/' + s.id, { method: 'DELETE' }); toast(r.deleted ? 'Proveedor eliminado' : r.message); list.reload() } catch (e: any) { toast(e.message, true) }
  }
  const set = (k: string) => (e: any) => setF2(k, e.target.value)
  const setF2 = (k: string, v: any) => setForm({ ...form, [k]: v })
  const E = (k: string) => errs[k]

  return (
    <>
      <div className="head"><div><h1>Proveedores</h1><span className="muted">{d ? `${d.total} proveedores` : ''}</span></div><button className="primary" onClick={() => { setErrs({}); setForm({ ...EMPTY }) }}>Nuevo proveedor</button></div>
      <div className="card">
        <div className="toolbar">
          <Field label="Buscar"><input value={f.q} onChange={(e) => { setF({ ...f, q: e.target.value }); setPage(1) }} placeholder="Nombre, RUC, contacto" /></Field>
          <Field label="Estado"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Activos</option><option value="inactive">Inactivos</option><option value="all">Todos</option></select></Field>
          <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={!!f.debt} onChange={(e) => setF({ ...f, debt: e.target.checked ? '1' : '' })} /> Solo con deuda</label>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Proveedor</th><th>Contacto</th><th>Condición</th><th className="num">Deuda</th><th className="num">Vencido</th><th>Próx. venc.</th><th /></tr></thead>
          <tbody>{(d?.items ?? []).map((s: any) => (
            <tr key={s.id} style={s.active ? undefined : { opacity: .55 }}>
              <td><button className="link" onClick={() => setOpen(s.id)}>{s.name}</button><div className="muted">{s.ruc ?? ''}{s.city ? ' · ' + s.city : ''}</div></td>
              <td>{s.contact_name ?? '—'}<div className="muted">{s.whatsapp ?? s.phone ?? ''}</div></td><td>{s.payment_condition === 'cash' ? 'Contado' : `Crédito ${s.payment_days} d.`}</td>
              <td className="num">{gs(s.balance)}</td><td className="num">{Number(s.overdue) > 0 ? <span className="pill bad">{gs(s.overdue)}</span> : '—'}</td><td>{s.next_due ? fmtDate(s.next_due) : '—'}</td>
              <td className="row" style={{ justifyContent: 'flex-end' }}><button className="small" onClick={() => setOpen(s.id)}>Ver</button><button className="small" onClick={async () => { setErrs({}); setForm({ ...EMPTY, ...Object.fromEntries(Object.entries(await api('/suppliers/' + s.id)).map(([k, v]) => [k, v ?? (EMPTY as any)[k] ?? ''])) }) }}>Editar</button><button className="small danger" onClick={() => remove(s)}>✕</button></td></tr>))}
            {!d?.items?.length && <EmptyRow cols={7} text="No hay proveedores" />}</tbody></table></div>
        {d && <Pager page={d.page} pages={d.pages} total={d.total} pageSize={pageSize} onPage={setPage} onSize={(s) => { setPageSize(s); setPage(1) }} />}
      </div>

      {open && <Ficha id={open} onClose={() => { setOpen(null); if (sp.get('open')) setSp({}) }} onChange={list.reload} />}
      {form && <Modal title={form.id ? 'Editar proveedor' : 'Nuevo proveedor'} onClose={() => setForm(null)} wide="xl" footer={<><button onClick={() => setForm(null)}>Cancelar</button><button className="primary" onClick={save}>Guardar</button></>}>
        <div className="form wide">
          <Field label="Nombre comercial *" error={E('name')}><input value={form.name} onChange={set('name')} autoFocus /></Field>
          <Field label="Razón social"><input value={form.legal_name} onChange={set('legal_name')} /></Field>
          <Field label="RUC" error={E('ruc')}><input value={form.ruc} onChange={set('ruc')} placeholder="80012345-6" /></Field>
          <Field label="Tipo de proveedor"><input list="stype" value={form.supplier_type} onChange={set('supplier_type')} /></Field><datalist id="stype">{['Mayorista', 'Distribuidor', 'Fabricante', 'Importador', 'Editorial', 'Servicios'].map((t) => <option key={t} />)}</datalist>
          <Field label="Dirección" span={2}><input value={form.address} onChange={set('address')} /></Field>
          <Field label="Departamento"><select value={form.department} onChange={set('department')}><option value="" />{DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}</select></Field>
          <Field label="Ciudad"><input value={form.city} onChange={set('city')} /></Field>
          <Field label="Teléfono" error={E('phone')}><input value={form.phone} onChange={set('phone')} /></Field>
          <Field label="WhatsApp" error={E('whatsapp')}><input value={form.whatsapp} onChange={set('whatsapp')} placeholder="+595 9xx xxx xxx" /></Field>
          <Field label="Correo" error={E('email')}><input value={form.email} onChange={set('email')} /></Field>
          <Field label="Sitio web"><input value={form.website} onChange={set('website')} /></Field>
          <Field label="Persona de contacto"><input value={form.contact_name} onChange={set('contact_name')} /></Field>
          <Field label="Cargo"><input value={form.contact_role} onChange={set('contact_role')} /></Field>
          <Field label="Teléfono del contacto" error={E('contact_phone')}><input value={form.contact_phone} onChange={set('contact_phone')} /></Field>
          <Field label="Correo del contacto" error={E('contact_email')}><input value={form.contact_email} onChange={set('contact_email')} /></Field>
          <Field label="Condición de pago"><select value={form.payment_condition} onChange={set('payment_condition')}><option value="credit">Crédito</option><option value="cash">Contado</option></select></Field>
          {form.payment_condition === 'credit' && <Field label="Días de crédito"><input type="number" min={0} max={365} value={form.payment_days} onChange={(e) => setF2('payment_days', Number(e.target.value))} /></Field>}
          <Field label="Banco"><input value={form.bank_name} onChange={set('bank_name')} /></Field><Field label="N.º de cuenta"><input value={form.bank_account} onChange={set('bank_account')} /></Field>
          <Field label="Titular de la cuenta"><input value={form.bank_holder} onChange={set('bank_holder')} /></Field><Field label="Alias"><input value={form.bank_alias} onChange={set('bank_alias')} /></Field>
          <Field label="Condiciones comerciales" span={2}><input value={form.terms} onChange={set('terms')} placeholder="Descuentos, mínimos, plazos de entrega…" /></Field>
          <Field label="Observaciones" span={2}><input value={form.notes} onChange={set('notes')} /></Field>
          {form.id && <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={form.active} onChange={(e) => setF2('active', e.target.checked)} /> Proveedor activo</label>}
        </div>
        <h3>Otros contactos</h3>
        {form.extra_contacts.map((c: any, i: number) => <div className="row" key={i}>{(['name', 'role', 'phone', 'email'] as const).map((k) => <input key={k} placeholder={{ name: 'Nombre', role: 'Cargo', phone: 'Teléfono', email: 'Correo' }[k]} value={c[k] ?? ''} onChange={(e) => setF2('extra_contacts', form.extra_contacts.map((x: any, j: number) => (j === i ? { ...x, [k]: e.target.value } : x)))} />)}<button className="small danger" onClick={() => setF2('extra_contacts', form.extra_contacts.filter((_: any, j: number) => j !== i))}>✕</button></div>)}
        <div><button className="small" onClick={() => setF2('extra_contacts', [...form.extra_contacts, { name: '', role: '', phone: '', email: '' }])}>+ Agregar contacto</button></div>
      </Modal>}
    </>
  )
}
