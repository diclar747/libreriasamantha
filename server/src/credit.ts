import type { Db, Tx } from './db/client.js'

type Q = Db | Tx

export interface InstallmentPlan { count?: number; firstDueDays?: number; intervalDays?: number }

const addDays = (base: Date, days: number) => {
  const d = new Date(base.getTime() - 3 * 3600_000) // fecha local de Paraguay
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Parte la deuda de una venta a crédito en cuotas (la diferencia de redondeo va a la última).
export async function createInstallments(tx: Tx, o: { saleId: number; customerId: number; amount: number; plan?: InstallmentPlan; at?: Date }) {
  const count = Math.min(Math.max(o.plan?.count ?? 1, 1), 60)
  const first = o.plan?.firstDueDays ?? 30
  const every = o.plan?.intervalDays ?? 30
  const base = Math.floor(o.amount / count)
  const created: number[] = []
  for (let i = 0; i < count; i++) {
    const amount = i === count - 1 ? o.amount - base * (count - 1) : base
    if (amount <= 0) continue
    const { rows } = await tx.query(
      'INSERT INTO installments (sale_id, customer_id, number, due_date, amount) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [o.saleId, o.customerId, i + 1, addDays(o.at ?? new Date(), first + every * i), amount])
    created.push(rows[0].id)
  }
  return created
}

// Un cobro reduce primero las cuotas más antiguas; no se vuelve a contabilizar la venta.
export async function applyCustomerPayment(tx: Tx, customerId: number, paymentId: number, amount: number) {
  const { rows } = await tx.query(
    `SELECT id, amount - credited - paid AS open FROM installments
     WHERE customer_id = $1 AND status = 'open' AND amount - credited - paid > 0 ORDER BY due_date, id FOR UPDATE`, [customerId])
  let left = amount
  for (const r of rows) {
    if (left <= 0) break
    const x = Math.min(left, Number(r.open))
    await tx.query('UPDATE installments SET paid = paid + $2 WHERE id = $1', [r.id, x])
    await tx.query('INSERT INTO payment_applications (payment_id, installment_id, amount) VALUES ($1,$2,$3)', [paymentId, r.id, x])
    left -= x
  }
  return amount - left
}

// Una devolución (nota de crédito) reduce primero la deuda abierta de esa venta, de la última cuota hacia atrás.
export async function creditSaleDebt(tx: Tx, saleId: number, amount: number) {
  const { rows } = await tx.query(
    `SELECT id, amount - credited - paid AS open FROM installments
     WHERE sale_id = $1 AND status = 'open' AND amount - credited - paid > 0 ORDER BY due_date DESC, id DESC FOR UPDATE`, [saleId])
  let left = amount
  for (const r of rows) {
    if (left <= 0) break
    const x = Math.min(left, Number(r.open))
    await tx.query('UPDATE installments SET credited = credited + $2 WHERE id = $1', [r.id, x])
    left -= x
  }
  return amount - left
}

// Ventas a crédito anteriores a las cuotas: se les genera una cuota y se aplican los cobros ya hechos.
export async function ensureInstallments(db: Db) {
  const { rows } = await db.query(
    `SELECT s.id, s.customer_id, s.credit_amount, s.created_at FROM sales s
     WHERE s.credit_amount > 0 AND s.status = 'completed' AND s.customer_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM installments i WHERE i.sale_id = s.id) ORDER BY s.id`)
  if (!rows.length) return 0
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const customers = new Set<number>()
    for (const s of rows) {
      await createInstallments(client, { saleId: s.id, customerId: s.customer_id, amount: Number(s.credit_amount), at: new Date(s.created_at) })
      customers.add(s.customer_id)
    }
    for (const c of customers) {
      const { rows: pays } = await client.query(
        `SELECT p.id, p.amount - COALESCE((SELECT SUM(a.amount) FROM payment_applications a WHERE a.payment_id = p.id), 0) AS left
         FROM payments p WHERE p.customer_id = $1 AND p.kind = 'customer_payment' ORDER BY p.id`, [c])
      for (const p of pays) if (Number(p.left) > 0) await applyCustomerPayment(client, c, p.id, Number(p.left))
    }
    await client.query('COMMIT')
    return rows.length
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

// Antigüedad de la deuda a una fecha: no vencida, 1-30, 31-60, 61-90 y más de 90 días de atraso.
export const AGING_BUCKETS = ['Al día', '1-30 días', '31-60 días', '61-90 días', 'Más de 90 días'] as const
export const agingBucket = (daysLate: number) => (daysLate <= 0 ? 0 : daysLate <= 30 ? 1 : daysLate <= 60 ? 2 : daysLate <= 90 ? 3 : 4)
