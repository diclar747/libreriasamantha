import { useEffect, useRef, useState } from 'react'

// Lector con la cámara del dispositivo. Usa BarcodeDetector cuando existe (Chrome/Android) y ZXing como respaldo (iOS/Safari, Firefox).
// Formatos: EAN-13, EAN-8, UPC-A/E, Code 128, Code 39, ITF, QR y DataMatrix.
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix']

export interface ScanResult { code: string; format: string }

export function Scanner({ onScan, continuous = false, onClose, cooldownMs = 1500, hint }: { onScan: (r: ScanResult) => void; continuous?: boolean; onClose?: () => void; cooldownMs?: number; hint?: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>('')
  const [torch, setTorch] = useState(false)
  const [canTorch, setCanTorch] = useState(false)
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const cb = useRef(onScan)
  cb.current = onScan

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let raf = 0
    let zxingControls: { stop: () => void } | null = null
    const emit = (code: string, format: string) => {
      const now = Date.now()
      // La misma lectura repetida por la cámara no se cuenta dos veces seguidas.
      if (code === last.current.code && now - last.current.at < cooldownMs) { last.current.at = now; return }
      last.current = { code, at: now }
      if (navigator.vibrate) navigator.vibrate(60)
      cb.current({ code, format })
      if (!continuous) onClose?.()
    }
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) { setError(window.isSecureContext ? 'Este navegador no permite usar la cámara.' : 'La cámara solo funciona en una página segura (HTTPS). Abrí el sistema con https://.'); return }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: deviceId ? undefined : { ideal: 'environment' }, deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      } catch (e: any) {
        setError(e.name === 'NotAllowedError' ? 'Permitís la cámara en el navegador para poder escanear.' : e.name === 'NotFoundError' ? 'No se encontró una cámara en este dispositivo.' : 'No se pudo abrir la cámara: ' + e.message); return
      }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return }
      const v = video.current!
      v.srcObject = stream; v.setAttribute('playsinline', 'true'); await v.play().catch(() => {})
      navigator.mediaDevices.enumerateDevices().then((d) => setCameras(d.filter((x) => x.kind === 'videoinput'))).catch(() => {})
      const track = stream.getVideoTracks()[0]
      setCanTorch(!!(track.getCapabilities?.() as any)?.torch)
      const BD = (window as any).BarcodeDetector
      if (BD) {
        const supported: string[] = await BD.getSupportedFormats?.().catch(() => FORMATS) ?? FORMATS
        const det = new BD({ formats: FORMATS.filter((f) => supported.includes(f)) })
        const tick = async () => {
          if (stopped) return
          try { if (v.readyState >= 2) { const found = await det.detect(v); if (found[0]) emit(found[0].rawValue, found[0].format) } } catch { /* un cuadro sin código */ }
          raf = window.setTimeout(tick, 120) as unknown as number
        }
        tick()
      } else {
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 120 })
        zxingControls = await reader.decodeFromVideoElement(v, (result) => { if (result) emit(result.getText(), String(result.getBarcodeFormat())) })
      }
    }
    start()
    return () => { stopped = true; clearTimeout(raf); zxingControls?.stop(); stream?.getTracks().forEach((t) => t.stop()) }
  }, [deviceId, continuous])

  const toggleTorch = async () => {
    const track = (video.current?.srcObject as MediaStream | null)?.getVideoTracks()[0]
    try { await track?.applyConstraints({ advanced: [{ torch: !torch } as any] }); setTorch(!torch) } catch { /* sin linterna */ }
  }

  if (error) return <div className="errbox">{error}</div>
  return (
    <div>
      <div className="scanner"><video ref={video} muted playsInline /><div className="frame" /><div className="hint">{hint ?? 'Apuntá al código de barras o QR'}</div></div>
      <div className="row" style={{ marginTop: 8 }}>
        {cameras.length > 1 && <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} aria-label="Cámara"><option value="">Cámara trasera</option>{cameras.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || 'Cámara ' + (i + 1)}</option>)}</select>}
        {canTorch && <button type="button" onClick={toggleTorch}>{torch ? 'Apagar linterna' : 'Linterna'}</button>}
        {onClose && <button type="button" onClick={onClose}>Cerrar cámara</button>}
      </div>
    </div>
  )
}

/** Lectores USB/Bluetooth que "escriben" el código y terminan con Enter: se detectan por la velocidad de tecleo. */
export function useKeyboardScanner(onCode: (code: string) => void, enabled = true) {
  const cb = useRef(onCode)
  cb.current = onCode
  useEffect(() => {
    if (!enabled) return
    let buf = ''
    let lastAt = 0
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const now = Date.now()
      if (now - lastAt > 60) buf = ''
      lastAt = now
      if (e.key === 'Enter') {
        // Solo si llegó tecleado a velocidad de lector (no una persona escribiendo en un campo)
        if (buf.length >= 6) { if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') (t as HTMLInputElement).value = ''; e.preventDefault(); cb.current(buf) }
        buf = ''; return
      }
      if (e.key.length === 1) buf += e.key
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled])
}
