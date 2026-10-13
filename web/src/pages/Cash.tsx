import { useEffect, useMemo, useState } from 'react'
import { api, gs, paymentMethodLabel, useApp } from '../api'
import { Field, fmtDateTime, Kpi, Modal, Money, Status, Tabs, useAsk, useQuery } from '../ui'

const DENOMS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 100, 50]
const total = (d: Record<string, number>) => Object.entries(d).reduce((a, [k, n]) => a + Number(k) * (n || 0), 0)

// Contador de billetes y monedas: la suma debe coincidir con el efectivo declarado.
function Denoms({ value, onChange }: { value: Record<string, number>; onChange: (d: Record<string, number>) => void }) {
  return (
    <div className="form wide" style={{ gap: 8 }}>
      {DENOMS.map((d) => (
        <label key={d} className="inline" style={{ justifyContent: 'space-between' }}>
          <span>{d.toLocaleString('es-PY')}</span>
          <input type="number" min={0} style={{ width: 80 }} value={value[d] ?? ''} onChange={(e) => onChange({ ...value, [d]: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
      ))}
      <b className="span-all">Suma: {gs(total(value))}</b>
    </div>
  )
}

function Report({ r }: { r: any }) {
  return (
    <div className="stack">
      <div className="grid cols-4">
        <Kpi label="Fondo inicial" value={gs(r.opening)} />
        <Kpi label="Efectivo esperado" value={gs(r.expected)} sub={`+${gs(r.cashIn)} / −${gs(r.cashOut)}`} />
        {r.counted != null && <Kpi label="Efectivo contado" value={gs(r.counted)} />}
        {r.difference != null && <Kpi label="Diferencia" value={gs(r.difference)} tone={r.difference === 0 ? 'ok' : 'bad'} />}
      </div>
      <h3>Cobros por medio de pago</h3>
      <table><thead><tr><th>Medio</th><th className="num">Operaciones</th><th className="num">Importe</th><th className="num">Comisión</th></tr></thead>
        <tbody>{r.byMethod.map((m: any) => <tr key={m.method}><td>{paymentMethodLabel(m.method)}</td><td className="num">{m.count}</td><td className="num">{gs(m.amount)}</td><td className="num">{gs(m.fee)}</td></tr>)}
          {!r.byMethod.length && <tr><td colSpan={4} className="muted">Sin cobros</td></tr>}</tbody></table>
      {!!r.movements.length && <><h3>Movimientos de dinero</h3>
        <table><thead><tr><th>Hora</th><th>Concepto</th><th className="num">Efecto en caja</th></tr></thead>
          <tbody>{r.movements.map((m: any, i: number) => <tr key={i}><td>{fmtDateTime(m.at)}</td><td>{m.concept}</td><td className="num">{m.account_delta == null ? '—' : gs(m.account_delta)}</td></tr>)}</tbody></table></>}
      {!!r.refunds.length && <><h3>Devoluciones y reembolsos</h3>
        <table><tbody>{r.refunds.map((m: any, i: number) => <tr key={i}><td>{fmtDateTime(m.at)}</td><td>{m.concept}</td><td className="num">{gs(m.amount)}</td></tr>)}</tbody></table></>}
      {!!r.counts?.length && <><h3>Arqueos</h3>
        <table><thead><tr><th>Hora</th><th>Tipo</th><th className="num">Esperado</th><th className="num">Contado</th><th className="num">Diferencia</th><th>Nota</th></tr></thead>
          <tbody>{r.counts.map((c: any) => <tr key={c.id}><td>{fmtDateTime(c.at)}</td><td>{c.kind === 'final' ? 'Cierre' : 'Parcial'}</td><td className="num">{gs(c.expected)}</td><td className="num">{gs(c.counted)}</td><td className="num">{gs(c.counted - c.expected)}</td><td>{c.note}</td></tr>)}</tbody></table></>}
    </div>
  )
}

export default function Cash() {
  const { user, toast } = useApp()
  const ask = useAsk()
  const [tab, setTab] = useState<'now' | 'history'>('now')
  const cur = useQuery<any>('/cash/current')
  const accounts = useQuery<any[]>('/money-accounts')
  const reserve = useQuery<{ reserve: number }>('/cash/last-reserve')
  const [openForm, setOpenForm] = useState<any>(null)
  const [mv, setMv] = useState({ type: 'out', amount: 0, reason: '' })
  const [count, setCount] = useState<any>(null)
  const [close, setClose] = useState<any>(null)
  const [view, setView] = useState<any>(null)
  const history = useQuery<any[]>(tab === 'history' ? '/cash/sessions' : null)
  const staff = ['owner', 'admin'].includes(user!.role)

  useEffect(() => { if (reserve.data && openForm === null && cur.data && !cur.data.session) setOpenForm({ openingFloat: reserve.data.reserve, shift: 'Mañana', note: '', denoms: {}, useDenoms: false }) }, [reserve.data, cur.data])
  const run = async (fn: () => Promise<any>, ok: string) => { try { const r = await fn(); toast(ok); cur.reload(); history.reload(); accounts.reload(); return r } catch (e: any) { toast(e.message, true); return null } }
  const banks = useMemo(() => (accounts.data ?? []).filter((a) => a.kind === 'bank' && a.active), [accounts.data])
  const c = cur.data

  const sessionView = async (id: number) => setView(await api('/cash/sessions/' + id))
  const approve = async (id: number) => { const note = await ask({ title: 'Aprobar la diferencia de caja', reason: true, label: 'Justificación', confirm: 'Aprobar' }); if (note) run(() => api(`/cash/sessions/${id}/approve`, { body: { note } }), 'Diferencia aprobada') }
  const reopen = async (id: number) => { const reason = await ask({ title: 'Reabrir la caja', reason: true, label: 'Motivo de la reapertura (queda registrado)', confirm: 'Reabrir', danger: true }); if (reason) run(() => api(`/cash/sessions/${id}/reopen`, { body: { reason } }), 'Caja reabierta') }

  return (
    <>
      <div className="head"><div><h1>Caja</h1><span className="muted">{c?.session ? `Abierta desde ${fmtDateTime(c.session.opened_at)}${c.session.shift ? ' · turno ' + c.session.shift : ''}` : 'Sin caja abierta'}</span></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[['now', 'Mi caja'], ['history', 'Turnos y cierres']]} />

      {tab === 'now' && !c && <p className="muted">Cargando…</p>}
      {tab === 'now' && c && !c.session && openForm && (
        <div className="card stack" style={{ maxWidth: 640 }}>
          <h2>Abrir caja</h2>
          <div className="form">
            <Field label="Fondo inicial" hint={reserve.data?.reserve ? `Quedó ${gs(reserve.data.reserve)} reservado del último cierre` : undefined}><Money value={openForm.openingFloat} onChange={(n) => setOpenForm({ ...openForm, openingFloat: n })} /></Field>
            <Field label="Turno"><select value={openForm.shift} onChange={(e) => setOpenForm({ ...openForm, shift: e.target.value })}><option>Mañana</option><option>Tarde</option><option>Noche</option><option>Completo</option></select></Field>
            <Field label="Observación" span={2}><input value={openForm.note} onChange={(e) => setOpenForm({ ...openForm, note: e.target.value })} /></Field>
          </div>
          <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={openForm.useDenoms} onChange={(e) => setOpenForm({ ...openForm, useDenoms: e.target.checked })} /> Detallar billetes y monedas</label>
          {openForm.useDenoms && <Denoms value={openForm.denoms} onChange={(d) => setOpenForm({ ...openForm, denoms: d, openingFloat: total(d) })} />}
          <button className="primary" onClick={() => run(() => api('/cash/open', { body: { openingFloat: openForm.openingFloat, shift: openForm.shift, note: openForm.note || null, denominations: openForm.useDenoms ? openForm.denoms : undefined } }), 'Caja abierta')}>Abrir caja</button>
        </div>
      )}

      {tab === 'now' && c?.session && (
        <div className="stack">
          <Report r={c} />
          <div className="grid cols-2">
            <div className="card stack">
              <h2>Ingreso o retiro de efectivo</h2>
              <div className="form">
                <Field label="Tipo"><select value={mv.type} onChange={(e) => setMv({ ...mv, type: e.target.value })}><option value="out">Retiro</option><option value="in">Ingreso</option></select></Field>
                <Field label="Monto"><Money value={mv.amount} onChange={(n) => setMv({ ...mv, amount: n })} /></Field>
                <Field label="Motivo" span={2}><input value={mv.reason} onChange={(e) => setMv({ ...mv, reason: e.target.value })} placeholder="Compra de cinta, cambio…" /></Field>
              </div>
              <button disabled={!mv.amount || mv.reason.length < 3} onClick={() => run(() => api('/cash/movements', { body: mv }), 'Movimiento registrado').then(() => setMv({ type: 'out', amount: 0, reason: '' }))}>Registrar</button>
            </div>
            <div className="card stack">
              <h2>Arqueo y cierre</h2>
              <p className="muted">El arqueo cuenta el efectivo sin cerrar el turno. El cierre compara con lo esperado y deja el depósito y el fondo del día siguiente.</p>
              <div className="row"><button onClick={() => setCount({ denoms: {}, note: '' })}>Hacer arqueo parcial</button><button className="primary" onClick={() => setClose({ denoms: {}, note: '', deposit: 0, accountId: banks[0]?.id ?? '', reserve: 0, counted: 0 })}>Cerrar caja</button></div>
            </div>
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="card table-wrap">
          <table><thead><tr><th>#</th><th>Responsable</th><th>Apertura</th><th>Cierre</th><th className="num">Esperado</th><th className="num">Contado</th><th className="num">Diferencia</th><th>Estado</th><th /></tr></thead>
            <tbody>{(history.data ?? []).map((s) => (
              <tr key={s.id}><td>{s.id}</td><td>{s.user_name}</td><td>{fmtDateTime(s.opened_at)}</td><td>{fmtDateTime(s.closed_at)}</td>
                <td className="num">{s.expected_cash == null ? '—' : gs(s.expected_cash)}</td><td className="num">{s.counted_cash == null ? '—' : gs(s.counted_cash)}</td>
                <td className="num">{s.difference == null ? '—' : <span className={'pill ' + (Number(s.difference) === 0 ? 'ok' : 'bad')}>{gs(s.difference)}</span>}</td>
                <td><Status value={s.status === 'open' ? 'open' : 'posted'} label={s.status === 'open' ? 'Abierta' : s.diff_status === 'pending_approval' ? 'Diferencia por aprobar' : 'Cerrada'} /></td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="small" onClick={() => sessionView(s.id)}>Ver</button>
                  {s.diff_status === 'pending_approval' && staff && <button className="small primary" onClick={() => approve(s.id)}>Aprobar</button>}
                  {s.status === 'closed' && staff && <button className="small" onClick={() => reopen(s.id)}>Reabrir</button>}
                </td></tr>))}
              {!history.data?.length && <tr><td colSpan={9} className="muted empty">Sin turnos</td></tr>}</tbody></table>
        </div>
      )}

      {count && (
        <Modal title="Arqueo parcial" onClose={() => setCount(null)} wide footer={<><button onClick={() => setCount(null)}>Cancelar</button>
          <button className="primary" onClick={async () => { const r = await run(() => api('/cash/count', { body: { counted: total(count.denoms), denominations: count.denoms, note: count.note || null } }), 'Arqueo registrado'); if (r) { setCount(null); toast(`Esperado ${gs(r.expected)} · contado ${gs(r.counted)} · diferencia ${gs(r.difference)}`) } }}>Registrar arqueo</button></>}>
          <Denoms value={count.denoms} onChange={(d) => setCount({ ...count, denoms: d })} />
          <Field label="Observación"><input value={count.note} onChange={(e) => setCount({ ...count, note: e.target.value })} /></Field>
        </Modal>
      )}

      {close && c && (
        <Modal title="Cerrar caja" onClose={() => setClose(null)} wide footer={<><button onClick={() => setClose(null)}>Cancelar</button>
          <button className="primary" disabled={close.deposit + close.reserve > total(close.denoms)} onClick={async () => {
            const counted = total(close.denoms)
            const r = await run(() => api('/cash/close', { body: { counted, denominations: close.denoms, note: close.note || null, deposit: close.deposit > 0 ? { amount: close.deposit, accountId: close.accountId || null } : undefined, reserve: close.reserve } }), 'Caja cerrada')
            if (r) { setClose(null); setView(r.report) }
          }}>Confirmar cierre</button></>}>
          <p>Efectivo esperado: <b>{gs(c.expected)}</b></p>
          <Denoms value={close.denoms} onChange={(d) => setClose({ ...close, denoms: d })} />
          {(() => { const diff = total(close.denoms) - c.expected; return <div className={diff === 0 ? 'okbox' : 'warnbox'}>Contado {gs(total(close.denoms))} · diferencia <b>{gs(diff)}</b>{diff !== 0 && ' — quedará registrada y requiere la aprobación de un responsable.'}</div> })()}
          <div className="form">
            <Field label="Depositar en el banco"><Money value={close.deposit} onChange={(n) => setClose({ ...close, deposit: n })} /></Field>
            <Field label="Cuenta de depósito"><select value={close.accountId} onChange={(e) => setClose({ ...close, accountId: Number(e.target.value) })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            <Field label="Fondo que queda para mañana"><Money value={close.reserve} onChange={(n) => setClose({ ...close, reserve: n })} /></Field>
            <Field label="Observación" span={2}><input value={close.note} onChange={(e) => setClose({ ...close, note: e.target.value })} /></Field>
          </div>
          {close.deposit + close.reserve > total(close.denoms) && <div className="errbox">El depósito más el fondo superan el efectivo contado.</div>}
        </Modal>
      )}

      {view && <Modal title={`Comprobante de caja #${view.session.id}`} onClose={() => setView(null)} wide="xl" footer={<><button onClick={() => window.print()}>Imprimir</button><button className="primary" onClick={() => setView(null)}>Listo</button></>}>
        <p className="muted">{view.session.user_name} · {fmtDateTime(view.session.opened_at)} → {fmtDateTime(view.session.closed_at)}{view.session.reopen_count ? ` · reabierta ${view.session.reopen_count} vez(es)` : ''}</p>
        <Report r={view} />
        {view.deposit > 0 && <p>Depositado: <b>{gs(view.deposit)}</b> · Fondo reservado: <b>{gs(view.reserve)}</b></p>}
      </Modal>}
    </>
  )
}
