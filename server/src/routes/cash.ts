import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ACC, post, reverse } from '../accounting.js'
import { anyPerm, can, requirePerm } from '../auth.js'
import { HttpError, withTx, type Db, type Tx } from '../db/client.js'
import { defaultAccount, sessionCash } from '../finance.js'
import { getSetting } from '../services.js'

const audit = (tx: Tx | Db, userId: number, action: string, id: number, detail: unknown) =>
  tx.query('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)', [userId, action, 'cash_session', id, JSON.stringify(detail)])

// Billetes y monedas del guaraní: { "100000": 3, "50000": 1, ... }
export const DENOMINATIONS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 100, 50]
const denomSchema = z.record(z.string(), z.number().int().min(0)).optional()
const denomTotal = (d?: Record<string, number>) => Object.entries(d ?? {}).reduce((a, [k, n]) => a + Number(k) * n, 0)
function checkDenominations(d: Record<string, number> | undefined, total: number, what: string) {
  if (!d || !Object.values(d).some((n) => n > 0)) return
  for (const k of Object.keys(d)) if (!DENOMINATIONS.includes(Number(k))) throw new HttpError(400, `Denominación inválida: ${k}`)
  if (denomTotal(d) !== total) throw new HttpError(400, `El detalle de billetes y monedas suma ${denomTotal(d)} y no coincide con ${what} (${total})`)
}

async function sessionReport(db: Db | Tx, id: number) {
  const c = await sessionCash(db, id)
  if (!c) throw new HttpError(404, 'Turno de caja no encontrado')
  const { rows: info } = await db.query(
    `SELECT cs.*, u.name AS user_name, cb.name AS closed_by_name, ab.name AS approved_by_name, da.name AS deposit_account_name
     FROM cash_sessions cs JOIN users u ON u.id = cs.user_id LEFT JOIN users cb ON cb.id = cs.closed_by LEFT JOIN users ab ON ab.id = cs.diff_approved_by
     LEFT JOIN money_accounts da ON da.id = cs.deposit_account_id WHERE cs.id = $1`, [id])
  const { rows: counts } = await db.query('SELECT k.*, u.name AS user_name FROM cash_counts k LEFT JOIN users u ON u.id = k.user_id WHERE session_id = $1 ORDER BY k.id', [id])
  const s = info[0]
  const closed = s.status === 'closed'
  const expected = closed ? Number(s.expected_cash) : c.expected
  const counted = closed ? Number(s.counted_cash) : null
  return {
    session: s, expected, counted, difference: counted === null ? null : counted - expected,
    opening: c.opening, cashIn: c.cashIn, cashOut: c.cashOut,
    byMethod: c.byMethod, movements: c.movements.map((m) => ({ at: m.at, kind: m.kind, concept: m.concept, amount: Number(m.amount), method: m.method, account_delta: m.account_delta === null ? null : Number(m.account_delta) })),
    refunds: c.refunds.map((m) => ({ at: m.at, concept: m.concept, amount: Number(m.amount), method: m.method })),
    deposit: Number(s.deposit_amount), reserve: Number(s.reserve_amount),
    pendingDeposit: closed ? Number(s.counted_cash) - Number(s.deposit_amount) - Number(s.reserve_amount) : null,
    counts,
  }
}

export function cashRoutes(app: FastifyInstance, db: Db) {
  app.get('/cash/denominations', async () => DENOMINATIONS)

  // Fondo de la próxima apertura: lo que quedó reservado en el último cierre.
  app.get('/cash/last-reserve', async (req) => {
    requirePerm(req, 'cash.manage')
    const { rows } = await db.query(`SELECT reserve_amount FROM cash_sessions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 1`)
    return { reserve: Number(rows[0]?.reserve_amount ?? 0) }
  })

  app.get('/cash/current', async (req) => {
    requirePerm(req, 'cash.manage')
    const { rows } = await db.query(`SELECT * FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [req.user!.id])
    if (!rows[0]) return { session: null }
    const r = await sessionReport(db, rows[0].id)
    return { ...r, expectedCash: r.expected, cashSales: r.byMethod.find((m) => m.method === 'cash')?.amount ?? 0 }
  })

  app.post('/cash/open', async (req, reply) => {
    requirePerm(req, 'cash.manage')
    const b = z.object({ openingFloat: z.number().int().min(0), shift: z.string().max(40).nullish(), note: z.string().max(300).nullish(), denominations: denomSchema, accountId: z.number().int().nullish() }).parse(req.body)
    checkDenominations(b.denominations, b.openingFloat, 'el fondo inicial')
    try {
      const { rows } = await db.query(
        'INSERT INTO cash_sessions (user_id, opening_float, shift, opening_note, opening_denominations, account_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [req.user!.id, b.openingFloat, b.shift, b.note, b.denominations ? JSON.stringify(b.denominations) : null, b.accountId ?? await defaultAccount(db, 'cash')])
      await audit(db, req.user!.id, 'cash.open', rows[0].id, { openingFloat: b.openingFloat, shift: b.shift })
      return reply.code(201).send(rows[0])
    } catch (e: any) {
      if (e.code === '23505') throw new HttpError(409, 'Ya tenés una caja abierta')
      throw e
    }
  })

  app.post('/cash/movements', async (req, reply) => {
    requirePerm(req, 'cash.manage')
    const b = z.object({ type: z.enum(['in', 'out']), amount: z.number().int().positive(), reason: z.string().min(3) }).parse(req.body)
    const { rows: s } = await db.query(`SELECT id FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [req.user!.id])
    if (!s[0]) throw new HttpError(409, 'No hay caja abierta')
    if (b.type === 'out') {
      requirePerm(req, 'cash.withdraw')
      const limit = Number((await getSetting(db, 'payments')).withdrawLimit ?? 0)
      if (limit > 0 && b.amount > limit && !can(req.user!.role, 'cash.withdraw.unlimited')) {
        throw new HttpError(403, `Los retiros de más de Gs. ${limit.toLocaleString('es-PY')} necesitan la autorización de un administrador`)
      }
      const c = await sessionCash(db, s[0].id)
      if (c && b.amount > c.expected) throw new HttpError(409, `No hay tanto efectivo en la caja (esperado ${c.expected})`)
    }
    const row = await withTx(db, async (tx) => {
      const { rows } = await tx.query('INSERT INTO cash_movements (session_id, type, amount, reason) VALUES ($1,$2,$3,$4) RETURNING *', [s[0].id, b.type, b.amount, b.reason])
      await post(tx, { description: `Caja: ${b.reason}`, refType: 'cash_movement', refId: rows[0].id, userId: req.user!.id,
        lines: b.type === 'out' ? [{ code: ACC.expenses, debit: b.amount }, { code: ACC.cash, credit: b.amount }] : [{ code: ACC.cash, debit: b.amount }, { code: ACC.otherIncome, credit: b.amount }] })
      await audit(tx, req.user!.id, `cash.${b.type}`, s[0].id, { amount: b.amount, reason: b.reason })
      return rows[0]
    })
    return reply.code(201).send(row)
  })

  // Arqueo parcial: cuenta el efectivo sin cerrar el turno.
  app.post('/cash/count', async (req) => {
    requirePerm(req, 'cash.manage')
    const b = z.object({ counted: z.number().int().min(0), denominations: denomSchema, note: z.string().max(300).nullish() }).parse(req.body)
    checkDenominations(b.denominations, b.counted, 'el efectivo contado')
    const { rows } = await db.query(`SELECT id FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [req.user!.id])
    if (!rows[0]) throw new HttpError(409, 'No hay caja abierta')
    const c = await sessionCash(db, rows[0].id)
    await db.query('INSERT INTO cash_counts (session_id, kind, expected, counted, denominations, note, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [rows[0].id, 'partial', c!.expected, b.counted, b.denominations ? JSON.stringify(b.denominations) : null, b.note, req.user!.id])
    return { expected: c!.expected, counted: b.counted, difference: b.counted - c!.expected }
  })

  app.post('/cash/close', async (req) => {
    requirePerm(req, 'cash.manage')
    const b = z.object({
      counted: z.number().int().min(0), denominations: denomSchema, note: z.string().max(500).nullish(),
      deposit: z.object({ amount: z.number().int().min(0), accountId: z.number().int().nullish() }).optional(), reserve: z.number().int().min(0).default(0),
    }).parse(req.body)
    checkDenominations(b.denominations, b.counted, 'el efectivo contado')
    const deposit = b.deposit?.amount ?? 0
    if (deposit + b.reserve > b.counted) throw new HttpError(400, 'El depósito más el fondo reservado superan el efectivo contado')
    const user = req.user!
    const id = await withTx(db, async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM cash_sessions WHERE user_id = $1 AND status = 'open' FOR UPDATE`, [user.id])
      const s = rows[0]
      if (!s) throw new HttpError(409, 'No hay caja abierta')
      const c = await sessionCash(tx, s.id)
      const expected = c!.expected
      const diff = b.counted - expected
      const approves = can(user.role, 'cash.approve_diff')
      const diffStatus = diff === 0 ? 'none' : approves ? 'approved' : 'pending_approval'
      let depositAccount: number | null = null
      if (deposit > 0) {
        depositAccount = b.deposit!.accountId ?? (await defaultAccount(tx, 'bank'))
        const { rows: seq } = await tx.query(`SELECT nextval('money_movement_seq') AS n`)
        const number = `M-${String(seq[0].n).padStart(6, '0')}`
        const cashAcct = s.account_id ?? (await defaultAccount(tx, 'cash'))
        const { rows: mm } = await tx.query(
          `INSERT INTO money_movements (number, kind, amount, account_id, to_account_id, concept, reference, session_id, user_id, approved_by)
           VALUES ($1,'transfer',$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
          [number, deposit, cashAcct, depositAccount, `Depósito del cierre de caja #${s.id}`, `close:${s.id}`, s.id, user.id])
        await post(tx, { description: `Depósito del cierre de caja #${s.id}`, refType: 'money_movement', refId: mm[0].id, userId: user.id, lines: [{ code: ACC.bank, debit: deposit }, { code: ACC.cash, credit: deposit }] })
      }
      await tx.query(
        `UPDATE cash_sessions SET status = 'closed', closed_at = now(), closed_by = $2, expected_cash = $3, counted_cash = $4, closing_denominations = $5, close_note = $6,
           deposit_amount = $7, deposit_account_id = $8, reserve_amount = $9, diff_status = $10, diff_note = $11, diff_approved_by = $12 WHERE id = $1`,
        [s.id, user.id, expected, b.counted, b.denominations ? JSON.stringify(b.denominations) : null, b.note, deposit, depositAccount, b.reserve, diffStatus, b.note, approves && diff !== 0 ? user.id : null])
      await tx.query('INSERT INTO cash_counts (session_id, kind, expected, counted, denominations, note, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [s.id, 'final', expected, b.counted, b.denominations ? JSON.stringify(b.denominations) : null, b.note, user.id])
      if (diff !== 0) {
        await post(tx, { description: `Diferencia de caja del turno #${s.id}`, refType: 'cash_close', refId: s.id, userId: user.id,
          lines: diff < 0 ? [{ code: ACC.cashShort, debit: -diff }, { code: ACC.cash, credit: -diff }] : [{ code: ACC.cash, debit: diff }, { code: ACC.cashOver, credit: diff }] })
      }
      await audit(tx, user.id, 'cash.close', s.id, { expected, counted: b.counted, diff, deposit, reserve: b.reserve })
      return s.id as number
    })
    const r = await sessionReport(db, id)
    return { id, expected: r.expected, counted: r.counted, difference: r.difference, byMethod: r.byMethod, report: r }
  })

  app.get('/cash/sessions', async (req) => {
    anyPerm(req, ['reports.view', 'cash.manage'])
    const q = req.query as Record<string, string | undefined>
    const own = !can(req.user!.role, 'reports.view')
    const { rows } = await db.query(
      `SELECT cs.*, u.name AS user_name, cs.counted_cash - cs.expected_cash AS difference
       FROM cash_sessions cs JOIN users u ON u.id = cs.user_id
       WHERE ($1::int IS NULL OR cs.user_id = $1) AND ($2::text IS NULL OR cs.status = $2) AND ($3::date IS NULL OR local_date(cs.opened_at) >= $3::date) AND ($4::date IS NULL OR local_date(cs.opened_at) <= $4::date)
         AND ($5::boolean IS NOT TRUE OR cs.user_id = $6)
       ORDER BY cs.id DESC LIMIT 200`,
      [q.userId ? Number(q.userId) : null, q.status ?? null, q.from ?? null, q.to ?? null, own, req.user!.id])
    return rows
  })

  // Comprobante del turno (abierto o cerrado), listo para imprimir.
  app.get('/cash/sessions/:id', async (req) => {
    anyPerm(req, ['reports.view', 'cash.manage'])
    const id = Number((req.params as any).id)
    const r = await sessionReport(db, id)
    if (!can(req.user!.role, 'reports.view') && r.session.user_id !== req.user!.id) throw new HttpError(403, 'Sin permiso')
    return r
  })

  app.post('/cash/sessions/:id/approve', async (req) => {
    requirePerm(req, 'cash.approve_diff')
    const id = Number((req.params as any).id)
    const { note } = z.object({ note: z.string().min(3) }).parse(req.body)
    const { rowCount } = await db.query(`UPDATE cash_sessions SET diff_status = 'approved', diff_approved_by = $2, diff_note = COALESCE(diff_note || ' | ', '') || $3 WHERE id = $1 AND diff_status = 'pending_approval'`, [id, req.user!.id, note])
    if (!rowCount) throw new HttpError(409, 'El turno no tiene una diferencia pendiente de aprobación')
    await audit(db, req.user!.id, 'cash.approve_diff', id, { note })
    return { diff_status: 'approved' }
  })

  // Una caja cerrada no se edita: solo se reabre con autorización y motivo, y queda registrado.
  app.post('/cash/sessions/:id/reopen', async (req) => {
    requirePerm(req, 'cash.reopen')
    const id = Number((req.params as any).id)
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM cash_sessions WHERE id = $1 FOR UPDATE`, [id])
      const s = rows[0]
      if (!s) throw new HttpError(404, 'Turno no encontrado')
      if (s.status !== 'closed') throw new HttpError(409, 'El turno no está cerrado')
      const { rows: other } = await tx.query(`SELECT id FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [s.user_id])
      if (other[0]) throw new HttpError(409, 'Esa persona ya tiene otra caja abierta')
      await reverse(tx, 'cash_close', id, `Reapertura de la caja #${id}: ${reason}`, req.user!.id)
      const { rows: deps } = await tx.query(`SELECT id, number FROM money_movements WHERE reference = $1 AND voided_at IS NULL`, [`close:${id}`])
      for (const d of deps) {
        await tx.query('UPDATE money_movements SET voided_at = now(), void_reason = $2 WHERE id = $1', [d.id, `Reapertura de la caja #${id}`])
        await reverse(tx, 'money_movement', d.id, `Anulación de ${d.number} por reapertura de la caja #${id}`, req.user!.id)
      }
      await tx.query(
        `UPDATE cash_sessions SET status = 'open', closed_at = NULL, closed_by = NULL, expected_cash = NULL, counted_cash = NULL, closing_denominations = NULL, close_note = NULL,
           deposit_amount = 0, deposit_account_id = NULL, reserve_amount = 0, diff_status = 'none', diff_note = NULL, diff_approved_by = NULL, reopen_count = reopen_count + 1 WHERE id = $1`, [id])
      await audit(tx, req.user!.id, 'cash.reopen', id, { reason })
      return { status: 'open', reopenCount: s.reopen_count + 1 }
    })
  })
}
