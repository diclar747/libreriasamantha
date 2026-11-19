import { useState } from 'react'
import { api, useApp } from '../api'

// Elige el cliente (receptor) de una factura: busca el RUC/CI en la base y, si no está, en SET; si no existe, se carga a mano.
// onPick(null) = Consumidor final.
export default function ReceptorPicker({ onPick, busy }: { onPick: (c: { id: number; name: string; ruc?: string | null } | null) => void; busy?: boolean }) {
  const { toast } = useApp()
  const [doc, setDoc] = useState('')
  const [res, setRes] = useState<any>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)

  async function lookup() {
    if (!doc.trim()) return
    setLoading(true); setRes(null)
    try {
      const r = await api('/customers/lookup?doc=' + encodeURIComponent(doc.trim()))
      setRes(r)
      setName(r.source === 'set' ? r.taxpayer.razonSocial : r.source === 'local' ? r.customer.name : '')
      setEmail(r.source === 'local' ? r.customer.email ?? '' : '')
    } catch (e: any) { toast(e.message, true) } finally { setLoading(false) }
  }
  async function confirm() {
    try {
      if (res.source === 'local') { onPick(res.customer); return }
      if (name.trim().length < 2) { toast('Escribí el nombre o razón social', true); return }
      const digits = doc.replace(/\D/g, '')
      const body = res.source === 'set'
        ? { name: name.trim(), ruc: res.taxpayer.ruc, document: res.taxpayer.ruc, doc_type: 'ruc', taxpayer: true, persona: name.includes(',') ? 'FISICA' : 'JURIDICA', email: email.trim() || null }
        : { name: name.trim(), ruc: digits, document: digits, doc_type: 'ci', taxpayer: false, persona: 'FISICA', email: email.trim() || null }
      const c = await api('/customers', { body })
      onPick(c)
    } catch (e: any) { toast(e.message, true) }
  }

  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <label style={{ flex: 1 }}>RUC o cédula del cliente
          <input value={doc} onChange={(e) => { setDoc(e.target.value); setRes(null) }} onKeyDown={(e) => e.key === 'Enter' && lookup()} placeholder="Ej.: 3626142 o 80012345-6" inputMode="numeric" autoFocus />
        </label>
        <button onClick={lookup} disabled={loading || !doc.trim()}>{loading ? 'Buscando…' : 'Buscar'}</button>
      </div>
      {res && <div className="card" style={{ padding: 12 }}>
        {res.source === 'local' && <p style={{ margin: 0 }}>Cliente guardado: <b>{res.customer.name}</b> <span className="muted">· {res.customer.ruc || res.customer.document}</span></p>}
        {res.source === 'set' && <p style={{ margin: '0 0 8px' }}>Encontrado en SET: <b>{res.taxpayer.razonSocial}</b> <span className="muted">· RUC {res.taxpayer.ruc} · {res.taxpayer.estado}</span></p>}
        {res.source === 'none' && <p className="muted" style={{ margin: '0 0 8px' }}>No figura en SET (cédula de un no contribuyente). Escribí el nombre para facturarle.</p>}
        {res.source !== 'local' && <div className="form">
          <label>Nombre o razón social<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Correo (opcional, para enviarle la factura)<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        </div>}
      </div>}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button onClick={() => onPick(null)} disabled={busy}>Facturar a Consumidor final</button>
        <button className="primary" onClick={confirm} disabled={busy || !res}>{busy ? 'Emitiendo…' : 'Facturar a este cliente'}</button>
      </div>
    </div>
  )
}
