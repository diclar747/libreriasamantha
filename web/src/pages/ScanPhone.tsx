import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Scanner } from '../components/Scanner'

// Página pública del celular vinculado: solo lee códigos y los manda a la sesión del que generó el QR.
const QUEUE_KEY = 'samantha.scan.queue'
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now())

export default function ScanPhone() {
  const { token } = useParams()
  const [info, setInfo] = useState<{ purpose: string; linkedTo: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [log, setLog] = useState<{ code: string; name: string | null; ok: boolean; at: number }[]>([])
  const [manual, setManual] = useState('')
  const [pending, setPending] = useState(0)
  const [flash, setFlash] = useState(0)
  const sending = useRef(false)

  const queue = (): { code: string; eventId: string; format?: string }[] => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY + token) ?? '[]') } catch { return [] } }
  const saveQueue = (q: any[]) => { try { localStorage.setItem(QUEUE_KEY + token, JSON.stringify(q)) } catch { /* sin almacenamiento */ } setPending(q.length) }

  useEffect(() => {
    fetch(`/api/shop/scan/${token}`).then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'No se pudo vincular'); setInfo(await r.json()) }).catch((e) => setErr(e.message))
    setPending(queue().length)
  }, [token])

  // Envío con reintentos: sin señal, las lecturas quedan guardadas y salen solas al volver la conexión.
  async function flushQueue() {
    if (sending.current) return
    sending.current = true
    try {
      let q = queue()
      while (q.length) {
        const ev = q[0]
        const r = await fetch(`/api/shop/scan/${token}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev) })
        if (r.status === 410) { setErr('El enlace venció. Pedí un QR nuevo en la caja.'); break }
        if (!r.ok && r.status >= 500) break
        const j = await r.json().catch(() => ({}))
        setLog((l) => [{ code: ev.code, name: j.product ?? null, ok: r.ok, at: Date.now() }, ...l].slice(0, 20))
        q = q.slice(1); saveQueue(q)
      }
    } catch { /* sin conexión */ } finally { sending.current = false }
  }
  useEffect(() => { const t = setInterval(flushQueue, 3000); window.addEventListener('online', flushQueue); return () => { clearInterval(t); window.removeEventListener('online', flushQueue) } }, [token])

  function submit(code: string, format?: string) {
    const c = code.trim(); if (!c) return
    saveQueue([...queue(), { code: c, format, eventId: uid() }]); setFlash((n) => n + 1); flushQueue()
  }

  if (err) return <div className="login"><div className="card"><h2>Lector del celular</h2><div className="errbox">{err}</div></div></div>
  if (!info) return <div className="login"><div className="card"><p className="muted">Vinculando…</p></div></div>
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: 16, display: 'grid', gap: 14 }}>
      <div><h1 style={{ margin: 0 }}>Lector de códigos</h1><span className="muted">Vinculado a la caja de {info.linkedTo}. Cada código leído se suma a su pantalla.</span></div>
      <div key={flash} className="scan-flash" style={{ borderRadius: 16 }}><Scanner continuous cooldownMs={1800} onScan={(r) => submit(r.code, r.format)} hint="Apuntá al código y esperá el aviso" /></div>
      {pending > 0 && <div className="warnbox">{pending} lecturas esperando conexión: se envían solas.</div>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); submit(manual); setManual('') }}><input style={{ flex: 1 }} inputMode="numeric" placeholder="O escribí el código a mano" value={manual} onChange={(e) => setManual(e.target.value)} /><button className="primary" disabled={!manual.trim()}>Enviar</button></form>
      <div className="card"><h3 style={{ marginTop: 0 }}>Últimas lecturas</h3>
        {log.map((l, i) => <div key={i} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}><span><b>{l.name ?? 'Código desconocido'}</b><br /><small className="muted">{l.code}</small></span><span className={'pill ' + (l.name ? 'ok' : 'warn')}>{l.name ? 'Enviado' : 'No existe'}</span></div>)}
        {!log.length && <p className="muted">Todavía no leíste nada.</p>}</div>
    </div>
  )
}
