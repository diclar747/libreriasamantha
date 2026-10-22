import { useEffect, useState } from 'react'
import { NumInput } from '../ui'
import { api, gs, useApp } from '../api'

const LABEL: Record<string, [string, string]> = {
  quote: ['Presupuesto', ''], approved: ['Aprobada', 'warn'], in_progress: ['En proceso', 'warn'], ready: ['Lista', 'ok'], delivered: ['Entregada', 'ok'], cancelled: ['Cancelada', 'bad'],
}
const NEXT: Record<string, [string, string][]> = {
  quote: [['approved', 'Aprobar']], approved: [['in_progress', 'Iniciar']], in_progress: [['ready', 'Marcar lista']], ready: [], delivered: [], cancelled: [],
}
const EMPTY = { customerName: '', phone: '', description: '', copies: 1, pages: 1, color: false, paper: 'A4', finishing: '', fileName: '' }

export default function WorkOrders() {
  const { toast } = useApp()
  const [rows, setRows] = useState<any[]>([])
  const [form, setForm] = useState<any>(null)
  const [est, setEst] = useState<number | null>(null)
  const [dep, setDep] = useState<any>(null)

  const load = () => api('/workorders').then(setRows).catch((e) => toast(e.message, true))
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!form) return
    const t = setTimeout(() => api('/workorders/estimate', { body: { copies: form.copies, pages: form.pages, color: form.color, finishing: form.finishing || null } }).then((r) => setEst(r.price)).catch(() => {}), 200)
    return () => clearTimeout(t)
  }, [form?.copies, form?.pages, form?.color, form?.finishing])

  async function save() {
    try {
      await api('/workorders', { body: { ...form, finishing: form.finishing || null, fileName: form.fileName || null, price: form.price ? Number(form.price) : undefined } })
      toast('Orden creada'); setForm(null); load()
    } catch (e: any) { toast(e.message, true) }
  }
  async function move(id: number, status: string) {
    try { await api(`/workorders/${id}/status`, { body: { status } }); load() } catch (e: any) { toast(e.message, true) }
  }
  async function deposit() {
    try { await api(`/workorders/${dep.id}/deposit`, { body: { amount: Number(dep.amount), method: dep.method } }); toast('Anticipo cobrado'); setDep(null); load() } catch (e: any) { toast(e.message, true) }
  }
  const set = (k: string, num = false) => (e: any) => setForm({ ...form, [k]: num ? Number(e.target.value) : e.target.value })

  return (
    <>
      <div className="head"><div><h1>Servicios de impresión</h1><span className="muted">Se cobra al entregar desde el POS (el anticipo se descuenta solo).</span></div>
        <button className="primary" onClick={() => setForm({ ...EMPTY })}>Nueva orden</button></div>
      {form && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Nueva orden de trabajo</h2>
          <div className="form">
            <label>Cliente<input value={form.customerName} onChange={set('customerName')} /></label>
            <label>Teléfono<input value={form.phone} onChange={set('phone')} /></label>
            <label>Descripción<input value={form.description} onChange={set('description')} /></label>
            <label>Copias<NumInput min={1} value={form.copies} onChange={set('copies', true)} /></label>
            <label>Páginas por copia<NumInput min={1} value={form.pages} onChange={set('pages', true)} /></label>
            <label>Papel<select value={form.paper} onChange={set('paper')}><option>A4</option><option>Oficio</option><option>A3</option></select></label>
            <label>Terminación<select value={form.finishing} onChange={set('finishing')}><option value="">Ninguna</option><option value="anillado">Anillado</option><option value="plastificado">Plastificado</option><option value="cortado">Cortado</option></select></label>
            <label>Archivo<input value={form.fileName} onChange={set('fileName')} placeholder="nombre del archivo recibido" /></label>
            <label className="row" style={{ flexDirection: 'row', alignSelf: 'end' }}><input type="checkbox" style={{ width: 'auto' }} checked={form.color} onChange={(e) => setForm({ ...form, color: e.target.checked })} /> A color</label>
            <label>Precio (vacío = tarifa)<NumInput value={form.price ?? ''} onChange={set('price')} placeholder={est !== null ? String(est) : ''} /></label>
          </div>
          <p>Presupuesto estimado: <b>{est !== null ? gs(est) : '—'}</b></p>
          <div className="row"><button className="primary" onClick={save}>Crear</button><button onClick={() => setForm(null)}>Cancelar</button></div>
        </div>
      )}
      {dep && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Anticipo de {dep.number}</h2>
          <div className="row"><input style={{ width: 180 }} type="number" placeholder="Monto" value={dep.amount} onChange={(e) => setDep({ ...dep, amount: e.target.value })} />
            <select style={{ width: 180 }} value={dep.method} onChange={(e) => setDep({ ...dep, method: e.target.value })}><option value="cash">Efectivo</option><option value="transfer">Transferencia</option><option value="card">Tarjeta</option></select>
            <button className="primary" onClick={deposit}>Cobrar anticipo</button><button onClick={() => setDep(null)}>Cancelar</button></div>
        </div>
      )}
      <div className="card">
        <table><thead><tr><th>N°</th><th>Cliente</th><th>Trabajo</th><th className="num">Precio</th><th className="num">Anticipo</th><th>Origen</th><th>Estado</th><th /></tr></thead><tbody>
          {rows.map((w) => (
            <tr key={w.id}><td><b>{w.number}</b></td><td>{w.customer_name}<div className="muted">{w.phone}</div></td>
              <td>{w.description}<div className="muted">{w.copies} x {w.pages} pág. · {w.color ? 'color' : 'B/N'} · {w.paper}{w.finishing ? ' · ' + w.finishing : ''}</div></td>
              <td className="num">{gs(w.price)}</td><td className="num">{gs(w.deposit)}</td><td>{w.source}</td>
              <td><span className={'pill ' + LABEL[w.status][1]}>{LABEL[w.status][0]}</span></td>
              <td className="row" style={{ justifyContent: 'flex-end' }}>
                {NEXT[w.status].map(([s, l]) => <button key={s} onClick={() => move(w.id, s)}>{l}</button>)}
                {['approved', 'in_progress', 'ready'].includes(w.status) && <button onClick={() => setDep({ ...w, amount: '', method: 'cash' })}>Anticipo</button>}
                {['quote', 'approved', 'in_progress'].includes(w.status) && <button className="danger" onClick={() => move(w.id, 'cancelled')}>Cancelar</button>}
              </td></tr>
          ))}
          {!rows.length && <tr><td colSpan={8} className="muted">Sin órdenes</td></tr>}
        </tbody></table>
      </div>
    </>
  )
}
