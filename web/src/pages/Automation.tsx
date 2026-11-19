import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, useApp } from '../api'

type Tab = 'repl' | 'outbox'

export default function Automation() {
  const { toast } = useApp()
  const [tab, setTab] = useState<Tab>('repl')
  const [rows, setRows] = useState<any[] | null>(null)
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [pick, setPick] = useState<Record<number, string>>({})

  const load = () => {
    setRows(null)
    api({ repl: '/replenishments', outbox: '/outbox' }[tab]).then(setRows).catch((e) => { setRows([]); toast(e.message, true) })
  }
  useEffect(() => { load() }, [tab])
  useEffect(() => { api('/suppliers').then(setSuppliers).catch(() => {}) }, [])

  async function approve(r: any) {
    try { await api(`/replenishments/${r.id}/approve`, { body: { supplierId: Number(pick[r.id] || r.supplier_id) || undefined } }); toast('Orden de compra creada y proveedor notificado'); load() } catch (e: any) { toast(e.message, true) }
  }
  async function act(url: string, ok: string) { try { const r = await api(url, { body: {} }); toast(ok + (r?.sent !== undefined ? ` (${r.sent} enviados)` : '')); load() } catch (e: any) { toast(e.message, true) } }

  return (
    <>
      <div className="head"><div><h1>Automatización</h1><span className="muted">Reposición con aprobación y mensajes por WhatsApp (Winsap). Las facturas electrónicas están en <Link to="/facturacion">Facturación electrónica</Link>.</span></div></div>
      <div className="row" style={{ marginBottom: 14 }}>
        {([['repl', 'Reposición'], ['outbox', 'Mensajes']] as [Tab, string][]).map(([k, l]) => <button key={k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {!rows && <p className="muted">Cargando…</p>}
      {rows && tab === 'repl' && (
        <div className="card">
          <p className="muted">El sistema sugiere; la compra solo se genera al aprobarla. No se repite el aviso mientras haya una reposición en trámite.</p>
          <table><thead><tr><th>Producto</th><th className="num">Disponible</th><th className="num">Mínimo</th><th className="num">Sugerido</th><th>Proveedor</th><th>Estado</th><th /></tr></thead><tbody>
            {rows.map((r) => (
              <tr key={r.id}><td><b>{r.name}</b></td><td className="num">{r.stock - r.reserved}</td><td className="num">{r.min_stock}</td><td className="num">{r.suggested_qty}</td>
                <td>{r.status === 'open' ? <select value={pick[r.id] ?? r.supplier_id ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}><option value="">Elegir…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select> : r.supplier_name}</td>
                <td><span className={'pill ' + (r.status === 'open' ? 'warn' : 'ok')}>{r.status === 'open' ? 'Pendiente de aprobar' : 'Solicitada'}</span></td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>{r.status === 'open' && <><button className="primary" onClick={() => approve(r)}>Aprobar y pedir</button><button onClick={() => act(`/replenishments/${r.id}/dismiss`, 'Descartada')}>Descartar</button></>}</td></tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted">Sin reposiciones pendientes</td></tr>}
          </tbody></table>
        </div>
      )}
      {rows && tab === 'outbox' && (
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}><button onClick={() => act('/outbox/flush', 'Cola procesada')}>Enviar pendientes</button><span className="muted">Modo simulado hasta conectar la API de Winsap. Los fallos se reintentan hasta 5 veces.</span></div>
          <table><thead><tr><th>Fecha</th><th>Para</th><th>Mensaje</th><th>Estado</th></tr></thead><tbody>
            {rows.map((m) => (
              <tr key={m.id}><td>{new Date(m.created_at).toLocaleString('es-PY')}</td><td>{m.audience}<div className="muted">{m.to_phone}</div></td><td>{m.body}</td>
                <td><span className={'pill ' + (m.status === 'sent' ? 'ok' : m.status === 'failed' ? 'bad' : 'warn')}>{m.status}</span>{m.last_error && <div className="muted">{m.last_error}</div>}</td></tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="muted">Sin mensajes</td></tr>}
          </tbody></table>
        </div>
      )}
    </>
  )
}
