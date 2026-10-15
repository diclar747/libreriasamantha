import { useEffect, useState } from 'react'
import { api, gs, useApp } from '../api'
import { EmptyRow, Field, fmtDateTime, Kpi, Modal, Money, Pager, qs, Tabs, today, useDebounced, useQuery } from '../ui'

// Módulo Delivery: tarifa general (Gs. 30.000 en todas las ciudades), tarifa propia por departamento/ciudad, activar o desactivar
// entregas por ubicación, delivery gratis (por monto, siempre o por promoción), plazos, historial de cambios y cobros por ciudad.
// El precio lo calcula siempre el servidor al crear el pedido, y el pedido guarda una copia de lo cobrado.

const FREE_OPTS: [string, string][] = [['global', 'Según la promoción general'], ['never', 'Nunca gratis'], ['amount', 'Gratis desde un monto'], ['always', 'Siempre gratis']]
const depLabel = (d: string) => (d === 'Capital' ? 'Capital (Asunción)' : d)
type TabKey = 'ciudades' | 'departamentos' | 'ajustes' | 'historial' | 'cobros'
const freeText = (r: { freeMode: string; freeFrom: number | null }) => (r.freeMode === 'amount' ? `Gratis desde ${gs(r.freeFrom ?? 0)}` : r.freeMode === 'always' ? 'Siempre gratis' : r.freeMode === 'never' ? 'Nunca gratis' : 'Promoción general')

export default function Delivery() {
  const { user } = useApp()
  const canEdit = user?.role === 'owner' || user?.role === 'admin'
  const [tab, setTab] = useState<TabKey>('ciudades')
  const [f, setF] = useState({ department: '', q: '', state: 'all', page: 1 })
  const ov = useQuery<any>('/delivery/overview')
  const o = ov.data
  const cfg = o?.config
  const kp = o?.kpis
  const goCities = (department: string) => { setF({ department, q: '', state: 'all', page: 1 }); setTab('ciudades') }
  return (
    <>
      <div className="head"><div><h1>Delivery</h1><span className="muted">Tarifas por departamento y ciudad, delivery gratis y plazos de entrega. {canEdit ? '' : 'Solo lectura: los cambios los hace el administrador.'}</span></div></div>
      <div className="kpis" style={{ marginBottom: 16 }}>
        <Kpi label="Tarifa general" value={cfg ? gs(cfg.baseFee) : '…'} sub="Se cobra en toda ciudad sin tarifa propia" />
        <Kpi label="Ciudades con delivery" value={kp ? `${kp.enabled} de ${kp.cities}` : '…'} sub={kp?.disabled ? `${kp.disabled} desactivadas` : '17 departamentos + Capital'} tone={kp?.disabled ? 'warn' : undefined} />
        <Kpi label="Con tarifa propia" value={kp ? kp.custom : '…'} sub={kp ? `${kp.cities - kp.custom} usan la tarifa general` : ''} />
        <Kpi label="Delivery gratis" value={cfg ? (cfg.freeFrom === null ? 'Sin promoción' : cfg.promoIsActive ? `Desde ${gs(cfg.freeFrom)}` : 'Promoción fuera de fecha') : '…'} sub={kp?.freeRules ? `${kp.freeRules} ciudades con regla propia` : 'Configurable en «Promoción y ajustes»'} tone={cfg && !cfg.enabled ? 'bad' : undefined} />
      </div>
      {cfg && !cfg.enabled && <div className="errbox" style={{ marginBottom: 14 }}><b>El delivery está pausado en todo el país.</b> Los clientes solo pueden retirar en el local. Se reactiva en «Promoción y ajustes».</div>}
      <Tabs value={tab} onChange={setTab} tabs={[['ciudades', 'Ciudades'], ['departamentos', 'Departamentos'], ['ajustes', 'Promoción y ajustes'], ['historial', 'Historial de cambios'], ['cobros', 'Cobros por ciudad']]} />
      {tab === 'ciudades' && <Cities f={f} setF={setF} canEdit={canEdit} baseFee={cfg?.baseFee ?? 30000} onChanged={ov.reload} />}
      {tab === 'departamentos' && <Departments rows={o?.departments ?? []} canEdit={canEdit} baseFee={cfg?.baseFee ?? 30000} onOpen={goCities} onChanged={ov.reload} />}
      {tab === 'ajustes' && cfg && <Settings cfg={cfg} canEdit={canEdit} onSaved={ov.reload} />}
      {tab === 'historial' && <History departments={(o?.departments ?? []).map((d: any) => d.department)} />}
      {tab === 'cobros' && <Charges />}
    </>
  )
}

// ------------------------------------------------------------------------------------------------ Ciudades
function Cities({ f, setF, canEdit, baseFee, onChanged }: { f: { department: string; q: string; state: string; page: number }; setF: (v: any) => void; canEdit: boolean; baseFee: number; onChanged: () => void }) {
  const { toast } = useApp()
  const q = useDebounced(f.q)
  const data = useQuery<any>('/delivery/cities?' + qs({ department: f.department, q, state: f.state === 'all' ? '' : f.state, page: f.page, size: 60 }))
  const rows: any[] = data.data?.cities ?? []
  const [sel, setSel] = useState<number[]>([])
  const [edit, setEdit] = useState<any>(null)
  const [bulk, setBulk] = useState<any>(null)
  const [adding, setAdding] = useState<any>(null)
  useEffect(() => { setSel([]) }, [f.department, q, f.state, f.page])
  const patch = async (id: number, body: object, msg = 'Guardado') => { try { await api(`/delivery/cities/${id}`, { method: 'PUT', body }); toast(msg); data.reload(); onChanged() } catch (e: any) { toast(e.message, true) } }
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: 1 })
  const all = rows.length > 0 && sel.length === rows.length
  return (
    <div className="card">
      <div className="toolbar">
        <Field label="Departamento"><select value={f.department} onChange={set('department')}><option value="">Todos</option>{(data.data?.departments ?? []).map((d: string) => <option key={d} value={d}>{depLabel(d)}</option>)}</select></Field>
        <Field label="Buscar ciudad"><input value={f.q} onChange={set('q')} placeholder="Ej.: Encarnación" /></Field>
        <Field label="Mostrar"><select value={f.state} onChange={set('state')}><option value="all">Todas</option><option value="enabled">Con delivery</option><option value="disabled">Sin delivery</option><option value="custom">Con tarifa propia</option><option value="free">Con regla de delivery gratis</option></select></Field>
        <span className="spacer" />
        {canEdit && <>
          <button disabled={!sel.length} onClick={() => setBulk({ target: { ids: sel }, label: `${sel.length} ciudades seleccionadas` })}>Cambiar seleccionadas ({sel.length})</button>
          {f.department && !sel.length && <button onClick={() => setBulk({ target: { department: f.department }, label: `todo ${depLabel(f.department)}` })}>Cambiar todo {depLabel(f.department)}</button>}
          <button onClick={() => setAdding({ department: f.department || data.data?.departments?.[0] || '', name: '' })}>Agregar ciudad</button></>}
      </div>
      <p className="muted" style={{ margin: '0 0 10px' }}>{data.data?.total ?? '…'} ciudades. Sin tarifa propia se cobra la general ({gs(baseFee)}). Los cambios se guardan al instante y no afectan pedidos ya hechos.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>{canEdit && <input type="checkbox" style={{ width: 'auto' }} checked={all} onChange={(e) => setSel(e.target.checked ? rows.map((r) => r.id) : [])} aria-label="Elegir todas" />}</th><th>Ciudad</th><th>Delivery</th><th className="num">Tarifa</th><th>Delivery gratis</th><th>Plazo</th><th className="num">Pedidos</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={r.enabled ? undefined : { opacity: .55 }}>
              <td>{canEdit && <input type="checkbox" style={{ width: 'auto' }} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} aria-label={`Elegir ${r.name}`} />}</td>
              <td><b>{r.name}</b><br /><small className="muted">{depLabel(r.department)}</small></td>
              <td><label className="inline"><input type="checkbox" style={{ width: 'auto' }} disabled={!canEdit} checked={r.enabled} onChange={(e) => patch(r.id, { active: e.target.checked }, e.target.checked ? `Delivery activado en ${r.name}` : `Delivery desactivado en ${r.name}`)} />{r.enabled ? 'Activo' : 'Sin delivery'}</label></td>
              <td className="num"><FeeInput value={r.price} baseFee={baseFee} disabled={!canEdit || !r.enabled} onSave={(v) => patch(r.id, { price: v }, v === null ? `${r.name}: vuelve a la tarifa general` : `${r.name}: ${gs(v)}`)} /></td>
              <td>{canEdit ? <select style={{ minWidth: 190 }} value={r.freeMode} disabled={!r.enabled} onChange={(e) => { if (e.target.value === 'amount') setEdit({ ...r, freeMode: 'amount', freeFrom: r.freeFrom ?? 0, ownFee: r.price !== null }); else patch(r.id, { freeMode: e.target.value }, 'Guardado') }}>{FREE_OPTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select> : freeText(r)}
                {r.freeMode === 'amount' && <small className="muted"> desde {gs(r.freeFrom ?? 0)}</small>}</td>
              <td><TextInput value={r.eta ?? ''} placeholder="Plazo general" disabled={!canEdit || !r.enabled} onSave={(v) => patch(r.id, { eta: v || null })} /></td>
              <td className="num">{r.orders}</td>
              <td className="row">{canEdit && <button className="small" onClick={() => setEdit({ ...r, ownFee: r.price !== null })}>Más</button>}</td>
            </tr>))}
          {!rows.length && <EmptyRow cols={8} text={data.loading ? 'Cargando…' : 'No hay ciudades con ese filtro'} />}
        </tbody></table></div>
      <Pager page={data.data?.page ?? 1} pages={data.data?.pages ?? 1} total={data.data?.total ?? 0} pageSize={60} onPage={(p) => setF({ ...f, page: p })} />

      {edit && <Modal title={`Delivery a ${edit.name}`} wide onClose={() => setEdit(null)} footer={<><button onClick={() => setEdit(null)}>Cancelar</button><button className="primary" onClick={async () => {
        const body = { active: edit.enabled, price: edit.ownFee ? edit.price ?? 0 : null, freeMode: edit.freeMode, freeFrom: edit.freeMode === 'amount' ? edit.freeFrom : null, eta: edit.eta || null, notes: edit.notes || null, specialZones: (edit.specialZones ?? []).filter((z: any) => z.name?.trim()) }
        try { await api(`/delivery/cities/${edit.id}`, { method: 'PUT', body }); toast('Guardado'); setEdit(null); data.reload(); onChanged() } catch (e: any) { toast(e.message, true) } }}>Guardar</button></>}>
        <div className="form">
          <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /> Se hace delivery a esta ciudad</label>
          <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={edit.ownFee} onChange={(e) => setEdit({ ...edit, ownFee: e.target.checked })} /> Tarifa propia (si no, se cobra la general: {gs(baseFee)})</label>
          {edit.ownFee && <Field label="Tarifa de esta ciudad" hint="0 = delivery sin costo"><Money value={edit.price ?? 0} onChange={(n) => setEdit({ ...edit, price: n })} /></Field>}
          <Field label="Delivery gratis"><select value={edit.freeMode} onChange={(e) => setEdit({ ...edit, freeMode: e.target.value })}>{FREE_OPTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {edit.freeMode === 'amount' && <Field label="Gratis en compras desde"><Money value={edit.freeFrom ?? 0} onChange={(n) => setEdit({ ...edit, freeFrom: n })} /></Field>}
          <Field label="Plazo estimado"><input value={edit.eta ?? ''} onChange={(e) => setEdit({ ...edit, eta: e.target.value })} placeholder="Ej.: 24 a 48 horas" /></Field>
          <Field label="Notas para el cliente" span={2}><input value={edit.notes ?? ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} placeholder="Ej.: Entregas martes y jueves" /></Field>
        </div>
        <h3>Barrios o zonas con tarifa especial</h3>
        {(edit.specialZones ?? []).map((z: any, i: number) => <div className="row" key={i}>
          <input placeholder="Barrio o zona" value={z.name} onChange={(e) => setEdit({ ...edit, specialZones: edit.specialZones.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x)) })} />
          <Money style={{ width: 150 }} value={z.fee} onChange={(n) => setEdit({ ...edit, specialZones: edit.specialZones.map((x: any, j: number) => (j === i ? { ...x, fee: n } : x)) })} />
          <button className="small danger" onClick={() => setEdit({ ...edit, specialZones: edit.specialZones.filter((_: any, j: number) => j !== i) })}>Quitar</button></div>)}
        <div><button className="small" onClick={() => setEdit({ ...edit, specialZones: [...(edit.specialZones ?? []), { name: '', fee: baseFee }] })}>+ Agregar zona</button></div>
      </Modal>}

      {bulk && <BulkModal bulk={bulk} baseFee={baseFee} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSel([]); data.reload(); onChanged() }} />}

      {adding && <Modal title="Agregar ciudad al catálogo" onClose={() => setAdding(null)} footer={<><button onClick={() => setAdding(null)}>Cancelar</button><button className="primary" disabled={adding.name.trim().length < 2} onClick={async () => {
        try { await api('/delivery/cities', { body: adding }); toast('Ciudad agregada: ya tiene la tarifa general'); setAdding(null); data.reload(); onChanged() } catch (e: any) { toast(e.message, true) } }}>Agregar</button></>}>
        <div className="form"><Field label="Departamento"><select value={adding.department} onChange={(e) => setAdding({ ...adding, department: e.target.value })}>{(data.data?.departments ?? []).map((d: string) => <option key={d} value={d}>{depLabel(d)}</option>)}</select></Field>
          <Field label="Nombre de la ciudad o barrio"><input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} autoFocus /></Field></div>
        <p className="muted">El catálogo ya trae los 263 municipios oficiales. Agregá solo localidades que falten.</p>
      </Modal>}
    </div>
  )
}

// Tarifa editable en la misma fila: vacío = tarifa general; se guarda al salir del campo.
function FeeInput({ value, baseFee, disabled, onSave }: { value: number | null; baseFee: number; disabled?: boolean; onSave: (v: number | null) => void }) {
  const [txt, setTxt] = useState(value === null ? '' : value.toLocaleString('es-PY'))
  useEffect(() => { setTxt(value === null ? '' : value.toLocaleString('es-PY')) }, [value])
  const commit = () => { const digits = txt.replace(/\D/g, ''); const v = digits === '' ? null : Number(digits); if (v !== value) onSave(v) }
  return <span className="fee-cell"><input inputMode="numeric" value={txt} disabled={disabled} placeholder={`General ${gs(baseFee)}`} style={{ textAlign: 'right', minWidth: 150 }}
    onChange={(e) => setTxt(e.target.value.replace(/\D/g, '') === '' ? '' : Number(e.target.value.replace(/\D/g, '')).toLocaleString('es-PY'))} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
</span>
}
function TextInput({ value, placeholder, disabled, onSave }: { value: string; placeholder?: string; disabled?: boolean; onSave: (v: string) => void }) {
  const [t, setT] = useState(value)
  useEffect(() => setT(value), [value])
  return <input value={t} disabled={disabled} placeholder={placeholder} onChange={(e) => setT(e.target.value)} onBlur={() => t.trim() !== value && onSave(t.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
}

// Cambios en bloque: ciudades elegidas, todo un departamento o todo el país.
function BulkModal({ bulk, baseFee, onClose, onDone }: { bulk: { target: any; label: string }; baseFee: number; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp()
  const [m, setM] = useState({ fee: 'keep', feeValue: baseFee, active: 'keep', free: 'keep', freeFrom: 0, eta: '', note: '' })
  const [busy, setBusy] = useState(false)
  const patch: Record<string, unknown> = {}
  if (m.fee === 'set') patch.price = m.feeValue
  if (m.fee === 'reset') patch.price = null
  if (m.active !== 'keep') patch.active = m.active === 'on'
  if (m.free !== 'keep') { patch.freeMode = m.free; if (m.free === 'amount') patch.freeFrom = m.freeFrom }
  if (m.eta.trim()) patch.eta = m.eta.trim()
  const nothing = Object.keys(patch).length === 0
  const wide = !!bulk.target.all
  return (
    <Modal title={`Cambiar ${bulk.label}`} onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="primary" disabled={busy || nothing} onClick={async () => {
      setBusy(true)
      try { const r = await api('/delivery/bulk', { body: { target: bulk.target, patch, note: m.note || undefined } }); toast(`${r.updated} ciudades actualizadas`); onDone() } catch (e: any) { toast(e.message, true); setBusy(false) } }}>{busy ? 'Aplicando…' : 'Aplicar cambios'}</button></>}>
      {wide && <div className="warnbox">Esto cambia las ciudades de TODO el país.</div>}
      <div className="form">
        <Field label="Tarifa"><select value={m.fee} onChange={(e) => setM({ ...m, fee: e.target.value })}><option value="keep">No cambiar</option><option value="set">Fijar una tarifa</option><option value="reset">Volver a la tarifa general ({gs(baseFee)})</option></select></Field>
        {m.fee === 'set' && <Field label="Nueva tarifa" hint="0 = delivery sin costo"><Money value={m.feeValue} onChange={(n) => setM({ ...m, feeValue: n })} /></Field>}
        <Field label="Delivery"><select value={m.active} onChange={(e) => setM({ ...m, active: e.target.value })}><option value="keep">No cambiar</option><option value="on">Activar</option><option value="off">Desactivar</option></select></Field>
        <Field label="Delivery gratis"><select value={m.free} onChange={(e) => setM({ ...m, free: e.target.value })}><option value="keep">No cambiar</option>{FREE_OPTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {m.free === 'amount' && <Field label="Gratis en compras desde"><Money value={m.freeFrom} onChange={(n) => setM({ ...m, freeFrom: n })} /></Field>}
        <Field label="Plazo estimado" hint="Vacío = no cambiar"><input value={m.eta} onChange={(e) => setM({ ...m, eta: e.target.value })} placeholder="Ej.: 48 horas" /></Field>
        <Field label="Motivo (queda en el historial)" span={2}><input value={m.note} onChange={(e) => setM({ ...m, note: e.target.value })} placeholder="Opcional" /></Field>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------------------------------------ Departamentos
function Departments({ rows, canEdit, baseFee, onOpen, onChanged }: { rows: any[]; canEdit: boolean; baseFee: number; onOpen: (d: string) => void; onChanged: () => void }) {
  const [bulk, setBulk] = useState<any>(null)
  const { toast } = useApp()
  const quick = async (department: string, patch: object, msg: string) => { try { const r = await api('/delivery/bulk', { body: { target: { department }, patch } }); toast(`${depLabel(department)}: ${msg} (${r.updated} ciudades)`); onChanged() } catch (e: any) { toast(e.message, true) } }
  return (
    <div className="card">
      <div className="toolbar"><p className="muted" style={{ margin: 0 }}>17 departamentos y el Distrito Capital. Podés fijar una tarifa o activar/desactivar todas las ciudades de un departamento de una vez.</p><span className="spacer" />
        {canEdit && <button onClick={() => setBulk({ target: { all: true }, label: 'todo el país' })}>Cambiar todo el país</button>}</div>
      <div className="table-wrap"><table>
        <thead><tr><th>Departamento</th><th className="num">Ciudades</th><th className="num">Con delivery</th><th className="num">Tarifa propia</th><th>Tarifas</th><th /></tr></thead>
        <tbody>{rows.map((d) => (
          <tr key={d.department}>
            <td><button className="link" onClick={() => onOpen(d.department)}><b>{depLabel(d.department)}</b></button></td>
            <td className="num">{d.total}</td><td className="num">{d.enabled}{d.enabled < d.total && <small className="muted"> de {d.total}</small>}</td><td className="num">{d.custom}</td>
            <td>{d.minFee === d.maxFee ? gs(d.minFee) : `${gs(d.minFee)} a ${gs(d.maxFee)}`}</td>
            <td className="row">{canEdit ? <>
              <button className="small" onClick={() => setBulk({ target: { department: d.department }, label: depLabel(d.department) })}>Cambiar tarifa…</button>
              {d.custom > 0 && <button className="small" onClick={() => quick(d.department, { price: null }, 'vuelve a la tarifa general')}>Tarifa general</button>}
              {d.enabled < d.total ? <button className="small" onClick={() => quick(d.department, { active: true }, 'delivery activado')}>Activar todo</button> : <button className="small danger" onClick={() => quick(d.department, { active: false }, 'delivery desactivado')}>Desactivar todo</button>}</> : <button className="small" onClick={() => onOpen(d.department)}>Ver ciudades</button>}</td>
          </tr>))}
          {!rows.length && <EmptyRow cols={6} text="Cargando…" />}</tbody></table></div>
      {bulk && <BulkModal bulk={bulk} baseFee={baseFee} onClose={() => setBulk(null)} onDone={() => { setBulk(null); onChanged() }} />}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ Promoción y ajustes
function Settings({ cfg, canEdit, onSaved }: { cfg: any; canEdit: boolean; onSaved: () => void }) {
  const { toast } = useApp()
  const [s, setS] = useState({ baseFee: cfg.baseFee, enabled: cfg.enabled, promo: cfg.freeFrom !== null, freeFrom: cfg.freeFrom ?? 200000, promoStart: cfg.promoStart ?? '', promoEnd: cfg.promoEnd ?? '', defaultEta: cfg.defaultEta ?? '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => { setS({ baseFee: cfg.baseFee, enabled: cfg.enabled, promo: cfg.freeFrom !== null, freeFrom: cfg.freeFrom ?? 200000, promoStart: cfg.promoStart ?? '', promoEnd: cfg.promoEnd ?? '', defaultEta: cfg.defaultEta ?? '' }) }, [cfg.baseFee, cfg.enabled, cfg.freeFrom, cfg.promoStart, cfg.promoEnd, cfg.defaultEta])
  const save = async () => {
    setBusy(true)
    try { await api('/delivery/settings', { method: 'PUT', body: { baseFee: s.baseFee, enabled: s.enabled, freeFrom: s.promo ? s.freeFrom : null, promoStart: s.promo && s.promoStart ? s.promoStart : null, promoEnd: s.promo && s.promoEnd ? s.promoEnd : null, defaultEta: s.defaultEta.trim() || null } }); toast('Ajustes de delivery guardados'); onSaved() } catch (e: any) { toast(e.message, true) }
    setBusy(false)
  }
  return (
    <div className="stack">
      <div className="card">
        <h2>Tarifa general</h2>
        <div className="form"><Field label="Costo de delivery en cualquier ciudad" hint="Valor inicial: Gs. 30.000. Las ciudades con tarifa propia no se ven afectadas."><Money value={s.baseFee} onChange={(n) => setS({ ...s, baseFee: n })} disabled={!canEdit} /></Field>
          <Field label="Plazo estimado general" hint="Se muestra al cliente si la ciudad no tiene un plazo propio"><input value={s.defaultEta} disabled={!canEdit} onChange={(e) => setS({ ...s, defaultEta: e.target.value })} placeholder="Ej.: 24 a 72 horas" /></Field></div>
      </div>
      <div className="card">
        <h2>Delivery gratis por monto de compra</h2>
        <label className="inline"><input type="checkbox" style={{ width: 'auto' }} disabled={!canEdit} checked={s.promo} onChange={(e) => setS({ ...s, promo: e.target.checked })} /> Activar promoción general {cfg.promoIsActive && <span className="pill ok">vigente</span>}{s.promo && !cfg.promoIsActive && cfg.freeFrom !== null && <span className="pill warn">fuera de fecha</span>}</label>
        {s.promo && <div className="form" style={{ marginTop: 10 }}>
          <Field label="Delivery gratis en compras desde"><Money value={s.freeFrom} onChange={(n) => setS({ ...s, freeFrom: n })} disabled={!canEdit} /></Field>
          <Field label="Desde el día (opcional)"><input type="date" value={s.promoStart} disabled={!canEdit} onChange={(e) => setS({ ...s, promoStart: e.target.value })} /></Field>
          <Field label="Hasta el día (opcional)"><input type="date" value={s.promoEnd} min={s.promoStart || today()} disabled={!canEdit} onChange={(e) => setS({ ...s, promoEnd: e.target.value })} /></Field></div>}
        <p className="muted">Se aplica a todas las ciudades salvo las que tengan una regla propia («nunca gratis», «desde un monto» o «siempre gratis»). El cliente ve cuánto le falta para llegar al delivery gratis.</p>
      </div>
      <div className="card">
        <h2>Delivery en todo el país</h2>
        <label className="inline"><input type="checkbox" style={{ width: 'auto' }} disabled={!canEdit} checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Se hace delivery</label>
        {!s.enabled && <div className="warnbox" style={{ marginTop: 10 }}>Con esto apagado ninguna ciudad tiene delivery: los clientes solo pueden retirar en el local.</div>}
      </div>
      {canEdit && <div className="row"><button className="primary" disabled={busy} onClick={save}>{busy ? 'Guardando…' : 'Guardar ajustes'}</button><span className="muted">Los pedidos ya realizados conservan el costo de entrega con el que se compraron.</span></div>}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ Historial
function History({ departments }: { departments: string[] }) {
  const [f, setF] = useState({ department: '', city: '', page: 1 })
  const city = useDebounced(f.city)
  const data = useQuery<any>('/delivery/history?' + qs({ department: f.department, city, page: f.page }))
  const items: any[] = data.data?.items ?? []
  return (
    <div className="card">
      <div className="toolbar"><Field label="Departamento"><select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value, page: 1 })}><option value="">Todos</option>{departments.map((d) => <option key={d} value={d}>{depLabel(d)}</option>)}</select></Field>
        <Field label="Ciudad"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value, page: 1 })} placeholder="Buscar ciudad" /></Field></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Usuario</th><th>Dónde</th><th>Qué cambió</th><th>Antes</th><th>Después</th><th>Motivo</th></tr></thead>
        <tbody>{items.map((h) => <tr key={h.id}><td>{fmtDateTime(h.at)}</td><td>{h.user_name ?? '—'}</td><td>{h.city_name ? `${h.city_name} · ${depLabel(h.department ?? '')}` : h.scope === 'general' || h.scope === 'promo' ? 'General' : depLabel(h.department ?? '—')}</td><td><b>{h.field}</b></td><td>{h.old_value ?? '—'}</td><td>{h.new_value ?? '—'}</td><td>{h.note ?? ''}</td></tr>)}
          {!items.length && <EmptyRow cols={7} text={data.loading ? 'Cargando…' : 'Todavía no hay cambios registrados'} />}</tbody></table></div>
      <Pager page={data.data?.page ?? 1} pages={data.data?.pages ?? 1} total={data.data?.total ?? 0} pageSize={50} onPage={(p) => setF({ ...f, page: p })} />
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ Cobros por ciudad
function Charges() {
  const first = today().slice(0, 8) + '01'
  const [r, setR] = useState({ from: first, to: today() })
  const data = useQuery<any>('/delivery/report?' + qs(r))
  const items: any[] = data.data?.items ?? []
  const t = data.data?.totals
  const csv = () => {
    const lines = [['Departamento', 'Ciudad', 'Pedidos', 'Cobrado', 'Tarifa sin promoción', 'Pedidos con delivery gratis', 'No cobrado por promoción'], ...items.map((i) => [i.department, i.city, i.orders, i.charged, i.baseTotal, i.freeOrders, i.forgone])]
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' }))
    a.download = `delivery_${r.from}_${r.to}.csv`; a.click()
  }
  return (
    <div className="card">
      <div className="toolbar"><Field label="Desde"><input type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /></Field><Field label="Hasta"><input type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /></Field><span className="spacer" /><button disabled={!items.length} onClick={csv}>Exportar CSV</button></div>
      {t && <div className="kpis" style={{ marginBottom: 14 }}><Kpi label="Pedidos con delivery" value={t.orders} /><Kpi label="Delivery cobrado" value={gs(t.charged)} /><Kpi label="Delivery gratis" value={t.freeOrders} sub="pedidos sin costo de envío" /><Kpi label="No cobrado por promoción" value={gs(t.forgone)} /></div>}
      <div className="table-wrap"><table>
        <thead><tr><th>Ciudad</th><th>Departamento</th><th className="num">Pedidos</th><th className="num">Cobrado</th><th className="num">Gratis</th><th className="num">No cobrado</th></tr></thead>
        <tbody>{items.map((i, n) => <tr key={n}><td><b>{i.city}</b></td><td>{depLabel(i.department)}</td><td className="num">{i.orders}</td><td className="num">{gs(i.charged)}</td><td className="num">{i.freeOrders}</td><td className="num">{gs(i.forgone)}</td></tr>)}
          {!items.length && <EmptyRow cols={6} text={data.loading ? 'Cargando…' : 'No hubo pedidos con delivery en ese período'} />}</tbody></table></div>
    </div>
  )
}
