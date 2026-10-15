import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, gs, paymentMethodLabel, useApp } from '../api'
import { Attachments, EmptyRow, Field, fmtDate, fmtDateTime, Kpi, Modal, Money, Pager, qs, Status, Tabs, today, useAsk, useDebounced, useQuery } from '../ui'

type Tab = 'movimientos' | 'cuentas' | 'gastos' | 'liquidaciones'
const PAY_METHODS: [string, string][] = [['cash', 'Efectivo'], ['transfer', 'Transferencia'], ['card', 'Tarjeta'], ['check', 'Cheque']]

// ------------------------------------------------------------------ Movimientos de dinero
function Movements() {
  const accounts = useQuery<any[]>('/money-accounts')
  const [f, setF] = useState<any>({ from: today().slice(0, 8) + '01', to: today(), direction: '', method: '', accountId: '', q: '' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(30)
  const q = useDebounced(f.q)
  const data = useQuery<any>('/movements?' + qs({ ...f, q, page, pageSize }))
  const [open, setOpen] = useState<any>(null)
  const set = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.value }); setPage(1) }
  const d = data.data
  return (
    <div className="stack">
      <div className="grid cols-4">
        <Kpi label="Ingresos" value={gs(d?.income ?? 0)} tone="ok" />
        <Kpi label="Egresos" value={gs(d?.expense ?? 0)} tone="bad" />
        <Kpi label="Neto" value={gs(d?.net ?? 0)} tone={(d?.net ?? 0) >= 0 ? 'ok' : 'bad'} />
        <Kpi label="Movimientos" value={d?.total ?? 0} />
      </div>
      <div className="card">
        <div className="toolbar">
          <Field label="Desde"><input type="date" value={f.from} onChange={set('from')} /></Field><Field label="Hasta"><input type="date" value={f.to} onChange={set('to')} /></Field>
          <Field label="Tipo"><select value={f.direction} onChange={set('direction')}><option value="">Todos</option><option value="in">Ingresos</option><option value="out">Egresos</option></select></Field>
          <Field label="Medio"><select value={f.method} onChange={set('method')}><option value="">Todos</option>{['cash', 'card', 'qr', 'transfer', 'check', 'online'].map((m) => <option key={m} value={m}>{paymentMethodLabel(m)}</option>)}</select></Field>
          <Field label="Cuenta"><select value={f.accountId} onChange={set('accountId')}><option value="">Todas</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          <Field label="Buscar"><input value={f.q} onChange={set('q')} placeholder="Concepto, número, referencia" /></Field>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Medio</th><th>Cuenta</th><th>Usuario</th><th className="num">Importe</th><th className="num">Efecto en cuenta</th></tr></thead>
          <tbody>{(d?.rows ?? []).map((r: any) => (
            <tr key={r.key} className="clickable" onClick={() => setOpen(r)} style={r.voided ? { opacity: .5, textDecoration: 'line-through' } : undefined}>
              <td>{fmtDateTime(r.at)}</td><td>{r.kind_label}</td><td>{r.concept}{r.attachments ? ' 📎' : ''}{r.settlement_status === 'pending' && <span className="pill warn" style={{ marginLeft: 6 }}>Por liquidar</span>}</td>
              <td>{paymentMethodLabel(r.method)}</td><td>{r.account_name ?? '—'}</td><td>{r.user_name ?? '—'}</td>
              <td className="num"><span style={{ color: Number(r.amount) < 0 || r.direction === 'out' ? 'var(--danger)' : 'var(--ok)' }}>{gs(r.amount)}</span></td>
              <td className="num">{r.account_delta == null ? '—' : gs(r.account_delta)}</td></tr>))}
            {!d?.rows?.length && <EmptyRow cols={8} />}</tbody></table></div>
        {d && <Pager page={d.page} pages={Math.max(1, Math.ceil(d.total / d.pageSize))} total={d.total} pageSize={pageSize} onPage={setPage} onSize={(s) => { setPageSize(s); setPage(1) }} />}
      </div>
      {open && <Modal title={open.concept} onClose={() => setOpen(null)} wide footer={<button onClick={() => setOpen(null)}>Cerrar</button>}>
        <dl className="dl"><div><dt>Fecha</dt><dd>{fmtDateTime(open.at)}</dd></div><div><dt>Tipo</dt><dd>{open.kind_label}</dd></div><div><dt>Importe</dt><dd>{gs(open.amount)}</dd></div>
          <div><dt>Medio</dt><dd>{paymentMethodLabel(open.method)}</dd></div><div><dt>Cuenta</dt><dd>{open.account_name ?? '—'}</dd></div><div><dt>Documento</dt><dd>{open.ref_number ?? open.ref_type ?? '—'}</dd></div>
          <div><dt>Persona / entidad</dt><dd>{open.party_name ?? '—'}</dd></div><div><dt>Referencia</dt><dd>{open.reference ?? '—'}</dd></div><div><dt>Comisión</dt><dd>{gs(open.fee)}</dd></div></dl>
        {open.notes && <p>{open.notes}</p>}
        {['expense', 'money_movement', 'sale'].includes(open.ref_type) && <Attachments ownerType={open.ref_type} ownerId={open.ref_id} />}
      </Modal>}
    </div>
  )
}

// ------------------------------------------------------------------ Cuentas, transferencias y aportes
function Accounts() {
  const { toast } = useApp()
  const ask = useAsk()
  const accounts = useQuery<any[]>('/money-accounts')
  const [acc, setAcc] = useState<any>(null)
  const [mm, setMm] = useState<any>(null)
  const act = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); accounts.reload(); return true } catch (e: any) { toast(e.message, true); return false } }
  const list = accounts.data ?? []
  return (
    <div className="stack">
      <div className="row"><button className="primary" onClick={() => setAcc({ kind: 'bank', name: '', bankName: '', accountNumber: '', holder: '', holderDocument: '', accountType: 'Cuenta corriente', alias: '', instructions: '', onlineEnabled: false, openingBalance: 0 })}>Nueva cuenta</button>
        <button onClick={() => setMm({ kind: 'transfer', amount: 0, accountId: list[0]?.id, toAccountId: list[1]?.id, concept: '', reference: '' })}>Transferir / aporte / retiro</button></div>
      <div className="grid cols-4">{list.map((a) => <div key={a.id} className="card kpi" style={a.active ? undefined : { opacity: .5 }}><div className="label">{a.kind === 'cash' ? 'Caja' : 'Banco'} · {a.name}</div><div className="value">{gs(a.balance)}</div><div className="sub">{a.bank_name ?? ''} {a.account_number ?? ''}{a.online_enabled ? ' · cobra en la tienda' : ''}{a.is_demo ? ' · cuenta de ejemplo' : ''}</div>
        <div className="row"><button className="small" onClick={() => setAcc({ ...a, bankName: a.bank_name, accountNumber: a.account_number, holderDocument: a.holder_document, accountType: a.account_type, onlineEnabled: a.online_enabled })}>Editar</button></div></div>)}</div>

      {acc && <Modal title={acc.id ? 'Editar cuenta' : 'Nueva cuenta'} onClose={() => setAcc(null)} wide footer={<><button onClick={() => setAcc(null)}>Cancelar</button>
        <button className="primary" onClick={async () => { const body = { ...acc, bankName: acc.bankName || null, accountNumber: acc.accountNumber || null }; if (await act(() => acc.id ? api('/money-accounts/' + acc.id, { method: 'PUT', body }) : api('/money-accounts', { body }), 'Cuenta guardada')) setAcc(null) }}>Guardar</button></>}>
        <div className="form">
          {!acc.id && <Field label="Tipo"><select value={acc.kind} onChange={(e) => setAcc({ ...acc, kind: e.target.value })}><option value="bank">Cuenta bancaria</option><option value="cash">Caja</option></select></Field>}
          <Field label="Nombre"><input value={acc.name} onChange={(e) => setAcc({ ...acc, name: e.target.value })} /></Field>
          {!acc.id && <Field label="Saldo inicial"><Money value={acc.openingBalance} onChange={(n) => setAcc({ ...acc, openingBalance: n })} /></Field>}
          {acc.kind === 'bank' && <>
            <Field label="Banco"><input value={acc.bankName ?? ''} onChange={(e) => setAcc({ ...acc, bankName: e.target.value })} /></Field>
            <Field label="N.º de cuenta"><input value={acc.accountNumber ?? ''} onChange={(e) => setAcc({ ...acc, accountNumber: e.target.value })} /></Field>
            <Field label="Titular"><input value={acc.holder ?? ''} onChange={(e) => setAcc({ ...acc, holder: e.target.value })} /></Field>
            <Field label="RUC / CI del titular"><input value={acc.holderDocument ?? ''} onChange={(e) => setAcc({ ...acc, holderDocument: e.target.value })} /></Field>
            <Field label="Tipo de cuenta"><input value={acc.accountType ?? ''} onChange={(e) => setAcc({ ...acc, accountType: e.target.value })} /></Field>
            <Field label="Alias / referencia"><input value={acc.alias ?? ''} onChange={(e) => setAcc({ ...acc, alias: e.target.value })} /></Field>
            <Field label="Indicaciones para el cliente" span={2}><textarea rows={2} value={acc.instructions ?? ''} onChange={(e) => setAcc({ ...acc, instructions: e.target.value })} placeholder="Ej.: indicá el número de pedido en el concepto" /></Field>
            <label className="inline span-2"><input type="checkbox" style={{ width: 'auto' }} checked={!!acc.onlineEnabled} onChange={(e) => setAcc({ ...acc, onlineEnabled: e.target.checked })} /> Mostrar esta cuenta a los clientes de la tienda para pagar por transferencia</label>
          </>}
          {acc.id && <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={acc.active !== false} onChange={(e) => setAcc({ ...acc, active: e.target.checked })} /> Cuenta activa</label>}
        </div>
      </Modal>}

      {mm && <Modal title="Movimiento entre cuentas" onClose={() => setMm(null)} footer={<><button onClick={() => setMm(null)}>Cancelar</button>
        <button className="primary" disabled={!mm.amount || mm.concept.length < 3} onClick={async () => { if (await act(() => api('/money-movements', { body: { ...mm, toAccountId: mm.kind === 'transfer' ? mm.toAccountId : null, reference: mm.reference || null } }), 'Movimiento registrado')) setMm(null) }}>Registrar</button></>}>
        <div className="form">
          <Field label="Tipo"><select value={mm.kind} onChange={(e) => setMm({ ...mm, kind: e.target.value })}><option value="transfer">Transferencia entre cuentas</option><option value="owner_contribution">Aporte del propietario</option><option value="owner_withdrawal">Retiro del propietario</option><option value="adjustment_in">Ajuste a favor</option><option value="adjustment_out">Ajuste en contra</option></select></Field>
          <Field label="Importe"><Money value={mm.amount} onChange={(n) => setMm({ ...mm, amount: n })} /></Field>
          <Field label={mm.kind === 'transfer' ? 'Cuenta de origen' : 'Cuenta'}><select value={mm.accountId} onChange={(e) => setMm({ ...mm, accountId: Number(e.target.value) })}>{list.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          {mm.kind === 'transfer' && <Field label="Cuenta de destino"><select value={mm.toAccountId} onChange={(e) => setMm({ ...mm, toAccountId: Number(e.target.value) })}>{list.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
          <Field label="Concepto" span={2}><input value={mm.concept} onChange={(e) => setMm({ ...mm, concept: e.target.value })} /></Field>
          <Field label="Referencia"><input value={mm.reference} onChange={(e) => setMm({ ...mm, reference: e.target.value })} /></Field>
        </div>
        {['adjustment_in', 'adjustment_out'].includes(mm.kind) && <div className="warnbox">Los ajustes quedan registrados con tu nombre y deben tener un motivo claro.</div>}
      </Modal>}
      <span hidden>{String(ask)}</span>
    </div>
  )
}

// ------------------------------------------------------------------ Gastos
export function Expenses() {
  const { toast } = useApp()
  const ask = useAsk()
  const cats = useQuery<any[]>('/expense-categories')
  const [f, setF] = useState<any>({ status: '', from: '', to: '', categoryId: '', q: '' })
  const q = useDebounced(f.q)
  const list = useQuery<any[]>('/expenses?' + qs({ ...f, q }))
  const recurring = useQuery<any[]>('/recurring-expenses')
  const accounts = useQuery<any[]>('/money-accounts')
  const [form, setForm] = useState<any>(null)
  const [pay, setPay] = useState<any>(null)
  const [detail, setDetail] = useState<any>(null)
  const [catForm, setCatForm] = useState<any>(null)
  const [rec, setRec] = useState<any>(null)
  const act = async (fn: () => Promise<any>, ok: string) => { try { const r = await fn(); toast(ok); list.reload(); recurring.reload(); cats.reload(); accounts.reload(); return r ?? true } catch (e: any) { toast(e.message, true); return false } }
  const flat = useMemo(() => (cats.data ?? []).filter((c) => c.active).map((c) => ({ ...c, label: c.parent_id ? `   › ${c.name}` : c.name })), [cats.data])
  const rows = list.data ?? []
  const totalOpen = rows.filter((e) => ['pending', 'partial'].includes(e.status)).reduce((a, e) => a + Number(e.remaining), 0)
  const openDetail = async (id: number) => setDetail(await api('/expenses/' + id))
  const banks = (accounts.data ?? []).filter((a) => a.kind === 'bank' && a.active)
  return (
    <div className="stack">
      <div className="grid cols-4"><Kpi label="Gastos del filtro" value={gs(rows.filter((e) => e.status !== 'void').reduce((a, e) => a + Number(e.amount), 0))} /><Kpi label="Pendiente de pago" value={gs(totalOpen)} tone="warn" /><Kpi label="Vencidos" value={rows.filter((e) => e.overdue).length} tone="bad" /></div>
      <div className="card"><b>Registrar gasto rápido</b>
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          {['Luz', 'Agua', 'Teléfono e internet', 'Alquiler', 'Sueldos y remuneraciones', 'Impuestos y tasas', 'Limpieza y mantenimiento', 'Publicidad y marketing', 'Combustible', 'Otros gastos'].map((n) => { const c = flat.find((x) => x.name === n); return c ? <button key={n} className="small" onClick={() => setForm({ categoryId: c.id, concept: n, beneficiary: '', amount: 0, expenseDate: today(), dueDate: '', documentNumber: '', notes: '', pay: false, method: 'cash', accountId: '', reference: '' })}>{n}</button> : null })}
          <button className="small" onClick={() => setCatForm({ name: '', parentId: '' })}>+ Otra categoría</button></div></div>
      <div className="card">
        <div className="toolbar">
          <Field label="Estado"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Todos</option><option value="open">Pendientes</option><option value="paid">Pagados</option><option value="void">Anulados</option></select></Field>
          <Field label="Categoría"><select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">Todas</option>{flat.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></Field>
          <Field label="Desde"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field><Field label="Hasta"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Buscar"><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
          <span className="spacer" />
          <button onClick={() => setCatForm({ name: '', parentId: '' })}>Categorías</button><button onClick={() => setRec({ concept: '', categoryId: flat[0]?.id, amount: 0, frequency: 'monthly', nextDate: today() })}>Gasto recurrente</button>
          <button className="primary" onClick={() => setForm({ categoryId: flat[0]?.id, concept: '', beneficiary: '', amount: 0, expenseDate: today(), dueDate: '', documentNumber: '', notes: '', pay: false, method: 'cash', accountId: '', reference: '' })}>Nuevo gasto</button>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>N.º</th><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Vence</th><th className="num">Importe</th><th className="num">Saldo</th><th>Estado</th><th /></tr></thead>
          <tbody>{rows.map((e) => (
            <tr key={e.id}><td className="muted">{e.number}</td><td>{fmtDate(e.expense_date)}</td><td><button className="link" onClick={() => openDetail(e.id)}>{e.concept}</button>{e.attachments ? ' 📎' : ''}<div className="muted">{e.beneficiary}</div></td><td>{e.category}</td>
              <td>{e.due_date ? <span className={e.overdue ? 'pill bad' : ''}>{fmtDate(e.due_date)}</span> : '—'}</td><td className="num">{gs(e.amount)}</td><td className="num">{gs(e.remaining)}</td>
              <td><Status value={e.status === 'pending' ? 'open' : e.status} label={{ pending: 'Pendiente', partial: 'Pago parcial', paid: 'Pagado', void: 'Anulado' }[e.status as string]} /></td>
              <td className="row" style={{ justifyContent: 'flex-end' }}>
                {['pending', 'partial'].includes(e.status) && <button className="small primary" onClick={() => setPay({ id: e.id, concept: e.concept, remaining: Number(e.remaining), amount: Number(e.remaining), method: 'cash', accountId: banks[0]?.id ?? '', reference: '', notes: '' })}>Pagar</button>}
                {e.status !== 'void' && <button className="small danger" onClick={async () => { const reason = await ask({ title: `Anular ${e.number}`, reason: true, confirm: 'Anular', danger: true }); if (reason) act(() => api(`/expenses/${e.id}/void`, { body: { reason } }), 'Gasto anulado') }}>Anular</button>}
              </td></tr>))}
            {!rows.length && <EmptyRow cols={9} />}</tbody></table></div>
      </div>
      {!!recurring.data?.length && <div className="card"><h2>Gastos recurrentes</h2>
        <table><thead><tr><th>Concepto</th><th>Categoría</th><th>Frecuencia</th><th>Próximo</th><th className="num">Importe</th><th /></tr></thead>
          <tbody>{recurring.data.map((r) => <tr key={r.id}><td>{r.concept}</td><td>{r.category}</td><td>{{ weekly: 'Semanal', monthly: 'Mensual', yearly: 'Anual' }[r.frequency as string]}</td><td>{fmtDate(r.next_date)}</td><td className="num">{gs(r.amount)}</td>
            <td><button className="small" onClick={() => act(() => api('/recurring-expenses/' + r.id, { method: 'PUT', body: { active: !r.active } }), r.active ? 'Pausado' : 'Reactivado')}>{r.active ? 'Pausar' : 'Reactivar'}</button></td></tr>)}</tbody></table>
        <div className="row" style={{ marginTop: 10 }}><button onClick={() => act(() => api('/recurring-expenses/run', { body: {} }), 'Gastos recurrentes generados')}>Generar los que ya vencieron</button></div></div>}

      {form && <Modal title="Nuevo gasto" onClose={() => setForm(null)} wide footer={<><button onClick={() => setForm(null)}>Cancelar</button>
        <button className="primary" disabled={!form.amount || form.concept.length < 3} onClick={async () => { const body: any = { categoryId: Number(form.categoryId), concept: form.concept, beneficiary: form.beneficiary || null, amount: form.amount, expenseDate: form.expenseDate, dueDate: form.dueDate || null, documentNumber: form.documentNumber || null, notes: form.notes || null }; if (form.pay) body.payNow = { method: form.method, accountId: form.accountId ? Number(form.accountId) : null, reference: form.reference || null }; if (await act(() => api('/expenses', { body }), 'Gasto registrado')) setForm(null) }}>Guardar</button></>}>
        <div className="form">
          <Field label="Categoría"><select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>{flat.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></Field>
          <Field label="Concepto"><input value={form.concept} onChange={(e) => setForm({ ...form, concept: e.target.value })} /></Field>
          <Field label="Beneficiario / proveedor"><input value={form.beneficiary} onChange={(e) => setForm({ ...form, beneficiary: e.target.value })} /></Field>
          <Field label="Importe"><Money value={form.amount} onChange={(n) => setForm({ ...form, amount: n })} /></Field>
          <Field label="Fecha del gasto"><input type="date" value={form.expenseDate} onChange={(e) => setForm({ ...form, expenseDate: e.target.value })} /></Field>
          <Field label="Vencimiento"><input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>
          <Field label="N.º de comprobante"><input value={form.documentNumber} onChange={(e) => setForm({ ...form, documentNumber: e.target.value })} /></Field>
          <Field label="Notas"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
        <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={form.pay} onChange={(e) => setForm({ ...form, pay: e.target.checked })} /> Pagarlo ahora</label>
        {form.pay && <div className="form"><Field label="Medio"><select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{PAY_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {form.method !== 'cash' && <Field label="Cuenta"><select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
          <Field label="Referencia"><input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field></div>}
      </Modal>}

      {pay && <Modal title={`Pagar: ${pay.concept}`} onClose={() => setPay(null)} footer={<><button onClick={() => setPay(null)}>Cancelar</button>
        <button className="primary" disabled={!pay.amount || pay.amount > pay.remaining} onClick={async () => { if (await act(() => api(`/expenses/${pay.id}/pay`, { body: { amount: pay.amount, method: pay.method, accountId: pay.method !== 'cash' && pay.accountId ? Number(pay.accountId) : null, reference: pay.reference || null, notes: pay.notes || null } }), 'Pago registrado')) setPay(null) }}>Pagar</button></>}>
        <p>Saldo pendiente: <b>{gs(pay.remaining)}</b> · podés pagar una parte.</p>
        <div className="form"><Field label="Importe"><Money value={pay.amount} onChange={(n) => setPay({ ...pay, amount: n })} /></Field>
          <Field label="Medio"><select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{PAY_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {pay.method !== 'cash' && <Field label="Cuenta"><select value={pay.accountId} onChange={(e) => setPay({ ...pay, accountId: e.target.value })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
          <Field label="Referencia"><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field></div>
      </Modal>}

      {detail && <Modal title={`${detail.number} · ${detail.concept}`} onClose={() => setDetail(null)} wide footer={<button onClick={() => setDetail(null)}>Cerrar</button>}>
        <dl className="dl"><div><dt>Categoría</dt><dd>{detail.category}</dd></div><div><dt>Importe</dt><dd>{gs(detail.amount)}</dd></div><div><dt>Pagado</dt><dd>{gs(detail.paid_amount)}</dd></div><div><dt>Vence</dt><dd>{fmtDate(detail.due_date)}</dd></div><div><dt>Comprobante</dt><dd>{detail.document_number ?? '—'}</dd></div></dl>
        <h3>Pagos</h3><table><tbody>{detail.payments.map((p: any) => <tr key={p.id}><td>{fmtDateTime(p.paid_at)}</td><td>{paymentMethodLabel(p.method)}</td><td>{p.reference}</td><td>{p.user_name}</td><td className="num">{gs(p.amount)}</td></tr>)}{!detail.payments.length && <tr><td className="muted">Sin pagos</td></tr>}</tbody></table>
        <h3>Comprobantes</h3><Attachments ownerType="expense" ownerId={detail.id} />
      </Modal>}

      {catForm && <Modal title="Categorías de gasto" onClose={() => setCatForm(null)} wide footer={<button onClick={() => setCatForm(null)}>Cerrar</button>}>
        <div className="toolbar"><Field label="Nombre"><input value={catForm.name} onChange={(e) => setCatForm({ ...catForm, name: e.target.value })} /></Field>
          <Field label="Dentro de"><select value={catForm.parentId} onChange={(e) => setCatForm({ ...catForm, parentId: e.target.value })}><option value="">Categoría nueva</option>{(cats.data ?? []).filter((c) => !c.parent_id && c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <button className="primary" disabled={catForm.name.length < 2} onClick={async () => { if (await act(() => api('/expense-categories', { body: { name: catForm.name, parentId: catForm.parentId ? Number(catForm.parentId) : null } }), 'Categoría creada')) setCatForm({ name: '', parentId: '' }) }}>Agregar</button></div>
        <table><tbody>{(cats.data ?? []).map((c) => <tr key={c.id} style={c.active ? undefined : { opacity: .5 }}><td style={{ paddingLeft: c.parent_id ? 28 : undefined }}>{c.parent_id ? '› ' : ''}<b>{c.name}</b> <span className="muted">{c.uses} gastos</span></td>
          <td><button className="small" onClick={() => act(() => api('/expense-categories/' + c.id, { method: 'PUT', body: { active: !c.active } }), c.active ? 'Desactivada' : 'Reactivada')}>{c.active ? 'Desactivar' : 'Reactivar'}</button></td></tr>)}</tbody></table>
      </Modal>}

      {rec && <Modal title="Gasto recurrente" onClose={() => setRec(null)} footer={<><button onClick={() => setRec(null)}>Cancelar</button>
        <button className="primary" disabled={!rec.amount || rec.concept.length < 3} onClick={async () => { if (await act(() => api('/recurring-expenses', { body: { ...rec, categoryId: Number(rec.categoryId) } }), 'Gasto recurrente creado')) setRec(null) }}>Guardar</button></>}>
        <div className="form"><Field label="Concepto"><input value={rec.concept} onChange={(e) => setRec({ ...rec, concept: e.target.value })} /></Field>
          <Field label="Categoría"><select value={rec.categoryId} onChange={(e) => setRec({ ...rec, categoryId: e.target.value })}>{flat.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></Field>
          <Field label="Importe"><Money value={rec.amount} onChange={(n) => setRec({ ...rec, amount: n })} /></Field>
          <Field label="Frecuencia"><select value={rec.frequency} onChange={(e) => setRec({ ...rec, frequency: e.target.value })}><option value="weekly">Semanal</option><option value="monthly">Mensual</option><option value="yearly">Anual</option></select></Field>
          <Field label="Primer vencimiento"><input type="date" value={rec.nextDate} onChange={(e) => setRec({ ...rec, nextDate: e.target.value })} /></Field></div>
      </Modal>}
    </div>
  )
}

// ------------------------------------------------------------------ Liquidaciones y cheques
function Settlements() {
  const { toast } = useApp()
  const ask = useAsk()
  const [method, setMethod] = useState('')
  const pend = useQuery<any[]>('/payments/pending-settlement' + (method ? '?method=' + method : ''))
  const accounts = useQuery<any[]>('/money-accounts')
  const [sel, setSel] = useState<number[]>([])
  const [acct, setAcct] = useState('')
  const [fee, setFee] = useState<number | null>(null)
  const banks = (accounts.data ?? []).filter((a) => a.kind === 'bank' && a.active)
  const rows = pend.data ?? []
  const chosen = rows.filter((r) => sel.includes(r.id))
  const gross = chosen.reduce((a, r) => a + Number(r.amount), 0)
  const est = chosen.reduce((a, r) => a + Number(r.fee), 0)
  const isCheck = chosen.length > 0 && chosen.every((r) => r.method === 'check')
  const run = async () => { try { const r = await api('/payments/settle', { body: { ids: sel, accountId: Number(acct || banks[0]?.id), fee: isCheck ? undefined : fee ?? undefined } }); toast(`Liquidado: ${gs(r.net)} netos (comisión ${gs(r.fee)})`); setSel([]); setFee(null); pend.reload(); accounts.reload() } catch (e: any) { toast(e.message, true) } }
  return (
    <div className="card stack">
      <p className="muted">Tarjetas, QR y pagos en línea quedan pendientes hasta que el procesador los acredita en el banco; los cheques hasta depositarlos. Marcá lo acreditado y registrá la comisión real.</p>
      <div className="toolbar"><Field label="Medio"><select value={method} onChange={(e) => { setMethod(e.target.value); setSel([]) }}><option value="">Todos</option><option value="card">Tarjeta</option><option value="qr">QR</option><option value="online">Pago en línea</option><option value="check">Cheque</option></select></Field>
        <Field label="Cuenta bancaria"><select value={acct} onChange={(e) => setAcct(e.target.value)}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        {!isCheck && <Field label={`Comisión real (estimada ${gs(est)})`}><Money value={fee ?? est} onChange={setFee} /></Field>}
        <button className="primary" disabled={!sel.length || !banks.length} onClick={run}>{isCheck ? 'Depositar cheques' : 'Registrar acreditación'} ({gs(gross)})</button></div>
      <div className="table-wrap"><table>
        <thead><tr><th /><th>Fecha</th><th>Medio</th><th>Venta</th><th>Cliente</th><th>Referencia</th><th className="num">Importe</th><th className="num">Comisión estimada</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td><input type="checkbox" style={{ width: 'auto' }} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td>
            <td>{fmtDateTime(r.at)}</td><td>{paymentMethodLabel(r.method)}{r.details?.type ? ` (${r.details.type === 'debit' ? 'débito' : 'crédito'})` : ''}{r.method === 'check' && r.details?.number ? ` #${r.details.number}` : ''}</td><td>{r.sale_number ?? 'Cobranza'}</td><td>{r.customer_name ?? '—'}</td><td>{r.reference ?? '—'}</td>
            <td className="num">{gs(r.amount)}</td><td className="num">{gs(r.fee)}</td>
            <td>{r.method === 'check' && <button className="small danger" onClick={async () => { const reason = await ask({ title: 'Cheque rechazado', reason: true, confirm: 'Registrar rechazo', danger: true }); if (reason) { try { await api(`/payments/${r.id}/reject`, { body: { reason } }); toast('Cheque rechazado: la deuda volvió al cliente'); pend.reload() } catch (e: any) { toast(e.message, true) } } }}>Rechazado</button>}</td></tr>))}
          {!rows.length && <EmptyRow cols={9} text="Nada pendiente de liquidar" />}</tbody></table></div>
    </div>
  )
}

export default function Finance() {
  const [sp, setSp] = useSearchParams()
  const tab = (sp.get('tab') as Tab) || 'movimientos'
  return (
    <>
      <div className="head"><div><h1>Dinero y gastos</h1><span className="muted">Movimientos, cuentas, gastos y liquidaciones</span></div></div>
      <Tabs value={tab} onChange={(t) => setSp({ tab: t })} tabs={[['movimientos', 'Movimientos'], ['cuentas', 'Cuentas y bancos'], ['gastos', 'Gastos'], ['liquidaciones', 'Liquidaciones y cheques']]} />
      {tab === 'movimientos' && <Movements />}{tab === 'cuentas' && <Accounts />}{tab === 'gastos' && <Expenses />}{tab === 'liquidaciones' && <Settlements />}
    </>
  )
}

// Pantalla propia de gastos (luz, agua, teléfono, alquiler, sueldos…), con acceso directo en el menú.
export function ExpensesPage() {
  return (
    <>
      <div className="head"><div><h1>Gastos</h1><span className="muted">Registrá luz, agua, teléfono, alquiler, sueldos y todo gasto del negocio, por categoría</span></div></div>
      <Expenses />
    </>
  )
}
