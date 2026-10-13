import { HttpError, type Tx } from './db/client.js'

export interface StockMove {
  productId: number
  delta: number // + entrada / − salida (en unidades de venta)
  type: 'opening' | 'sale' | 'void' | 'return' | 'purchase' | 'supplier_return' | 'adjustment' | 'count' | 'online_sale' | 'transfer'
  unitCost?: number | null
  refType?: string
  refId?: number
  reason?: string | null
  userId?: number | null
  allowNegative?: boolean
}

// Única puerta para cambiar existencias: bloquea el producto, valida, actualiza y deja el movimiento con
// stock anterior y posterior, documento de origen, usuario y motivo.
export async function moveStock(tx: Tx, m: StockMove) {
  const { rows } = await tx.query('SELECT id, name, stock, reserved, kind FROM products WHERE id = $1 FOR UPDATE', [m.productId])
  const p = rows[0]
  if (!p) throw new HttpError(404, `Producto ${m.productId} inexistente`)
  if (p.kind === 'service') return null
  const after = Number(p.stock) + m.delta
  if (after < 0 && !m.allowNegative) throw new HttpError(409, `Stock insuficiente de "${p.name}" (físico ${p.stock})`)
  await tx.query('UPDATE products SET stock = $2, updated_at = now() WHERE id = $1', [m.productId, after])
  await tx.query(
    `INSERT INTO stock_movements (product_id, type, qty, unit_cost, ref_type, ref_id, reason, user_id, stock_before, stock_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [m.productId, m.type, m.delta, m.unitCost ?? null, m.refType ?? null, m.refId ?? null, m.reason ?? null, m.userId ?? null, p.stock, after])
  return { before: Number(p.stock), after }
}

export const stockDocLabel: Record<string, string> = {
  sale: 'Venta', purchase_order: 'Orden de compra', reception: 'Recepción', sale_return: 'Devolución de venta', supplier_return: 'Devolución a proveedor',
  inventory_count: 'Conteo físico', adjustment: 'Ajuste',
}
