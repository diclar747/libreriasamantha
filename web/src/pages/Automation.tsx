import { useEffect, useState } from 'react'
import { api, gs, useApp } from '../api'

type Tab = 'repl' | 'outbox' | 'invoices'

export default function Automation() {
  const { toast } = useApp()
  const [tab, setTab] = useState<Tab>('repl')
  const [rows, setRows] = useState<any[] | null>(null)
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [pick, setPick] = useState<Record<number, string>>({})

  const load = () => {
    setRows(null)
    api({ repl: '/replenishments', outbox: '/outbox', invoices: '/invoices' }[tab]).then(setRows).catch((e) => { setRows([]); toast(e.message, true) })
  }
  useEffect(() => { load() }, [tab])
  useEffect(() => { api('/suppliers').then(setSuppliers).catch(() => {}) }, [])

  async function approve(r: any) {
    try { await api(`/replenishments/${r.id}/approve`, { body: { supplierId: Number(pick[r.id] || r.supplier_id) || undefined } }); toast('Orden de compra creada y proveedor notificado'); load() } catch (e: any) { toast(e.message, true) }
  }
  async function act(url: string, ok: string) { try { const r = await api(url, { body: {} }); toast(ok + (r?.sent !== undefined ? ` (${r.sent} enviados)` : '')); load() } catch (e: any) { toast(e.message, true) } }

  return (
    <>
      <div className="head"><div><h1>Automatización</h1><span className="muted">Reposición con aprobación, mensajes por WhatsApp (Winsap) y facturas electrónicas.</span></div></div>
      <div className="row" style={{ marginBottom: 14 }}>
        {([['repl', 'Reposición'], ['outbox', 'Mensajes'], ['invoices', 'Facturas']] as [Tab, string][]).map(([k, l]) => <button key={k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{l}</button>)}
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
      {rows && tab === 'invoices' && (
        <div className="card">
          <p className="muted">Modo simulado: la emisión real con SIFEN requiere timbrado, certificado y habilitación en la DNIT.</p>
          <table><thead><tr><th>Tipo</th><th>Número</th><th>Cliente</th><th className="num">Total</th><th className="num">IVA 10%</th><th>Estado</th><th /></tr></thead><tbody>
            {rows.map((i) => (
              <tr key={i.id}><td>{i.kind === 'invoice' ? 'Factura' : 'Nota de crédito'}</td><td><b>{i.number}</b></td><td>{i.customer_name}<div className="muted">{i.customer_ruc}</div></td>
                <td className="num">{gs(i.total)}</td><td className="num">{gs(Math.round(i.tax10 / 11))}</td>
                <td><span className={'pill ' + (i.status === 'approved' ? 'ok' : i.status === 'rejected' ? 'bad' : 'warn')}>{i.status}</span>{i.error && <div className="muted">{i.error}</div>}</td>
                <td className="num">{i.status !== 'approved' && <button onClick={() => act(`/invoices/${i.id}/retry`, 'Reintento hecho')}>Reintentar</button>}</td></tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted">Sin comprobantes</td></tr>}
          </tbody></table>
        </div>
      )}
    </>
  )
}
