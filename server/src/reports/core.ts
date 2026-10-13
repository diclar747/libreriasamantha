import type { Db } from '../db/client.js'
import { can } from '../auth.js'

export type ColType = 'text' | 'money' | 'int' | 'date' | 'datetime' | 'percent' | 'status'
export interface Column { key: string; label: string; type: ColType; sensitive?: boolean; width?: number }
export interface Section { title: string; columns: Column[]; rows: Record<string, any>[]; totals?: Record<string, any> }
export interface ReportResult {
  id: string
  title: string
  subtitle?: string
  columns: Column[]
  rows: Record<string, any>[]
  totals?: Record<string, any>
  groupBy?: string
  sections?: Section[]
  meta?: Record<string, any>
}
export interface Filters {
  from?: string; to?: string; range?: string; dateField?: string
  channel?: string; sellerId?: number; customerId?: number; supplierId?: number; productId?: number
  category?: string; categoryId?: number; brand?: string; method?: string; accountId?: number; sessionId?: number
  condition?: string; state?: string; collection?: string; status?: string; q?: string
  groupBy?: string; view?: string; kinds?: string[]; direction?: string; asOf?: string; userId?: number
  overdue?: boolean; includeVoided?: boolean; partyType?: string; partyId?: number
}
export interface Ctx { db: Db; user: { id: number; name: string; role: string }; filters: Filters }

export const localToday = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

// Atajos de período: hoy, ayer, semana (lunes a hoy), mes, año, últimos 7/30 días o rango personalizado.
export function resolvePeriod(f: { from?: string; to?: string; range?: string }) {
  const today = localToday()
  const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7 // lunes = 0
  switch (f.range) {
    case 'today': return { from: today, to: today }
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y } }
    case 'week': return { from: addDays(today, -dow), to: today }
    case 'month': return { from: today.slice(0, 8) + '01', to: today }
    case 'year': return { from: today.slice(0, 4) + '-01-01', to: today }
    case 'last7': return { from: addDays(today, -6), to: today }
    case 'last30': return { from: addDays(today, -29), to: today }
    default: return { from: f.from ?? today.slice(0, 8) + '01', to: f.to ?? today }
  }
}

// Período anterior de la misma duración (para comparar).
export function previousPeriod(p: { from: string; to: string }) {
  const days = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86400_000) + 1
  return { from: addDays(p.from, -days), to: addDays(p.from, -1) }
}

export function parseFilters(raw: Record<string, string | undefined>): Filters {
  // La pantalla usa nombres propios para algunos filtros; se normalizan acá.
  const q: Record<string, string | undefined> = { ...raw }
  const alias: Record<string, string> = { orderStatus: 'status', expenseStatus: 'status', cashStatus: 'status', settlement: 'status', paymentStatus: 'collection', deliveryStatus: 'condition', deliveryMethod: 'method', expenseCategory: 'categoryId', poStatus: 'status', invStatus: 'status', stockState: 'condition', stockType: 'method', seller: 'sellerId', customer: 'customerId', product: 'productId', supplier: 'supplierId', account: 'accountId', session: 'sessionId', user: 'userId' }
  for (const [from, to] of Object.entries(alias)) if (raw[from] !== undefined && raw[from] !== '' && q[to] === undefined) q[to] = raw[from]
  const num = (v?: string) => (v ? Number(v) : undefined)
  const p = resolvePeriod(q)
  return {
    from: p.from, to: p.to, range: q.range, dateField: q.dateField, channel: q.channel, sellerId: num(q.sellerId), customerId: num(q.customerId),
    supplierId: num(q.supplierId), productId: num(q.productId), category: q.category, categoryId: num(q.categoryId), brand: q.brand, method: q.method,
    accountId: num(q.accountId), sessionId: num(q.sessionId), condition: q.condition, state: q.state, collection: q.collection, status: q.status, q: q.q,
    groupBy: q.groupBy, view: q.view, kinds: q.kinds ? q.kinds.split(',') : undefined, direction: q.direction, asOf: q.asOf, userId: num(q.userId),
    overdue: q.overdue === '1', includeVoided: q.includeVoided === '1', partyType: q.partyType, partyId: num(q.partyId),
  }
}

// Constructor de parámetros SQL: p.add(valor) devuelve "$n".
export class Params {
  vals: unknown[] = []
  add(v: unknown) { this.vals.push(v); return '$' + this.vals.length }
}

export const sumBy = (rows: Record<string, any>[], keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, rows.reduce((a, r) => a + Number(r[k] ?? 0), 0)]))

export const pct = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : 0)

export const CHANNEL_LABEL: Record<string, string> = { pos: 'Mostrador', web: 'Tienda en línea', whatsapp: 'WhatsApp' }
export const STATE_LABEL: Record<string, string> = { valid: 'Vigente', void: 'Anulada', returned: 'Devuelta', partial_return: 'Devuelta parcial' }
export const COLLECTION_LABEL: Record<string, string> = { paid: 'Cobrada', partial: 'Cobro parcial', pending: 'Pendiente de cobro' }

// Quita columnas (y sus valores) que el usuario no puede ver: costos y ganancias.
export function applyPermissions(r: ReportResult, role: string): ReportResult {
  if (can(role, 'costs.view')) return r
  const hide = new Set(r.columns.filter((c) => c.sensitive).map((c) => c.key))
  const strip = (cols: Column[], rows: Record<string, any>[], totals?: Record<string, any>) => ({
    columns: cols.filter((c) => !hide.has(c.key)),
    rows: rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !hide.has(k)))),
    totals: totals && Object.fromEntries(Object.entries(totals).filter(([k]) => !hide.has(k))),
  })
  const main = strip(r.columns, r.rows, r.totals)
  return {
    ...r, ...main,
    sections: r.sections?.map((s) => {
      const sh = new Set(s.columns.filter((c) => c.sensitive).map((c) => c.key))
      return { ...s, columns: s.columns.filter((c) => !sh.has(c.key)), rows: s.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !sh.has(k)))) }
    }),
  }
}

export const REF_LINK: Record<string, string> = {
  sale: '/sales?open=', expense: '/reports/expenses?open=', purchase_order: '/purchases?open=', customer: '/customers?open=', cash_session: '/cash?session=',
  money_movement: '/reports/movements?open=',
}
export const refLink = (type?: string | null, id?: number | null) => (type && id && REF_LINK[type] ? REF_LINK[type] + id : null)
