import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePerm } from '../auth.js'
import { HttpError, withTx, type Db } from '../db/client.js'
import { ACC, methodAccount, post } from '../accounting.js'
import { applyCustomerPayment } from '../credit.js'
import { METHOD_LABEL } from '../finance.js'
import { insertPayment, normalizePayment } from './sales.js'

const paymentMethodLabel = (m: string) => METHOD_LABEL[m] ?? m

const customer = z.object({
  name: z.string().min(1),
  ruc: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  address: z.string().nullish(),
  credit_limit: z.number().int().min(0).default(0),
})

export function financeRoutes(app: FastifyInstance, db: Db) {
  // ---- Clientes y crédito
  app.get('/customers', async (req) => {
    requirePerm(req, 'customers.read')
    const { q } = req.query as { q?: string }
    const { rows } = await db.query(
      `SELECT * FROM customers WHERE active AND ($1::text IS NULL OR name ILIKE $1 OR ruc ILIKE $1 OR phone ILIKE $1)
       ORDER BY name LIMIT 100`, [q ? `%${q}%` : null])
    return rows
  })
  app.post('/customers', async (req, reply) => {
    requirePerm(req, 'customers.write')
    const b = customer.parse(req.body)
    const { rows } = await db.query(
      'INSERT INTO customers (name, ruc, phone, email, address, credit_limit) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [b.name, b.ruc, b.phone, b.email, b.address, b.credit_limit])
    return reply.code(201).send(rows[0])
  })
  app.put('/customers/:id', async (req) => {
    requirePerm(req, 'customers.write')
    const b = customer.partial().parse(req.body)
    // El límite de crédito es una decisión administrativa
    if (b.credit_limit !== undefined) requirePerm(req, 'credit.grant')
    const keys = Object.keys(b) as (keyof typeof b)[]
    if (!keys.length) throw new HttpError(400, 'Nada para actualizar')
    const { rows } = await db.query(
      `UPDATE customers SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [Number((req.params as any).id), ...keys.map((k) => b[k] ?? null)])
    if (!rows[0]) throw new HttpError(404, 'Cliente no encontrado')
    return rows[0]
  })
  app.get('/customers/:id/statement', async (req) => {
    requirePerm(req, 'customers.read')
    const id = Number((req.params as any).id)
    const { rows } = await db.query('SELECT * FROM customers WHERE id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'Cliente no encontrado')
    const { rows: ledger } = await db.query('SELECT * FROM customer_ledger WHERE customer_id = $1 ORDER BY id DESC LIMIT 200', [id])
    const { rows: installments } = await db.query(
      `SELECT i.*, s.number AS sale_number, s.total AS sale_total, s.created_at AS sale_date, (i.amount - i.credited - i.paid) AS pending,
         GREATEST(current_date - i.due_date, 0)::int AS days_late,
         (i.status = 'open' AND i.amount - i.credited - i.paid > 0 AND i.due_date < current_date) AS overdue
       FROM installments i LEFT JOIN sales s ON s.id = i.sale_id WHERE i.customer_id = $1 AND i.status = 'open' ORDER BY i.due_date, i.id`, [id])
    const { rows: payments } = await db.query(
      `SELECT p.id, p.at, p.method, p.amount, p.reference, p.details FROM payments p WHERE p.customer_id = $1 AND p.kind = 'customer_payment' ORDER BY p.id DESC LIMIT 100`, [id])
    const { rows: sales } = await db.query(
      `SELECT s.id, s.number, s.created_at, s.total, s.credit_amount, s.paid, s.status FROM sales s WHERE s.customer_id = $1 AND s.credit_amount > 0 ORDER BY s.id DESC LIMIT 50`, [id])
    const overdue = installments.filter((i) => i.overdue).reduce((a, i) => a + Number(i.pending), 0)
    return { customer: rows[0], ledger, installments, payments, sales, overdue }
  })
  // Cobranza: reduce la deuda (cuotas más antiguas primero) y entra a caja o cuenta, sin volver a contabilizar la venta.
  app.post('/customers/:id/payments', async (req, reply) => {
    requirePerm(req, 'customers.collect')
    const id = Number((req.params as any).id)
    const b = z.object({
      amount: z.number().int().positive(),
      method: z.enum(['cash', 'card', 'qr', 'transfer', 'check']),
      details: z.record(z.string(), z.any()).default({}), reference: z.string().nullish(),
    }).parse(req.body)
    const out = await withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [id])
      if (!rows[0]) throw new HttpError(404, 'Cliente no encontrado')
      if (b.amount > Number(rows[0].balance)) throw new HttpError(400, 'El pago supera la deuda')
      const { rows: ses } = await tx.query(`SELECT id, account_id FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [req.user!.id])
      if (b.method === 'cash' && !ses[0]) throw new HttpError(409, 'Abrí la caja para cobrar en efectivo')
      const p = normalizePayment({ method: b.method, amount: b.amount, details: b.details, reference: b.reference })
      const paymentId = await insertPayment(tx, { kind: 'customer_payment', customerId: id, sessionId: ses[0]?.id ?? null, sessionAccountId: ses[0]?.account_id, userId: req.user!.id, ...p })
      const applied = await applyCustomerPayment(tx, id, paymentId, b.amount)
      await tx.query('UPDATE customers SET balance = balance - $2 WHERE id = $1', [id, b.amount])
      await tx.query(`INSERT INTO customer_ledger (customer_id, type, amount, note) VALUES ($1,'payment',$2,$3)`, [id, -b.amount, `Pago (${paymentMethodLabel(b.method)})`])
      await post(tx, { description: `Cobranza cliente #${id}`, refType: 'customer_payment', refId: id, userId: req.user!.id,
        lines: [{ code: methodAccount(b.method), debit: b.amount }, { code: ACC.receivable, credit: b.amount }] })
      return { balance: Number(rows[0].balance) - b.amount, appliedToInstallments: applied, paymentId }
    })
    return reply.code(201).send(out)
  })

  // ---- Panel
  app.get('/reports/summary', async (req) => {
    requirePerm(req, 'reports.view')
    const today = `s.status = 'completed' AND s.created_at >= date_trunc('day', now())`
    const [sales, methods, margin, ar, inv, low, top, daily, pending, channels, ap] = await Promise.all([
      db.query(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM sales s WHERE ${today}`),
      db.query(`SELECT method, SUM(amount) AS amount FROM payments WHERE at >= date_trunc('day', now()) GROUP BY method ORDER BY 2 DESC`),
      db.query(`SELECT COALESCE(SUM(si.total - si.qty * si.unit_cost),0) AS margin FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE ${today}`),
      db.query(`SELECT COALESCE(SUM(balance),0) AS total, COUNT(*) FILTER (WHERE balance > 0) AS debtors FROM customers`),
      db.query(`SELECT COALESCE(SUM(stock * cost),0) AS value FROM products WHERE kind = 'product' AND active`),
      db.query(`SELECT id, code, name, stock, reserved, min_stock FROM products WHERE active AND kind = 'product' AND stock - reserved <= min_stock ORDER BY stock LIMIT 20`),
      db.query(`SELECT si.name, SUM(si.qty) AS qty, SUM(si.total) AS total FROM sale_items si JOIN sales s ON s.id = si.sale_id
                WHERE s.status = 'completed' AND s.created_at >= now() - interval '30 days' GROUP BY si.name ORDER BY 3 DESC LIMIT 10`),
      db.query(`SELECT d::date AS day, COUNT(s.id)::int AS count, COALESCE(SUM(s.total),0) AS total
                FROM generate_series(current_date - 13, current_date, interval '1 day') d
                LEFT JOIN sales s ON s.created_at::date = d::date AND s.status = 'completed' GROUP BY d ORDER BY d`),
      db.query(`SELECT
          (SELECT COUNT(*) FROM orders WHERE payment_status = 'approved' AND status = 'confirmed' AND delivery_status IN ('pending','preparing'))::int AS orders_to_prepare,
          (SELECT COUNT(*) FROM orders WHERE exception IS NOT NULL)::int AS order_exceptions,
          (SELECT COUNT(*) FROM invoices WHERE status <> 'approved')::int AS invoices_pending,
          (SELECT COUNT(*) FROM replenishments WHERE status = 'open')::int AS replenishments,
          (SELECT COUNT(*) FROM work_orders WHERE status IN ('quote','approved','in_progress','ready'))::int AS work_orders,
          (SELECT COUNT(*) FROM outbox WHERE status <> 'sent')::int AS messages_pending`),
      db.query(`SELECT channel, COALESCE(SUM(total),0) AS total FROM sales WHERE status = 'completed' AND created_at >= now() - interval '30 days' GROUP BY channel ORDER BY 2 DESC`),
      db.query(`SELECT COALESCE(SUM(balance),0) AS total FROM suppliers`),
    ])
    return {
      daily: daily.rows.map((r) => ({ day: r.day, count: r.count, total: Number(r.total) })),
      pending: pending.rows[0],
      channels: channels.rows.map((r) => ({ channel: r.channel, total: Number(r.total) })),
      payables: Number(ap.rows[0].total),
      today: { count: Number(sales.rows[0].count), total: Number(sales.rows[0].total), margin: Number(margin.rows[0].margin), byMethod: methods.rows },
      receivables: { total: Number(ar.rows[0].total), debtors: Number(ar.rows[0].debtors) },
      inventoryValue: Number(inv.rows[0].value),
      lowStock: low.rows,
      topProducts: top.rows,
    }
  })
}
