// Cliente de la API de facturación electrónica OñeTema (SIFEN Paraguay).
// Documentación: https://oietema.com/fact_elect/api_docs.html
import { baseRuc } from './ruc.js'

export interface OietemaConfig {
  apiKey: string
  tenant: string
  establishment: string // ej. "001"
  point: string         // ej. "001"
  format?: string       // "A4" | "TICKET"
  base?: string         // dominio, por defecto https://oietema.com
}

const DEFAULT_BASE = 'https://oietema.com'
const withTimeout = (ms: number) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) } }

// ---------------------------------------------------------------- Consulta de RUC (pública, sin credenciales)
export interface RucInfo { exists: boolean; razonSocial?: string; rucConDv?: string; estado?: string }
export async function consultarRuc(doc: string, base = DEFAULT_BASE): Promise<RucInfo> {
  const num = baseRuc(doc)
  if (!num) return { exists: false }
  const t = withTimeout(8000)
  try {
    const r = await fetch(`${base}/ruc/?ruc=${encodeURIComponent(num)}`, { signal: t.signal })
    const j = await r.json().catch(() => ({} as any))
    if (j && j.razon_social) return { exists: true, razonSocial: String(j.razon_social).trim(), rucConDv: String(j.ruc ?? '').trim(), estado: j.estado }
    return { exists: false }
  } catch { return { exists: false } } finally { t.done() }
}

// ---------------------------------------------------------------- Emisión de factura / nota de crédito
export interface FacturaItem { DESCRIPCION: string; CANTIDAD: number; PRECIO: number; IVA: 0 | 5 | 10 }
export interface FacturaPayload {
  RUC: string; RAZON_SOCIAL: string; PERSONA: 'FISICA' | 'JURIDICA'; CONTRIBUYENTE: 'SI' | 'NO'
  CONDICION: 'CONTADO' | 'CREDITO'; PLAZO?: string
  ITEMS: FacturaItem[]
  TIPO_DOCUMENTO?: 'NOTA_DE_CREDITO' | 'NOTA_DE_DEBITO'; MOTIVO?: string; FACTURA_CDC?: string
  EMAIL?: string
}
export interface EmitResult { status: 'approved' | 'rejected'; cdc?: string; number?: string; error?: string }

export async function emitir(cfg: OietemaConfig, p: FacturaPayload): Promise<EmitResult> {
  const base = cfg.base ?? DEFAULT_BASE
  const body = [{
    API_KEY: cfg.apiKey, TENANT_ID: cfg.tenant,
    ESTABLECIMIENTO: cfg.establishment, PUNTO: cfg.point,
    FORMATO: (cfg.format || 'A4').toUpperCase(),
    ...p,
  }]
  const t = withTimeout(20000)
  let text = ''
  try {
    const r = await fetch(`${base}/fact_elect/index.php`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: t.signal })
    text = await r.text()
  } catch (e: any) {
    return { status: 'rejected', error: `No se pudo conectar con el facturador: ${e.message}` }
  } finally { t.done() }
  return parseEmit(text)
}

// La respuesta es texto plano, p.ej.:
//   Cliente: ...\nEstado: success\nMensaje: Factura creada...\nNUM: 2-CDC: 0107446...  (44 dígitos)
// Error: "Estado: error ... Mensaje: ..." o "ERROR ...: ...".
export function parseEmit(text: string): EmitResult {
  const cdc = text.match(/CDC:\s*([0-9]{40,44})/)?.[1]
  const num = text.match(/NUM:\s*([^\-\s]+)\s*-\s*CDC/)?.[1]
  // Aprobada si trae un CDC válido y no viene marcada como error.
  if (cdc && !/Estado:\s*error/i.test(text)) return { status: 'approved', cdc, number: num }
  const msg = text.match(/Mensaje:\s*([^\n]+)/i)?.[1]?.trim()
    || text.match(/ERROR[^\n:]*:\s*([^\n]+)/i)?.[1]?.trim()
    || text.trim().slice(0, 300)
  return { status: 'rejected', error: msg || 'El facturador rechazó el documento.' }
}

// ---------------------------------------------------------------- KUDE (comprobante imprimible, HTML)
export function kudeUrl(cfg: OietemaConfig, cdc: string, format?: string): string {
  const base = cfg.base ?? DEFAULT_BASE
  const fmt = (format ?? cfg.format ?? 'A4').toLowerCase()
  const q = fmt === 'ticket' ? '&formato=ticket' : '' // A4 = sin parámetro
  return `${base}/fact_elect/kude.php?cdc=${encodeURIComponent(cdc)}${q}`
}
export async function fetchKude(cfg: OietemaConfig, cdc: string, format?: string): Promise<string> {
  const t = withTimeout(15000)
  try {
    const r = await fetch(kudeUrl(cfg, cdc, format), { signal: t.signal })
    return await r.text()
  } finally { t.done() }
}

// ---------------------------------------------------------------- Anulación
export async function cancelar(cfg: OietemaConfig, cdc: string, motivo: string): Promise<{ ok: boolean; message?: string }> {
  const base = cfg.base ?? DEFAULT_BASE
  const form = new URLSearchParams({ apiKey: cfg.apiKey, tenantId: cfg.tenant, cdc, motivo })
  const t = withTimeout(20000)
  try {
    const r = await fetch(`${base}/fact_elect/cancelar_api.php`, { method: 'POST', body: form, signal: t.signal })
    const j = await r.json().catch(() => ({} as any))
    return { ok: j.status === 'ok', message: j.message }
  } catch (e: any) { return { ok: false, message: e.message } } finally { t.done() }
}
