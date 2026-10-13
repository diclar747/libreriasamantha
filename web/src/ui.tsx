import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, gs, useApp } from './api'

// ---------------------------------------------------------------- Formato
export const fmtDate = (v?: string | null) => (v ? new Date(String(v).length <= 10 ? v + 'T12:00:00' : v).toLocaleDateString('es-PY') : '—')
export const fmtDateTime = (v?: string | null) => (v ? new Date(v).toLocaleString('es-PY', { dateStyle: 'short', timeStyle: 'short' }) : '—')
export const today = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
export const plusDays = (n: number) => new Date(Date.now() - 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10)
export const num = (v: unknown) => Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0
export const qs = (o: Record<string, unknown>) => Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null && v !== false).map(([k, v]) => `${k}=${encodeURIComponent(String(v === true ? 1 : v))}`).join('&')

// ---------------------------------------------------------------- Datos
export function useQuery<T = any>(path: string | null, deps: unknown[] = []) {
  const { toast } = useApp()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(!!path)
  const seq = useRef(0)
  const reload = useCallback(() => {
    if (!path) return Promise.resolve()
    const n = ++seq.current
    setLoading(true)
    return api<T>(path).then((d) => { if (n === seq.current) setData(d) }).catch((e) => { if (n === seq.current) toast(e.message, true) }).finally(() => { if (n === seq.current) setLoading(false) })
  }, [path])
  useEffect(() => { reload() }, [reload, ...deps])
  return { data, loading, reload, setData }
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

/** Descarga o abre un archivo que requiere sesión (PDF, Excel, comprobantes). */
export async function openAuthed(path: string, opts: { download?: string } = {}) {
  const token = localStorage.getItem('samantha.token')
  const res = await fetch('/api' + path, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Error ${res.status}`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  if (opts.download) { const a = document.createElement('a'); a.href = url; a.download = opts.download; a.click() } else window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('No se pudo leer el archivo')); r.readAsDataURL(file) })
}

// ---------------------------------------------------------------- Estados
const STATUS: Record<string, [string, string]> = {
  draft: ['Borrador', ''], pending_approval: ['Por aprobar', 'warn'], approved: ['Aprobada', 'ok'], issued: ['Emitida', 'ok'], partial: ['Parcial', 'warn'], received: ['Recibida', 'ok'],
  closed_short: ['Cerrada incompleta', 'warn'], cancelled: ['Anulada', 'bad'], open: ['Pendiente', 'warn'], paid: ['Pagada', 'ok'], void: ['Anulada', 'bad'], posted: ['Registrada', 'ok'],
  pending: ['Pendiente', 'warn'], in_review: ['En revisión', 'warn'], rejected: ['Rechazado', 'bad'], refunded: ['Reembolsado', 'bad'], preparing: ['Preparando', 'warn'], ready: ['Listo', 'ok'],
  dispatched: ['En camino', 'warn'], delivered: ['Entregado', 'ok'], incident: ['Incidencia', 'bad'], confirmed: ['Confirmado', 'ok'], completed: ['Completado', 'ok'],
  overdue: ['Vencida', 'bad'], due_soon: ['Vence pronto', 'warn'], current: ['Al día', 'ok'], available: ['Disponible', 'ok'], low: ['Quedan pocos', 'warn'], out: ['Agotado', 'bad'],
  none: ['Sin crédito', ''], credited: ['Acreditada', 'ok'], active: ['Activo', 'ok'], inactive: ['Inactivo', ''],
}
export function Status({ value, label }: { value: string; label?: string }) {
  const [text, kind] = STATUS[value] ?? [value, '']
  return <span className={'pill ' + kind}>{label ?? text}</span>
}

// ---------------------------------------------------------------- Layout
export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean | 'xl' }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide === 'xl' ? ' xl' : wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="icon-x" onClick={onClose} aria-label="Cerrar">×</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string, number?][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label, badge]) => (
        <button key={k} role="tab" aria-selected={k === value} className={k === value ? 'on' : ''} onClick={() => onChange(k)}>{label}{!!badge && <span className="badge">{badge}</span>}</button>
      ))}
    </div>
  )
}

export function Pager({ page, pages, total, pageSize, onPage, onSize, sizes = [15, 30, 50, 100] }: { page: number; pages: number; total: number; pageSize: number; onPage: (p: number) => void; onSize?: (s: number) => void; sizes?: number[] }) {
  return (
    <div className="pager">
      <span className="muted">{total} registros</span>
      <span className="spacer" />
      {onSize && <label className="inline">Por página<select value={pageSize} onChange={(e) => onSize(Number(e.target.value))}>{sizes.map((s) => <option key={s}>{s}</option>)}</select></label>}
      <button disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Anterior">‹</button>
      <span>{page} / {pages}</span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Siguiente">›</button>
    </div>
  )
}

export function Field({ label, children, hint, error, span }: { label: string; children: ReactNode; hint?: string; error?: string; span?: number }) {
  return <label className={error ? 'has-error' : ''} style={span ? { gridColumn: span >= 4 ? '1 / -1' : `span ${span}` } : undefined}>{label}{children}{hint && <small className="muted">{hint}</small>}{error && <small className="err">{error}</small>}</label>
}

/** Importe en guaraníes con separador de miles mientras se escribe. */
export function Money({ value, onChange, ...rest }: { value: number | string | null | undefined; onChange: (n: number) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const n = Number(value ?? 0)
  return <input inputMode="numeric" {...rest} value={n ? n.toLocaleString('es-PY') : ''} placeholder={rest.placeholder ?? '0'} onChange={(e) => onChange(num(e.target.value))} />
}

export function EmptyRow({ cols, text = 'Sin resultados' }: { cols: number; text?: string }) {
  return <tr><td colSpan={cols} className="muted empty">{text}</td></tr>
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'bad' | 'warn' }) {
  return <div className={'kpi' + (tone ? ' ' + tone : '')}><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>
}

// ---------------------------------------------------------------- Pedir un motivo / confirmar
interface Ask { title: string; label?: string; confirm?: string; danger?: boolean; reason?: boolean; resolve: (v: string | null) => void }
const AskCtx = createContext<(o: Omit<Ask, 'resolve'>) => Promise<string | null>>(async () => null)
export const useAsk = () => useContext(AskCtx)
export function AskProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null)
  const [text, setText] = useState('')
  const fn = useCallback((o: Omit<Ask, 'resolve'>) => new Promise<string | null>((resolve) => { setText(''); setAsk({ ...o, resolve }) }), [])
  const done = (v: string | null) => { ask?.resolve(v); setAsk(null) }
  return (
    <AskCtx.Provider value={fn}>
      {children}
      {ask && (
        <Modal title={ask.title} onClose={() => done(null)} footer={<>
          <button onClick={() => done(null)}>Cancelar</button>
          <button className={ask.danger ? 'danger' : 'primary'} disabled={ask.reason !== false && ask.reason !== undefined && text.trim().length < 3} onClick={() => done(text.trim() || 'ok')}>{ask.confirm ?? 'Confirmar'}</button></>}>
          {ask.reason !== undefined && <label>{ask.label ?? 'Motivo'}<textarea rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} /></label>}
        </Modal>
      )}
    </AskCtx.Provider>
  )
}

// ---------------------------------------------------------------- Comprobantes adjuntos
export function Attachments({ ownerType, ownerId, canUpload = true }: { ownerType: string; ownerId: number; canUpload?: boolean }) {
  const { toast } = useApp()
  const { data, reload } = useQuery<any[]>(`/attachments?ownerType=${ownerType}&ownerId=${ownerId}`)
  const [busy, setBusy] = useState(false)
  async function upload(file: File) {
    setBusy(true)
    try {
      await api('/attachments', { body: { ownerType, ownerId, filename: file.name, mime: file.type, dataBase64: await fileToBase64(file) } })
      toast('Comprobante adjuntado'); reload()
    } catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }
  return (
    <div className="attachments">
      {(data ?? []).map((a) => <button key={a.id} className="chip" onClick={() => openAuthed(`/attachments/${a.id}/file`).catch((e) => toast(e.message, true))}>📎 {a.filename}</button>)}
      {!data?.length && <span className="muted">Sin comprobantes</span>}
      {canUpload && <label className="btn small">{busy ? 'Subiendo…' : 'Adjuntar'}<input type="file" hidden accept="image/*,application/pdf" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>}
    </div>
  )
}

export { gs }
