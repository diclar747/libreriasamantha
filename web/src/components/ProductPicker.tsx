import { useEffect, useRef, useState } from 'react'
import { api, gs } from '../api'
import { Modal, useDebounced } from '../ui'
import { Scanner, useKeyboardScanner } from './Scanner'

// Buscador de productos con lupa, lector de cámara y lector USB. Al escanear un código exacto, lo agrega directo.
export function ProductPicker({ onPick, placeholder = 'Buscar producto o escanear código…', autoFocus, showCost, onUnknown }: { onPick: (p: any) => void; placeholder?: string; autoFocus?: boolean; showCost?: boolean; onUnknown?: (code: string) => void }) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<any[]>([])
  const [cam, setCam] = useState(false)
  const [open, setOpen] = useState(false)
  const dq = useDebounced(q, 250)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (dq.trim().length < 2) { setRows([]); return }
    api('/products?q=' + encodeURIComponent(dq.trim())).then((r) => setRows(r.slice(0, 8))).catch(() => setRows([]))
  }, [dq])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])
  const byCode = async (code: string) => {
    try { const p = await api('/products/lookup?code=' + encodeURIComponent(code)); onPick(p); setQ(''); setRows([]) } catch { onUnknown ? onUnknown(code) : setQ(code) }
  }
  useKeyboardScanner(byCode)
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input value={q} autoFocus={autoFocus} placeholder={placeholder} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) { e.preventDefault(); if (rows.length === 1) { onPick(rows[0]); setQ(''); setRows([]) } else byCode(q.trim()) } }} />
        <button type="button" onClick={() => setCam(true)} title="Escanear con la cámara" aria-label="Escanear">📷</button>
      </div>
      {open && rows.length > 0 && (
        <div className="popover" style={{ position: 'absolute', zIndex: 30, left: 0, right: 0, top: '100%', marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 12px 30px rgb(0 0 0 / 14%)', maxHeight: 320, overflowY: 'auto' }}>
          {rows.map((p) => (
            <button type="button" key={p.id} onClick={() => { onPick(p); setQ(''); setRows([]); setOpen(false) }} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', border: 0, borderRadius: 0, textAlign: 'left', gap: 12 }}>
              <span><b>{p.name}</b><br /><small className="muted">{p.code}{p.barcode ? ' · ' + p.barcode : ''} · disp. {p.available ?? '—'}</small></span>
              <span style={{ textAlign: 'right' }}>{gs(p.sell_price ?? p.price)}{showCost && p.cost != null && <><br /><small className="muted">costo {gs(p.cost)}</small></>}</span>
            </button>
          ))}
        </div>
      )}
      {cam && <Modal title="Escanear producto" onClose={() => setCam(false)}><Scanner continuous={false} onScan={(r) => { setCam(false); byCode(r.code) }} onClose={() => setCam(false)} /></Modal>}
    </div>
  )
}
