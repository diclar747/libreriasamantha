import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ACC, methodAccount, post } from '../accounting.js'
import { requirePerm } from '../auth.js'
import { HttpError, withTx, type Db } from '../db/client.js'
import { enqueue, getSetting } from '../services.js'

const body = z.object({
  customerId: z.number().int().nullish(),
  customerName: z.string().nullish(),
  phone: z.string().nullish(),
  description: z.string().min(3),
  copies: z.number().int().positive().default(1),
  pages: z.number().int().positive().default(1),
  color: z.boolean().default(false),
  paper: z.string().default('A4'),
  finishing: z.string().nullish(),
  fileName: z.string().nullish(),
  price: z.number().int().min(0).optional(), // si falta, se estima con la tarifa
  dueDate: z.string().nullish(),
  source: z.enum(['local', 'web', 'whatsapp']).default('local'),
})

const NEXT: Record<string, string[]> = {
  quote: ['approved', 'cancelled'],
  approved: ['in_progress', 'cancelled'],
  in_progress: ['ready', 'cancelled'],
  ready: ['delivered'],
  delivered: [],
  cancelled: [],
}

export async function estimatePrice(db: Db, o: { copies: number; pages: number; color: boolean; finishing?: string | null }) {
  const t = await getSetting(db, 'print')
  const sheets = o.copies * o.pages * (o.color ? t.color : t.bw)
  const fin = o.finishing ? (t.finishing?.[o.finishing.toLowerCase()] ?? 0) * o.copies : 0
  return sheets + fin
}

export async function createWorkOrder(db: Db, b: z.infer<typeof body>) {
  const price = b.price ?? (await estimatePrice(db, b))
  const { rows: seq } = await db.query(`SELECT nextval('work_order_seq') AS n`)
  const number = `OT-${String(seq[0].n).padStart(5, '0')}`
  const { rows } = await db.query(
    `INSERT INTO work_orders (number, customer_id, customer_name, phone, description, copies, pages, color, paper, finishing, file_name, price, due_date, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [number, b.customerId ?? null, b.customerName, b.phone, b.description, b.copies, b.pages, b.color, b.paper, b.finishing, b.fileName, price, b.dueDate, b.source])
  return rows[0]
}

export function workOrderRoutes(app: FastifyInstance, db: Db) {
  app.get('/workorders', async (req) => {
    requirePerm(req, 'workorders.write')
    const { status } = req.query as { status?: string }
    return (await db.query(`SELECT * FROM work_orders WHERE ($1::text IS NULL OR status = $1) ORDER BY id DESC LIMIT 200`, [status ?? null])).rows
  })
  app.post('/workorders/estimate', async (req) => {
    requirePerm(req, 'workorders.write')
    return { price: await estimatePrice(db, body.pick({ copies: true, pages: true, color: true, finishing: true }).parse(req.body)) }
  })
  app.post('/workorders', async (req, reply) => {
    requirePerm(req, 'workorders.write')
    return reply.code(201).send(await createWorkOrder(db, body.parse(req.body)))
  })

  app.post('/workorders/:id/status', async (req) => {
    requirePerm(req, 'workorders.write')
    const id = Number((req.params as any).id)
    const { status, price } = z.object({ status: z.enum(['approved', 'in_progress', 'ready', 'cancelled']), price: z.number().int().min(0).optional() }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id])
      const w = rows[0]
      if (!w) throw new HttpError(404, 'Orden no encontrada')
      if (!NEXT[w.status].includes(status)) throw new HttpError(409, `No se puede pasar de ${w.status} a ${status}`)
      if (price !== undefined) {
        if (w.status !== 'quote') throw new HttpError(409, 'El presupuesto solo se ajusta antes de aprobarlo')
        await tx.query('UPDATE work_orders SET price = $2 WHERE id = $1', [id, price])
      }
      await tx.query('UPDATE work_orders SET status = $2 WHERE id = $1', [id, status])
      if (status === 'ready' && w.phone) {
        await enqueue(tx, { phone: w.phone, dedupeKey: `wo-ready:${id}`, body: `Tu trabajo ${w.number} está listo para retirar en Librería Samantha.` })
      }
      if (status === 'cancelled' && w.deposit > 0) {
        // El anticipo cobrado debe devolverse: queda registrado como pasivo hasta resolverlo.
        await tx.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'workorder.cancel_with_deposit','work_order',$2,$3)`,
          [req.user!.id, id, JSON.stringify({ deposit: Number(w.deposit) })])
      }
      return { status }
    })
  })

  // Anticipo: se cobra al aprobar y queda como pasivo (anticipo de cliente) hasta la entrega.
  app.post('/workorders/:id/deposit', async (req) => {
    requirePerm(req, 'workorders.write')
    const id = Number((req.params as any).id)
    const b = z.object({ amount: z.number().int().positive(), method: z.string().min(1) }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id])
      const w = rows[0]
      if (!w) throw new HttpError(404, 'Orden no encontrada')
      if (['cancelled', 'delivered'].includes(w.status)) throw new HttpError(409, 'La orden está cerrada')
      if (Number(w.deposit) + b.amount > Number(w.price)) throw new HttpError(400, 'El anticipo supera el precio del trabajo')
      const { rows: s } = await tx.query(`SELECT id FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [req.user!.id])
      if (b.method === 'cash' && !s[0]) throw new HttpError(409, 'Abrí la caja para cobrar en efectivo')
      await tx.query(`INSERT INTO payments (kind, customer_id, session_id, method, amount) VALUES ('customer_payment',$1,$2,$3,$4)`,
        [w.customer_id, s[0]?.id ?? null, b.method, b.amount])
      await tx.query('UPDATE work_orders SET deposit = deposit + $2 WHERE id = $1', [id, b.amount])
      await post(tx, { description: `Anticipo ${w.number}`, refType: 'work_order_deposit', refId: id, userId: req.user!.id,
        lines: [{ code: methodAccount(b.method), debit: b.amount }, { code: ACC.advances, credit: b.amount }] })
      return { deposit: Number(w.deposit) + b.amount }
    })
  })
}
