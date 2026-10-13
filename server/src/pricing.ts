// Cálculo de precios, IVA y ofertas. Los precios de venta se guardan con IVA incluido (como en Paraguay).
export type Channel = 'local' | 'online'

export const todayPy = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)

export function vatOf(gross: number, rate: number) {
  if (rate === 10) return Math.round(gross / 11)
  if (rate === 5) return Math.round(gross / 21)
  return 0
}

/** Desglose de un precio con IVA incluido. */
export function breakdown(gross: number, rate: number) {
  const tax = vatOf(gross, rate)
  return { net: gross - tax, tax, gross }
}

/** Costo sin IVA, según cómo se cargó el costo. */
export function netCost(cost: number, includesVat: boolean, rate: number) {
  return includesVat ? cost - vatOf(cost, rate) : cost
}

/** Precio de venta (IVA incluido) sugerido a partir del costo y el margen de ganancia sobre el costo. */
export function priceFromMarkup(cost: number, markupPct: number, includesVat: boolean, rate: number, roundTo = 100) {
  const net = netCost(cost, includesVat, rate)
  const gross = net * (1 + markupPct / 100) * (1 + rate / 100)
  return Math.round(gross / roundTo) * roundTo
}

/** Margen sobre costo (%) con el precio dado. */
export function markupOf(price: number, cost: number, includesVat: boolean, rate: number) {
  const n = netCost(cost, includesVat, rate)
  if (n <= 0) return null
  return Math.round(((price - vatOf(price, rate)) / n - 1) * 10000) / 100
}

export function marginOf(price: number, cost: number, includesVat: boolean, rate: number) {
  const net = price - vatOf(price, rate)
  if (net <= 0) return null
  return Math.round(((net - netCost(cost, includesVat, rate)) / net) * 10000) / 100
}

interface OfferFields {
  price: number | string
  offer_enabled?: boolean | null
  offer_price?: number | string | null
  offer_pct?: number | string | null
  offer_start?: string | Date | null
  offer_end?: string | Date | null
  offer_channel?: string | null
  offer_label?: string | null
}
const day = (d: string | Date | null | undefined) => (d ? (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : String(d).slice(0, 10)) : null)

export function offerPrice(p: OfferFields): number | null {
  if (p.offer_price != null && Number(p.offer_price) > 0) return Number(p.offer_price)
  if (p.offer_pct != null && Number(p.offer_pct) > 0) return Math.round(Number(p.price) * (1 - Number(p.offer_pct) / 100))
  return null
}

export function offerActive(p: OfferFields, channel: Channel, today = todayPy()) {
  if (!p.offer_enabled) return false
  const ch = p.offer_channel ?? 'both'
  if (ch !== 'both' && ch !== channel) return false
  const s = day(p.offer_start), e = day(p.offer_end)
  if (s && today < s) return false
  if (e && today > e) return false
  const op = offerPrice(p)
  return op != null && op < Number(p.price)
}

/** Precio vigente para el canal: el de la oferta si corresponde, si no el de lista. */
export function effectivePrice(p: OfferFields, channel: Channel, today = todayPy()) {
  const list = Number(p.price)
  if (offerActive(p, channel, today)) {
    const price = offerPrice(p)!
    return { price, list, onOffer: true, label: p.offer_label || 'Oferta', savingPct: Math.round((1 - price / list) * 100) }
  }
  return { price: list, list, onOffer: false, label: null as string | null, savingPct: 0 }
}

/** Disponibilidad para la tienda: nunca expone cantidades. */
export function availability(stock: number, reserved: number, min: number): 'available' | 'low' | 'out' {
  const a = stock - reserved
  if (a <= 0) return 'out'
  return a <= Math.max(min, 0) && min > 0 ? 'low' : 'available'
}
