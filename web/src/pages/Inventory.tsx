import { useState } from 'react'
import { api, gs, useApp } from '../api'
import { PhoneLink } from '../components/PhoneLink'
import { ProductPicker } from '../components/ProductPicker'
import { Scanner, useKeyboardScanner } from '../components/Scanner'
import { EmptyRow, Field, fmtDateTime, Kpi, Modal, Status, useAsk, useQuery } from '../ui'

// Conteo físico: se cuenta con lector (cámara, USB o celular), se revisan las diferencias y recién entonces se ajusta el stock.
function Count({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const { toast } = useApp()
  const ask = useAsk()
  const d = useQuery<any>(`/inventory-counts/${id}`)
  const [cam, setCam] = useState(false)
  const [phone, setPhone] = useState(false)
  const [last, setLast] = useState<any>(null)
  const c = d.data
  const open = c?.status === 'open'
  async function scan(code: string, extra: any = {}) {
    try { const r = await api(`/inventory-counts/${id}/scan`, { body: { code, ...extra } }); setLast(r); d.reload() } catch (e: any) { toast(e.message, true) }
  }
  useKeyboardScanner((code) => open && scan(code), !!open)
  if (!c) return <Modal title="Conteo" onClose={onClose}><p className="muted">Cargando…</p></Modal>
  return (
    <Modal title={`Conteo ${c.number}`} onClose={onClose} wide="xl" footer={<>
      {open && <button className="danger" onClick={async () => { if (await ask({ title: 'Cancelar el conteo', confirm: 'Cancelar conteo', danger: true })) { await api(`/inventory-counts/${id}/cancel`, { body: {} }); toast('Conteo cancelado'); d.reload(); onChange() } }}>Cancelar conteo</button>}
      {open && <button className="primary" disabled={!c.items.length} onClick={async () => { if (!(await ask({ title: 'Aplicar el conteo al stock', label: 'Se ajustará el stock de los productos con diferencia', confirm: 'Aplicar ajustes' }))) return; try { const r = await api(`/inventory-counts/${id}/apply`, { body: {} }); toast(`Ajustados ${r.applied} productos (faltante ${gs(r.loss)}, sobrante ${gs(r.gain)})`); d.reload(); onChange() } catch (e: any) { toast(e.message, true) } }}>Aplicar ajustes</button>}
      <button onClick={onClose}>Cerrar</button></>}>
      <div className="grid cols-4"><Kpi label="Estado" value={<Status value={c.status === 'open' ? 'open' : c.status === 'applied' ? 'posted' : 'void'} label={c.status === 'open' ? 'Abierto' : c.status === 'applied' ? 'Aplicado' : 'Cancelado'} />} /><Kpi label="Productos contados" value={c.summary.products} /><Kpi label="Unidades" value={c.summary.units} /><Kpi label="Con diferencia" value={c.summary.differences} tone={c.summary.differences ? 'warn' : 'ok'} /></div>
      {open && <div className="stack">
        <div className="row"><button onClick={() => setCam(true)}>📷 Escanear con la cámara</button><button onClick={() => setPhone(true)}>📱 Usar el celular</button><span className="muted">También funciona un lector USB: cada lectura suma 1.</span></div>
        <ProductPicker onPick={(p) => scan(p.barcode || p.code)} placeholder="Buscar un producto para contarlo a mano…" />
        {last && <div className="okbox">Último: <b>{last.name}</b> — contados {last.counted} · en sistema {last.expected} · diferencia {last.diff > 0 ? '+' : ''}{last.diff}</div>}
      </div>}
      <div className="table-wrap"><table><thead><tr><th>Producto</th><th className="num">En sistema</th><th className="num">Contado</th><th className="num">Diferencia</th><th>Hora</th>{open && <th />}</tr></thead>
        <tbody>{c.items.map((i: any) => <tr key={i.id}><td><b>{i.name}</b><div className="muted">{i.code}{i.barcode ? ' · ' + i.barcode : ''}</div></td><td className="num">{i.expected}</td>
          <td className="num">{open ? <input type="number" min={0} style={{ width: 80 }} defaultValue={i.counted} onBlur={(e) => Number(e.target.value) !== i.counted && scan(i.barcode || i.code, { qty: Math.max(1, Number(e.target.value)), set: true })} /> : i.counted}</td>
          <td className="num"><span className={'pill ' + (i.diff === 0 ? 'ok' : i.diff < 0 ? 'bad' : 'warn')}>{i.diff > 0 ? '+' : ''}{i.diff}</span></td><td>{fmtDateTime(i.counted_at)}</td>{open && <td />}</tr>)}{!c.items.length && <EmptyRow cols={6} text="Todavía no contaste nada" />}</tbody></table></div>
      {cam && <Modal title="Contar con la cámara" onClose={() => setCam(false)} footer={<button className="primary" onClick={() => setCam(false)}>Listo</button>}><Scanner continuous onScan={(r) => scan(r.code)} hint="Cada lectura suma 1 unidad contada" /></Modal>}
      {phone && <PhoneLink purpose="inventory" onCode={(code) => scan(code)} onClose={() => setPhone(false)} />}
    </Modal>
  )
}

export default function Inventory() {
  const { toast } = useApp()
  const list = useQuery<any[]>('/inventory-counts')
  const [open, setOpen] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)
  return (
    <>
      <div className="head"><div><h1>Conteo de inventario</h1><span className="muted">Controlá el stock físico con el lector y ajustá solo lo que difiere</span></div><button className="primary" onClick={() => setNote('')}>Nuevo conteo</button></div>
      <div className="card"><table><thead><tr><th>Conteo</th><th>Fecha</th><th>Responsable</th><th>Nota</th><th className="num">Productos</th><th className="num">Diferencias</th><th>Estado</th></tr></thead>
        <tbody>{(list.data ?? []).map((c) => <tr key={c.id} className="clickable" onClick={() => setOpen(c.id)}><td><b>{c.number}</b></td><td>{fmtDateTime(c.created_at)}</td><td>{c.user_name}</td><td>{c.note}</td><td className="num">{c.items}</td><td className="num">{c.differences}</td><td><Status value={c.status === 'open' ? 'open' : c.status === 'applied' ? 'posted' : 'void'} label={c.status === 'open' ? 'Abierto' : c.status === 'applied' ? 'Aplicado' : 'Cancelado'} /></td></tr>)}{!list.data?.length && <EmptyRow cols={7} text="Todavía no hiciste conteos" />}</tbody></table></div>
      {note !== null && <Modal title="Nuevo conteo" onClose={() => setNote(null)} footer={<><button onClick={() => setNote(null)}>Cancelar</button><button className="primary" onClick={async () => { try { const c = await api('/inventory-counts', { body: { note: note || null } }); setNote(null); list.reload(); setOpen(c.id) } catch (e: any) { toast(e.message, true) } }}>Empezar</button></>}>
        <Field label="Qué vas a contar"><input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Estante 1, librería completa…" /></Field></Modal>}
      {open && <Count id={open} onClose={() => setOpen(null)} onChange={list.reload} />}
    </>
  )
}
