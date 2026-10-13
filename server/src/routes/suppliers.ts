import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { anyPerm, can, requirePerm } from '../auth.js'
import { HttpError, withTx, type Db } from '../db/client.js'
import { audit, dstr, dueState, paySupplier, refreshSupplier, voidSupplierPayment } from '../purchasing.js'

const nul = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
const txt = (max = 200) => z.preprocess(nul, z.string().trim().max(max).nullish())
const email = z.preprocess(nul, z.string().trim().email('El correo no es válido').max(120).nullish())
const phone = z.preprocess(nul, z.string().trim().regex(/^[+\d][\d\s().-]{5,24}$/, 'El teléfono no es válido').nullish())

export const supplierBody = z.object({
  name: z.string().trim().min(2, 'El nombre comercial es obligatorio').max(160),
  legal_name: txt(200), ruc: z.preprocess(nul, z.string().trim().regex(/^[0-9A-Za-z.-]{3,20}$/, 'El RUC no es válido').nullish()),
  supplier_type: txt(60), address: txt(250), department: txt(80), city: txt(80), website: txt(160),
  contact_name: txt(120), contact_role: txt(80), contact_phone: phone, contact_email: email,
  phone, whatsapp: phone, email, terms: txt(300), notes: txt(1000),
  extra_contacts: z.array(z.object({ name: z.string().max(120), role: z.string().max(80).nullish(), phone: z.string().max(40).nullish(), email: z.string().max(120).nullish() })).max(10).default([]),
  payment_condition: z.enum(['cash', 'credit']).default('credit'),
  payment_days: z.number().int().min(0).max(365).default(30),
  bank_name: txt(100), bank_account: txt(60), bank_holder: txt(120), bank_alias: txt(60),
  active: z.boolean().default(true),
})
type SupplierBody = z.infer<typeof supplierBody>
const FIELDS = Object.keys(supplierBody.shape) as (keyof SupplierBody)[]

export function supplierRoutes(app: FastifyInstance, db: Db) {
  const view = (req: any) => anyPerm(req, ['purchases.view', 'purchases.write', 'suppliers.write', 'products.read'])

  app.get('/suppliers', async (req) => {
    view(req)
    const q = req.query as Record<string, string | undefined>
    const params: unknown[] = []
    const w: string[] = []
    const status = q.status ?? (q.all ? 'all' : 'active')
    if (status === 'active') w.push('s.active'); else if (status === 'inactive') w.push('NOT s.active')
    if (q.q) { params.push(`%${q.q}%`); w.push(`(s.name ILIKE $${params.length} OR s.legal_name ILIKE $${params.length} OR s.ruc ILIKE $${params.length} OR s.contact_name ILIKE $${params.length})`) }
    if (q.type) { params.push(q.type); w.push(`s.supplier_type = $${params.length}`) }
    if (q.debt === '1') w.push('s.balance > 0')
    const paged = q.page !== undefined
    const size = [15, 30, 50, 100].includes(Number(q.pageSize)) ? Number(q.pageSize) : 30
    const page = Math.max(1, Number(q.page) || 1)
    const where = w.length ? 'WHERE ' + w.join(' AND ') : ''
    const { rows } = await db.query(
      `SELECT s.*, COALESCE((SELECT SUM(amount - paid - credited) FROM payables WHERE supplier_id = s.id AND status = 'open' AND due_date < local_date(now())), 0) AS overdue,
         (SELECT MIN(due_date) FROM payables WHERE supplier_id = s.id AND status = 'open' AND amount - paid - credited > 0) AS next_due
       FROM suppliers s ${where} ORDER BY s.name ${paged ? `LIMIT ${size} OFFSET ${(page - 1) * size}` : 'LIMIT 500'}`, params)
    if (!paged) return rows
    const { rows: tot } = await db.query(`SELECT COUNT(*)::int AS n FROM suppliers s ${where}`, params)
    return { items: rows, total: tot[0].n, page, pageSize: size, pages: Math.max(1, Math.ceil(tot[0].n / size)) }
  })

  app.get('/suppliers/:id', async (req) => {
    anyPerm(req, ['purchases.view', 'purchases.write', 'suppliers.write'])
    const id = Number((req.params as any).id)
    const { rows } = await db.query('SELECT * FROM suppliers WHERE id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'Proveedor no encontrado')
    const costs = can(req.user!.role, 'costs.view')
    const [prods, orders, receptions, invoices, payments, returns, notes, payables] = await Promise.all([
      db.query(`SELECT p.id, p.code, p.name, ps.supplier_code, ps.preferred, ${costs ? 'ps.last_cost,' : ''} p.stock FROM product_suppliers ps JOIN products p ON p.id = ps.product_id WHERE ps.supplier_id = $1 ORDER BY p.name`, [id]),
      db.query(`SELECT id, number, status, order_date, expected_date, total FROM purchase_orders WHERE supplier_id = $1 ORDER BY id DESC LIMIT 50`, [id]),
      db.query(`SELECT id, number, received_at, delivery_note, status FROM receptions WHERE supplier_id = $1 ORDER BY id DESC LIMIT 50`, [id]),
      db.query(`SELECT id, number, doc_type, doc_number, doc_date, total, paid, credited, status FROM purchase_invoices WHERE supplier_id = $1 ORDER BY doc_date DESC, id DESC LIMIT 100`, [id]),
      db.query(`SELECT id, at, amount, method, reference, voided, credit_applied, advance_amount FROM supplier_payments WHERE supplier_id = $1 ORDER BY id DESC LIMIT 100`, [id]),
      db.query(`SELECT id, number, created_at, total, credit_status, reason FROM supplier_returns WHERE supplier_id = $1 ORDER BY id DESC LIMIT 50`, [id]),
      db.query(`SELECT id, number, doc_number, doc_date, amount, resolution, status FROM supplier_credit_notes WHERE supplier_id = $1 ORDER BY id DESC LIMIT 50`, [id]),
      db.query(`SELECT pb.id, pb.invoice_id, i.doc_number, pb.number, pb.due_date, pb.amount, pb.paid, pb.credited, (pb.amount - pb.paid - pb.credited) AS pending FROM payables pb JOIN purchase_invoices i ON i.id = pb.invoice_id
                WHERE pb.supplier_id = $1 AND pb.status = 'open' AND pb.amount - pb.paid - pb.credited > 0 ORDER BY pb.due_date`, [id]),
    ])
    const open = payables.rows.map((p) => ({ ...p, state: dueState(p.due_date, Number(p.pending)) }))
    return { ...rows[0], products: prods.rows, orders: orders.rows, receptions: receptions.rows, invoices: invoices.rows, payments: payments.rows, returns: returns.rows, credit_notes: notes.rows, payables: open,
      totals: { owed: open.reduce((a, p) => a + Number(p.pending), 0), overdue: open.filter((p) => p.state === 'overdue').reduce((a, p) => a + Number(p.pending), 0), credit_balance: Number(rows[0].credit_balance), next_due: open[0] ? dstr(open[0].due_date) : null } }
  })

  const save = async (req: any, id: number | null) => {
    requirePerm(req, 'suppliers.write')
    const b = supplierBody.parse(id ? { ...(await db.query('SELECT * FROM suppliers WHERE id = $1', [id])).rows[0], ...req.body } : req.body)
    try {
      if (!id) {
        const { rows } = await db.query(`INSERT INTO suppliers (${FIELDS.join(',')}) VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, FIELDS.map((f) => (f === 'extra_contacts' ? JSON.stringify(b[f]) : b[f] ?? null)))
        return rows[0]
      }
      const { rows } = await db.query(`UPDATE suppliers SET ${FIELDS.map((f, i) => `${f} = $${i + 2}`).join(',')} WHERE id = $1 RETURNING *`, [id, ...FIELDS.map((f) => (f === 'extra_contacts' ? JSON.stringify(b[f]) : b[f] ?? null))])
      if (!rows[0]) throw new HttpError(404, 'Proveedor no encontrado')
      return rows[0]
    } catch (e: any) {
      if (e.code === '23505') throw new HttpError(409, 'Ya existe un proveedor con ese RUC')
      throw e
    }
  }
  app.post('/suppliers', async (req, reply) => reply.code(201).send(await save(req, null)))
  app.put('/suppliers/:id', async (req) => save(req, Number((req.params as any).id)))
  app.delete('/suppliers/:id', async (req) => {
    requirePerm(req, 'suppliers.write')
    const id = Number((req.params as any).id)
    const { rows } = await db.query(
      `SELECT (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = $1) + (SELECT COUNT(*) FROM purchase_invoices WHERE supplier_id = $1) + (SELECT COUNT(*) FROM supplier_payments WHERE supplier_id = $1)
        + (SELECT COUNT(*) FROM receptions WHERE supplier_id = $1) AS n`, [id])
    if (Number(rows[0].n) > 0) {
      await db.query('UPDATE suppliers SET active = false WHERE id = $1', [id])
      return { deleted: false, deactivated: true, message: 'El proveedor tiene movimientos, así que se desactivó en lugar de eliminarse.' }
    }
    await db.query('DELETE FROM product_suppliers WHERE supplier_id = $1', [id])
    await db.query('DELETE FROM suppliers WHERE id = $1', [id])
    return { deleted: true, deactivated: false }
  })

  // Estado de cuenta: facturas, notas de crédito y pagos con saldo acumulado.
  app.get('/suppliers/:id/statement', async (req) => {
    anyPerm(req, ['purchases.view', 'purchases.write'])
    const id = Number((req.params as any).id)
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT i.doc_date AS date, i.id AS ref_id, 'invoice' AS type, ('Factura ' || i.doc_number) AS concept, i.total AS debit, 0::bigint AS credit, i.id AS ord FROM purchase_invoices i WHERE i.supplier_id = $1 AND i.status <> 'void'
         UNION ALL SELECT n.doc_date, n.id, 'credit_note', 'Nota de crédito ' || n.doc_number, 0, n.amount, n.id FROM supplier_credit_notes n WHERE n.supplier_id = $1 AND n.status <> 'void' AND n.resolution <> 'refund'
         UNION ALL SELECT local_date(sp.at), sp.id, 'payment', 'Pago ' || sp.method || COALESCE(' ' || sp.reference, ''), 0, sp.amount + sp.credit_applied - sp.advance_amount, sp.id FROM supplier_payments sp WHERE sp.supplier_id = $1 AND NOT sp.voided AND sp.amount + sp.credit_applied - sp.advance_amount > 0
       ) x ORDER BY date, type, ord`, [id])
    let bal = 0
    const lines = rows.map((r) => { bal += Number(r.debit) - Number(r.credit); return { ...r, date: dstr(r.date), debit: Number(r.debit), credit: Number(r.credit), balance: bal } })
    return { lines, balance: bal }
  })

  // ------------------------------------------------------------ Cuentas por pagar
  app.get('/payables', async (req) => {
    anyPerm(req, ['purchases.view', 'purchases.write', 'suppliers.pay'])
    const q = req.query as Record<string, string | undefined>
    const params: unknown[] = []
    const w = [`pb.status = 'open'`]
    if (q.supplierId) { params.push(Number(q.supplierId)); w.push(`pb.supplier_id = $${params.length}`) }
    if (q.from) { params.push(q.from); w.push(`pb.due_date >= $${params.length}::date`) }
    if (q.to) { params.push(q.to); w.push(`pb.due_date <= $${params.length}::date`) }
    if (q.q) { params.push(`%${q.q}%`); w.push(`(i.doc_number ILIKE $${params.length} OR s.name ILIKE $${params.length})`) }
    if (q.status !== 'paid') w.push('pb.amount - pb.paid - pb.credited > 0')
    const { rows } = await db.query(
      `SELECT pb.id, pb.invoice_id, pb.supplier_id, s.name AS supplier, i.doc_number, i.number AS invoice_number, pb.number AS installment, pb.due_date, pb.amount, pb.paid, pb.credited,
         (pb.amount - pb.paid - pb.credited) AS pending, (local_date(now()) - pb.due_date) AS days_late
       FROM payables pb JOIN purchase_invoices i ON i.id = pb.invoice_id JOIN suppliers s ON s.id = pb.supplier_id WHERE ${w.join(' AND ')} ORDER BY pb.due_date, pb.id LIMIT 1000`, params)
    let items = rows.map((r) => ({ ...r, due_date: dstr(r.due_date), state: dueState(r.due_date, Number(r.pending)) }))
    if (q.status === 'overdue') items = items.filter((r) => r.state === 'overdue')
    if (q.status === 'due_soon') items = items.filter((r) => r.state === 'due_soon')
    const sum = (f: (r: any) => boolean) => items.filter(f).reduce((a, r) => a + Number(r.pending), 0)
    return { items, totals: { pending: sum(() => true), overdue: sum((r) => r.state === 'overdue'), due_soon: sum((r) => r.state === 'due_soon'), current: sum((r) => r.state === 'current') } }
  })

  // Pago a proveedor: aplica a facturas/cuotas (a elección o de la más vieja a la más nueva), con saldo a favor o anticipo.
  const payBody = z.object({
    amount: z.number().int().min(0), method: z.enum(['cash', 'transfer', 'card', 'check']).default('transfer'), note: z.string().nullish(), orderId: z.number().int().nullish(),
    accountId: z.number().int().nullish(), reference: z.string().nullish(), paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    allocations: z.array(z.object({ payableId: z.number().int(), amount: z.number().int().positive() })).optional(), useCredit: z.number().int().min(0).optional(), advance: z.boolean().optional(),
  })
  app.post('/suppliers/:id/payments', async (req, reply) => {
    anyPerm(req, ['purchases.write', 'suppliers.pay'])
    const id = Number((req.params as any).id)
    const b = payBody.parse(req.body)
    const r = await withTx(db, (tx) => paySupplier(tx, req.user!, id, b))
    return reply.code(201).send({ ok: true, paymentId: r.id, ...r })
  })
  app.get('/supplier-payments', async (req) => {
    anyPerm(req, ['purchases.view', 'purchases.write', 'suppliers.pay'])
    const q = req.query as Record<string, string | undefined>
    const params: unknown[] = []
    const w: string[] = []
    if (q.supplierId) { params.push(Number(q.supplierId)); w.push(`sp.supplier_id = $${params.length}`) }
    if (q.from) { params.push(q.from); w.push(`local_date(sp.at) >= $${params.length}::date`) }
    if (q.to) { params.push(q.to); w.push(`local_date(sp.at) <= $${params.length}::date`) }
    const { rows } = await db.query(
      `SELECT sp.*, s.name AS supplier, u.name AS user_name, COALESCE((SELECT string_agg(i.doc_number, ', ') FROM supplier_payment_allocations a JOIN payables pb ON pb.id = a.payable_id JOIN purchase_invoices i ON i.id = pb.invoice_id WHERE a.payment_id = sp.id), '') AS invoices
       FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id LEFT JOIN users u ON u.id = sp.user_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY sp.id DESC LIMIT 500`, params)
    return rows
  })
  app.post('/supplier-payments/:id/void', async (req) => {
    requirePerm(req, 'suppliers.pay')
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Indicá el motivo') }).parse(req.body)
    await withTx(db, (tx) => voidSupplierPayment(tx, req.user!.id, Number((req.params as any).id), reason))
    return { ok: true }
  })
  app.post('/suppliers/:id/recalc', async (req) => {
    requirePerm(req, 'suppliers.pay')
    return { balance: await withTx(db, async (tx) => { const b = await refreshSupplier(tx, Number((req.params as any).id)); await audit(tx, req.user!.id, 'supplier.recalc', 'supplier', Number((req.params as any).id)); return b }) }
  })
}
