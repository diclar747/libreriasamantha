import { HttpError, type Db, type Tx } from './db/client.js'
import { todayPy } from './pricing.js'
import { getSetting } from './services.js'

type Q = Db | Tx

// Tarifa general de delivery: se cobra en CUALQUIER ciudad que no tenga una tarifa propia.
export const DEFAULT_BASE_FEE = 30000

export interface DeliveryConfig {
  baseFee: number
  enabled: boolean            // interruptor general: si está apagado no se hacen entregas en ninguna ciudad
  freeFrom: number | null     // delivery gratis desde este monto de compra (promoción general)
  promoStart: string | null   // vigencia de la promoción (opcional)
  promoEnd: string | null
  defaultEta: string | null   // plazo estimado general
}

export async function deliveryConfig(q: Q): Promise<DeliveryConfig> {
  const shop = await getSetting(q, 'shop')
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
  return {
    baseFee: Number(shop.baseDeliveryFee ?? DEFAULT_BASE_FEE),
    enabled: shop.deliveryEnabled !== false,
    freeFrom: num(shop.deliveryFreeFrom),
    promoStart: shop.deliveryPromoStart || null,
    promoEnd: shop.deliveryPromoEnd || null,
    defaultEta: shop.deliveryDefaultEta || null,
  }
}
export async function baseFee(q: Q) { return (await deliveryConfig(q)).baseFee }

/** ¿La promoción general de delivery gratis está vigente hoy? */
export function promoActive(c: DeliveryConfig, today = todayPy()) {
  if (c.freeFrom === null) return false
  if (c.promoStart && today < c.promoStart) return false
  if (c.promoEnd && today > c.promoEnd) return false
  return true
}

export interface CityQuote {
  cityId: number; city: string; department: string
  covered: boolean
  fee: number                  // lo que se cobra (0 si corresponde delivery gratis)
  baseFee: number              // tarifa antes de aplicar delivery gratis
  freeReason: 'city_free' | 'min_amount' | null
  freeFrom: number | null      // monto a partir del cual esta ciudad tiene delivery gratis (si aplica)
  missingForFree: number | null // cuánto le falta al cliente para llegar al delivery gratis
  eta: string | null; notes: string | null
  source: 'city' | 'base'
  specialZones: { name: string; fee: number }[]
}

// Cotiza el delivery de una ciudad. El monto SIEMPRE se calcula acá, en el servidor: el navegador nunca fija el precio.
// `subtotal` es el importe de los productos (ya con descuentos); sin él no se evalúa el delivery gratis por monto.
export async function quoteCity(q: Q, cityId: number, zone?: string | null, subtotal?: number): Promise<CityQuote> {
  const cfg = await deliveryConfig(q)
  const { rows } = await q.query(
    `SELECT c.id, c.name, c.department, c.active, r.covered, r.price, r.eta, r.notes, r.special_zones, r.free_mode, r.free_from
     FROM geo_cities c LEFT JOIN delivery_rates r ON r.city_id = c.id WHERE c.id = $1`, [cityId])
  if (!rows[0]) throw new HttpError(404, 'Ciudad no encontrada')
  const r = rows[0]
  const specials = (r.special_zones ?? []) as { name: string; fee: number }[]
  const sz = zone ? specials.find((s) => s.name.toLowerCase() === zone.toLowerCase()) : undefined
  // Sin tarifa cargada la ciudad igual tiene delivery (tarifa general); solo se corta si se desactiva a propósito.
  const covered = cfg.enabled && !!r.active && (r.covered === null || r.covered === true)
  const base = sz ? Number(sz.fee) : r.price != null ? Number(r.price) : cfg.baseFee
  const mode: string = r.free_mode ?? 'global'
  let threshold: number | null = null
  if (mode === 'amount') threshold = r.free_from != null ? Number(r.free_from) : null
  else if (mode === 'global') threshold = promoActive(cfg) ? cfg.freeFrom : null
  let fee = base
  let freeReason: CityQuote['freeReason'] = null
  if (covered && mode === 'always') { fee = 0; freeReason = 'city_free' }
  else if (covered && threshold !== null && subtotal !== undefined && subtotal >= threshold) { fee = 0; freeReason = 'min_amount' }
  return {
    cityId: r.id, city: r.name, department: r.department, covered, fee, baseFee: base, freeReason,
    freeFrom: mode === 'always' ? null : threshold,
    missingForFree: covered && freeReason === null && threshold !== null && subtotal !== undefined ? Math.max(threshold - subtotal, 0) : null,
    eta: r.eta ?? cfg.defaultEta ?? null, notes: r.notes ?? null, source: r.price != null || sz ? 'city' : 'base', specialZones: specials,
  }
}
