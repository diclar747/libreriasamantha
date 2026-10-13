import { enqueue } from './services.js'
import type { Db, Tx } from './db/client.js'

type Q = Db | Tx

// Etapa que ve el cliente, calculada a partir de los estados reales del pedido (pedido, pago y entrega son independientes).
export type Stage = 'pending' | 'confirmed' | 'preparing' | 'ready_to_ship' | 'shipped' | 'ready_pickup' | 'delivered' | 'picked_up' | 'cancelled'
export function stageOf(o: any): Stage {
  if (o.status === 'cancelled') return 'cancelled'
  const pickup = o.delivery_method === 'pickup'
  switch (o.delivery_status) {
    case 'delivered': return pickup ? 'picked_up' : 'delivered'
    case 'dispatched': return 'shipped'
    case 'ready': return pickup ? 'ready_pickup' : 'ready_to_ship'
    case 'preparing': return 'preparing'
    case 'incident': return o.dispatched_at ? 'shipped' : o.ready_at ? (pickup ? 'ready_pickup' : 'ready_to_ship') : 'preparing'
  }
  return o.confirmed_at ? 'confirmed' : 'pending'
}
export const STAGE_TEXT: Record<Stage, { label: string; customer: string }> = {
  pending: { label: 'Pendiente', customer: 'Recibimos tu pedido y está pendiente de revisión.' },
  confirmed: { label: 'Confirmado', customer: 'Tu pedido fue aceptado.' },
  preparing: { label: 'En preparación', customer: 'Estamos preparando tus productos.' },
  ready_to_ship: { label: 'Listo para envío', customer: 'Tu pedido está preparado para despacharse.' },
  shipped: { label: 'Enviado / En camino', customer: 'Tu pedido fue despachado.' },
  ready_pickup: { label: 'Listo para retirar', customer: 'Tu compra está disponible para retirar en el local.' },
  delivered: { label: 'Entregado', customer: 'La compra fue entregada.' },
  picked_up: { label: 'Retirado', customer: 'La compra fue retirada.' },
  cancelled: { label: 'Cancelado', customer: 'El pedido fue cancelado.' },
}
export const flowFor = (method: string): Stage[] => method === 'pickup'
  ? ['pending', 'confirmed', 'preparing', 'ready_pickup', 'picked_up']
  : ['pending', 'confirmed', 'preparing', 'ready_to_ship', 'shipped', 'delivered']

export async function logOrder(q: Q, orderId: number, h: { kind: 'order' | 'payment' | 'delivery' | 'note' | 'return' | 'shipment'; from?: string | null; to?: string | null; title: string; note?: string | null; visible?: boolean; userId?: number | null; accountId?: number | null }) {
  await q.query('INSERT INTO order_history (order_id, kind, from_state, to_state, title, note, visible, user_id, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [orderId, h.kind, h.from ?? null, h.to ?? null, h.title, h.note ?? null, h.visible ?? true, h.userId ?? null, h.accountId ?? null])
}

const CHANNEL_OF: Record<string, 'inapp' | 'whatsapp' | 'email'> = {}
void CHANNEL_OF

// Aviso al cliente por los canales habilitados (en el perfil, WhatsApp y correo). El estado del pedido ya está guardado:
// si un envío falla se reintenta desde la cola sin duplicarse (dedupeKey).
export async function notifyCustomer(q: Q, order: any, n: { type: string; title: string; body: string; dedupeKey: string }) {
  let prefs: any = {}
  if (order.account_id) {
    const { rows } = await q.query('SELECT notif_prefs, email FROM customer_accounts WHERE id = $1', [order.account_id])
    prefs = rows[0]?.notif_prefs ?? {}
    if (prefs[n.type]?.inapp !== false) {
      await q.query(`INSERT INTO customer_notifications (account_id, order_id, type, title, body, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
        [order.account_id, order.id, n.type, n.title, `${n.body} (Pedido ${order.number})`, 'c:' + n.dedupeKey])
    }
  }
  const text = `${n.title}: ${n.body} Pedido ${order.number}.`
  if (order.phone && prefs[n.type]?.whatsapp !== false) await enqueue(q, { phone: order.phone, dedupeKey: 'wa:' + n.dedupeKey, body: text })
  const email = order.email
  if (email && prefs[n.type]?.email !== false) {
    await q.query(`INSERT INTO outbox (to_phone, audience, body, dedupe_key, channel, to_email, subject) VALUES (NULL,'customer',$1,$2,'email',$3,$4) ON CONFLICT (dedupe_key) DO NOTHING`,
      [text, 'em:' + n.dedupeKey, email, `${n.title} · Pedido ${order.number}`])
  }
}

export const NOTIF_TYPES: Record<string, string> = {
  order_received: 'Recibimos tu pedido', payment: 'Pagos y comprobantes', order_status: 'Estado de tu pedido', delivery: 'Envío y entrega', incident: 'Incidencias de entrega', cancel: 'Cancelaciones', returns: 'Devoluciones y reembolsos',
}
