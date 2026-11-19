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
export interface FacturaItem { CODIGO?: string; DESCRIPCION: string; CANTIDAD: number; PRECIO: number; IVA: 0 | 5 | 10 }
export interface FacturaPayload {
  RUC: string; RAZON_SOCIAL: string; PERSONA: 'FISICA' | 'JURIDICA'; CONTRIBUYENTE: 'SI' | 'NO'
  CONDICION: 'CONTADO' | 'CREDITO'; PLAZO?: string
  ITEMS: FacturaItem[]
  TIPO_DOCUMENTO?: 'NOTA_DE_CREDITO' | 'NOTA_DE_DEBITO'; MOTIVO?: number; FACTURA_CDC?: string
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
    return withAssetBase(await r.text(), cfg.base ?? DEFAULT_BASE)
  } finally { t.done() }
}

// El comprobante de OñeTema trae el logo (y demás recursos) con rutas RELATIVAS.
// Nuestro frontend lo imprime escribiéndolo en una ventana en blanco (document.write),
// que no tiene URL base, así que esas rutas no resuelven y el logo no carga.
// Inyectamos un <base> hacia OñeTema para que las rutas relativas bajen de su servidor,
// y forzamos https en los recursos de su dominio (evita bloqueo por contenido mixto).
function withAssetBase(html: string, base: string): string {
  const baseTag = `<base href="${base}/fact_elect/">`
  let out = html.replace(/http:\/\/(www\.)?oietema\.com/gi, 'https://oietema.com')
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`)
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => `${m}<head>${baseTag}</head>`)
  else out = baseTag + out
  return out
}

// ---------------------------------------------------------------- Anulación
// Evento de cancelación de SIFEN (cancelar_api.php). Solo facturas APROBADAS, dentro de las 48 h, motivo ≥ 5 caracteres.
// OJO: la documentación dice {"status","message","protocolo"}, pero el servidor REAL responde en español:
//   {"estado":"error","mensaje":"El CDC proporcionado no corresponde a este emisor.","cdc":"No disponible"}
// Se aceptan las dos formas. Como el formato de éxito no está garantizado, quien llama confirma además con el KUDE (kudeAnnulment).
export interface CancelResult { ok: boolean; message?: string; protocol?: string; raw?: string }
export function parseCancel(text: string, httpStatus = 200): CancelResult {
  let j: any
  try { j = JSON.parse(text) } catch { return { ok: false, message: text.trim().slice(0, 300) || `El facturador respondió ${httpStatus}`, raw: text.slice(0, 500) } }
  const state = String(j.status ?? j.estado ?? '').trim().toLowerCase()
  const message = j.message ?? j.mensaje ?? j.msg
  const ok = /^(ok|success|exito|éxito|exitoso|aprobado|cancelado)$/.test(state)
    || (!state && /cancelaci[oó]n (procesada|exitosa|registrada|aprobada)/i.test(String(message ?? '')))
  const protocol = j.protocolo ?? j.protocol ?? j.nroProtocolo
  return { ok, message, protocol: protocol != null && protocol !== '' ? String(protocol) : undefined, raw: text.slice(0, 500) }
}
export async function cancelar(cfg: OietemaConfig, cdc: string, motivo: string): Promise<CancelResult> {
  const base = cfg.base ?? DEFAULT_BASE
  const form = new URLSearchParams({ apiKey: cfg.apiKey, tenantId: cfg.tenant, cdc, motivo })
  const t = withTimeout(30000)
  try {
    const r = await fetch(`${base}/fact_elect/cancelar_api.php`, { method: 'POST', body: form, signal: t.signal })
    return parseCancel(await r.text(), r.status)
  } catch (e: any) { return { ok: false, message: `No se pudo conectar con el facturador: ${e.message}` } } finally { t.done() }
}

// Fuente de verdad del estado en SET: el KUDE oficial muestra el sello "DOCUMENTO ANULADO — Motivo: …" solo cuando
// el documento fue cancelado (verificado: aparece en la cancelada y no en las vigentes). null = no se pudo consultar.
export async function kudeAnnulment(cfg: Pick<OietemaConfig, 'base'>, cdc: string): Promise<{ annulled: boolean; reason?: string } | null> {
  const t = withTimeout(15000)
  try {
    const r = await fetch(`${cfg.base ?? DEFAULT_BASE}/fact_elect/kude.php?cdc=${encodeURIComponent(cdc)}`, { signal: t.signal })
    if (!r.ok) return null
    const plain = (await r.text())
      .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ')
    const m = plain.match(/DOCUMENTO\s+ANULADO(?:\s+Motivo:\s*(.{3,200}?))?(?=\s+[A-ZÁÉÍÓÚÑ]{4,}\s+[A-ZÁÉÍÓÚÑ]{3,}|$)/)
    if (!/DOCUMENTO\s+ANULADO/.test(plain)) return { annulled: false }
    return { annulled: true, reason: m?.[1]?.trim() }
  } catch { return null } finally { t.done() }
}
