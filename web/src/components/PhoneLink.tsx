import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { api, useApp } from '../api'
import { Modal } from '../ui'

// Vincula el celular como lector: muestra un QR temporal y entrega cada código leído a onCode.
export function PhoneLink({ purpose, onCode, onClose }: { purpose: 'sale' | 'reception' | 'inventory'; onCode: (code: string) => void | Promise<void>; onClose: () => void }) {
  const { toast } = useApp()
  const [link, setLink] = useState<{ id: number; qr: string; url: string } | null>(null)
  const [status, setStatus] = useState('pending')
  useEffect(() => {
    let id = 0
    api('/scan/links', { body: { purpose } }).then(async (l) => {
      id = l.id
      const url = location.origin + l.path
      setLink({ id: l.id, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 240 }) })
    }).catch((e) => { toast(e.message, true); onClose() })
    return () => { if (id) api('/scan/links/' + id, { method: 'DELETE' }).catch(() => {}) }
  }, [])
  useEffect(() => {
    if (!link) return
    const t = setInterval(async () => {
      try {
        const st = await api('/scan/links/' + link.id)
        setStatus(st.status)
        if (st.status === 'expired' || st.status === 'closed') { toast('El enlace del celular venció', true); onClose(); return }
        for (const ev of await api(`/scan/links/${link.id}/events`)) await onCode(ev.code)
      } catch { /* reintenta */ }
    }, 1500)
    return () => clearInterval(t)
  }, [link?.id])
  return (
    <Modal title="Celular como lector" onClose={onClose} footer={<button onClick={onClose}>Desvincular</button>}>
      {link && <div style={{ textAlign: 'center' }}><img src={link.qr} alt="QR para vincular el celular" width={240} height={240} />
        <p><span className={'pill ' + (status === 'linked' ? 'ok' : 'warn')}>{status === 'linked' ? 'Celular vinculado' : 'Esperando al celular'}</span></p>
        <p className="muted">Escaneá este QR con la cámara del celular. Todo lo que lea llega acá. Vence a los 15 minutos.</p><small className="muted" style={{ wordBreak: 'break-all' }}>{link.url}</small></div>}
    </Modal>
  )
}
