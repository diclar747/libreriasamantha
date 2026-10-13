import { HttpError, type Db, type Tx } from './db/client.js'
import { getSetting } from './services.js'

type Q = Db | Tx

export const DEFAULT_BASE_FEE = 30000

export async function baseFee(q: Q) {
  const shop = await getSetting(q, 'shop')
  return Number(shop.baseDeliveryFee ?? DEFAULT_BASE_FEE)
}

export interface CityQuote {
  cityId: number; city: string; department: string; covered: boolean; fee: number; eta: string | null; notes: string | null; source: 'city' | 'base'; specialZones: { name: string; fee: number }[]
}

// Tarifa de una ciudad: la propia si está cargada; si no, la tarifa base del local. Solo se entrega donde hay cobertura.
export async function quoteCity(q: Q, cityId: number, zone?: string | null): Promise<CityQuote> {
  const base = await baseFee(q)
  const { rows } = await q.query(
    `SELECT c.id, c.name, c.department, r.covered, r.price, r.eta, r.notes, r.special_zones FROM geo_cities c LEFT JOIN delivery_rates r ON r.city_id = c.id WHERE c.id = $1 AND c.active`, [cityId])
  if (!rows[0]) throw new HttpError(404, 'Ciudad no encontrada')
  const r = rows[0]
  const specials = (r.special_zones ?? []) as { name: string; fee: number }[]
  const sz = zone ? specials.find((s) => s.name.toLowerCase() === zone.toLowerCase()) : undefined
  return {
    cityId: r.id, city: r.name, department: r.department, covered: !!r.covered, fee: sz ? Number(sz.fee) : r.price != null ? Number(r.price) : base,
    eta: r.eta ?? null, notes: r.notes ?? null, source: r.price != null || sz ? 'city' : 'base', specialZones: specials,
  }
}
