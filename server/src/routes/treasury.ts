import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ACC, methodAccount, post, reverse } from '../accounting.js'
import { anyPerm, can, requirePerm } from '../auth.js'
import { HttpError, withTx, type Db, type Tx } from '../db/client.js'
import { accountBalances, defaultAccount, KIND_LABEL, MOVEMENTS_SQL, movementsWhere, type MovementFilters } from '../finance.js'

const audit = (tx: Tx | Db, userId: number, action: string, entity: string, id: number, detail: unknown) =>
  tx.query('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)', [userId, action, entity, id, JSON.stringify(detail)])

const bankExtra = { holder: z.string().max(120).nullish(), holderDocument: z.string().max(40).nullish(), accountType: z.string().max(40).nullish(), alias: z.string().max(60).nullish(), instructions: z.string().max(400).nullish(), onlineEnabled: z.boolean().optional() }
const ledgerOf = (kind: string) => (kind === 'cash' ? ACC.cash : ACC.bank)
const localToday = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)

async function openSession(tx: Tx | Db, userId: number) {
  const { rows } = await tx.query(`SELECT * FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [userId])
  return rows[0] as { id: number; account_id: number | null } | undefined
}

// ---------------------------------------------------------------- Gastos
async function categoryAccount(q: Tx | Db, categoryId: number) {
  const { rows } = await q.query(
    `SELECT c.name, c.active, COALESCE(c.account_code, p.account_code) AS code FROM expense_categories c
     LEFT JOIN expense_categories p ON p.id = c.parent_id WHERE c.id = $1`, [categoryId])
  if (!rows[0]) throw new HttpError(404, 'Categoría de gasto inexistente')
  if (!rows[0].active) throw new HttpError(409, 'La categoría está desactivada')
  return rows[0].code as string
}

const expenseBody = z.object({
  categoryId: z.number().int(),
  concept: z.string().min(3).max(160),
  beneficiary: z.string().max(120).nullish(),
  supplierId: z.number().int().nullish(),
  amount: z.number().int().positive(),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  documentNumber: z.string().max(60).nullish(),
  notes: z.string().max(500).nullish(),
  payNow: z.object({ method: z.enum(['cash', 'transfer', 'card', 'check']), accountId: z.number().int().nullish(), reference: z.string().nullish() }).optional(),
})

export async function createExpense(tx: Tx, userId: number, b: z.infer<typeof expenseBody>, extra: { recurringId?: number; skipAccounting?: boolean } = {}) {
  const code = await categoryAccount(tx, b.categoryId)
  const date = b.expenseDate ?? localToday()
  const { rows: seq } = await tx.query(`SELECT nextval('expense_seq') AS n`)
  const number = `G-${String(seq[0].n).padStart(6, '0')}`
  const { rows } = await tx.query(
    `INSERT INTO expenses (number, category_id, concept, beneficiary, supplier_id, amount, expense_date, due_date, document_number, notes, recurring_id, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [number, b.categoryId, b.concept, b.beneficiary ?? null, b.supplierId ?? null, b.amount, date, b.dueDate ?? null, b.documentNumber ?? null, b.notes ?? null, extra.recurringId ?? null, userId])
  if (!extra.skipAccounting) {
    await post(tx, { description: `Gasto ${number}: ${b.concept}`, refType: 'expense', refId: rows[0].id, userId, date,
      lines: [{ code, debit: b.amount }, { code: ACC.accrued, credit: b.amount }] })
  }
  await audit(tx, userId, 'expense.create', 'expense', rows[0].id, { number, amount: b.amount })
  return rows[0]
}

export async function payExpense(tx: Tx, user: { id: number }, expenseId: number, p: { amount?: number; method: string; accountId?: number | null; reference?: string | null; notes?: string | null }) {
  const { rows } = await tx.query('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [expenseId])
  const e = rows[0]
  if (!e) throw new HttpError(404, 'Gasto no encontrado')
  if (e.status === 'void') throw new HttpError(409, 'El gasto está anulado')
  const remaining = Number(e.amount) - Number(e.paid_amount)
  if (remaining <= 0) throw new HttpError(409, 'El gasto ya está pagado')
  const amount = p.amount ?? remaining
  if (amount <= 0 || amount > remaining) throw new HttpError(400, `El pago no puede superar el saldo del gasto (${remaining})`)
  let sessionId: number | null = null
  let accountId = p.accountId ?? null
  if (p.method === 'cash') {
    const s = await openSession(tx, user.id)
    if (!s) throw new HttpError(409, 'Abrí la caja para pagar en efectivo')
    sessionId = s.id
    accountId = s.account_id ?? (await defaultAccount(tx, 'cash'))
  } else accountId = accountId ?? (await defaultAccount(tx, 'bank'))
  const { rows: ep } = await tx.query(
    `INSERT INTO expense_payments (expense_id, amount, method, account_id, session_id, reference, notes, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [expenseId, amount, p.method, accountId, sessionId, p.reference ?? null, p.notes ?? null, user.id])
  const paid = Number(e.paid_amount) + amount
  await tx.query(`UPDATE expenses SET paid_amount = $2, status = $3 WHERE id = $1`, [expenseId, paid, paid >= Number(e.amount) ? 'paid' : 'partial'])
  await post(tx, { description: `Pago del gasto ${e.number}`, refType: 'expense_payment', refId: ep[0].id, userId: user.id,
    lines: [{ code: ACC.accrued, debit: amount }, { code: p.method === 'cash' ? ACC.cash : ACC.bank, credit: amount }] })
  await audit(tx, user.id, 'expense.pay', 'expense', expenseId, { amount, method: p.method })
  return { paymentId: ep[0].id as number, paid, status: paid >= Number(e.amount) ? 'paid' : 'partial' }
}

const nextDate = (d: string, f: string) => {
  const x = new Date(d + 'T00:00:00Z')
  if (f === 'weekly') x.setUTCDate(x.getUTCDate() + 7)
  else if (f === 'yearly') x.setUTCFullYear(x.getUTCFullYear() + 1)
  else x.setUTCMonth(x.getUTCMonth() + 1)
  return x.toISOString().slice(0, 10)
}

// Genera como obligaciones pendientes los gastos recurrentes vencidos (hasta 12 ocurrencias atrasadas por plantilla).
export async function runRecurringExpenses(db: Db, userId?: number) {
  const { rows } = await db.query(`SELECT * FROM recurring_expenses WHERE active AND next_date <= $1 ORDER BY id`, [localToday()])
  let created = 0
  for (const r of rows) {
    await withTx(db, async (tx) => {
      let d = r.next_date instanceof Date ? r.next_date.toISOString().slice(0, 10) : String(r.next_date).slice(0, 10)
      for (let i = 0; i < 12 && d <= localToday(); i++) {
        await createExpense(tx, userId ?? r.user_id, { categoryId: r.category_id, concept: r.concept, beneficiary: r.beneficiary, amount: Number(r.amount), expenseDate: d, dueDate: d } as any, { recurringId: r.id })
        created++
        d = nextDate(d, r.frequency)
      }
      await tx.query('UPDATE recurring_expenses SET next_date = $2 WHERE id = $1', [r.id, d])
    })
  }
  return created
}

// ---------------------------------------------------------------- Liquidaciones de tarjetas/QR y depósito de cheques
const CLEARING: Record<string, string> = { card: ACC.cards, online: ACC.cards, qr: ACC.qr, check: ACC.checks }

export function treasuryRoutes(app: FastifyInstance, db: Db) {
  // ---- Cajas y cuentas bancarias
  app.get('/money-accounts', async (req) => {
    anyPerm(req, ['reports.view', 'cash.manage', 'expenses.write', 'payments.settle', 'purchases.write'])
    return accountBalances(db, (req.query as any).asOf)
  })
  app.post('/money-accounts', async (req, reply) => {
    requirePerm(req, 'movements.write')
    const b = z.object({ kind: z.enum(['cash', 'bank']), name: z.string().min(2), bankName: z.string().nullish(), accountNumber: z.string().nullish(), openingBalance: z.number().int().default(0), ...bankExtra }).parse(req.body)
    try {
      const { rows } = await db.query('INSERT INTO money_accounts (kind, name, bank_name, account_number, opening_balance, holder, holder_document, account_type, alias, instructions, online_enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [b.kind, b.name, b.bankName, b.accountNumber, b.openingBalance, b.holder ?? null, b.holderDocument ?? null, b.accountType ?? null, b.alias ?? null, b.instructions ?? null, b.kind === 'bank' && !!b.onlineEnabled])
      if (b.openingBalance !== 0) {
        await withTx(db, (tx) => post(tx, { description: `Saldo inicial de ${b.name}`, refType: 'opening_balance', refId: rows[0].id, userId: req.user!.id,
          lines: b.openingBalance > 0 ? [{ code: ledgerOf(b.kind), debit: b.openingBalance }, { code: ACC.capital, credit: b.openingBalance }] : [{ code: ACC.capital, debit: -b.openingBalance }, { code: ledgerOf(b.kind), credit: -b.openingBalance }] }))
      }
      return reply.code(201).send(rows[0])
    } catch (e: any) { if (e.code === '23505') throw new HttpError(409, 'Ya existe una cuenta con ese nombre'); throw e }
  })
  app.put('/money-accounts/:id', async (req) => {
    requirePerm(req, 'movements.write')
    const b = z.object({ name: z.string().min(2).optional(), bankName: z.string().nullish(), accountNumber: z.string().nullish(), active: z.boolean().optional(), ...bankExtra }).parse(req.body)
    const { rows } = await db.query(
      `UPDATE money_accounts SET name = COALESCE($2, name), bank_name = COALESCE($3, bank_name), account_number = COALESCE($4, account_number), active = COALESCE($5, active),
         holder = COALESCE($6, holder), holder_document = COALESCE($7, holder_document), account_type = COALESCE($8, account_type), alias = COALESCE($9, alias), instructions = COALESCE($10, instructions), online_enabled = COALESCE($11, online_enabled) WHERE id = $1 RETURNING *`,
      [Number((req.params as any).id), b.name ?? null, b.bankName ?? null, b.accountNumber ?? null, b.active ?? null, b.holder ?? null, b.holderDocument ?? null, b.accountType ?? null, b.alias ?? null, b.instructions ?? null, b.onlineEnabled ?? null])
    if (!rows[0]) throw new HttpError(404, 'Cuenta inexistente')
    return rows[0]
  })

  // ---- Categorías de gasto (configurables)
  app.get('/expense-categories', async (req) => {
    anyPerm(req, ['expenses.write', 'reports.view'])
    const { rows } = await db.query(
      `SELECT c.*, COALESCE(c.account_code, p.account_code) AS ledger_code,
         (SELECT COUNT(*) FROM expenses e WHERE e.category_id = c.id)::int AS uses
       FROM expense_categories c LEFT JOIN expense_categories p ON p.id = c.parent_id ORDER BY COALESCE(p.sort, c.sort), COALESCE(c.parent_id, 0), c.sort, c.name`)
    return rows
  })
  app.post('/expense-categories', async (req, reply) => {
    requirePerm(req, 'expenses.write')
    const b = z.object({ name: z.string().min(2).max(80), parentId: z.number().int().nullish() }).parse(req.body)
    return reply.code(201).send(await withTx(db, async (tx) => {
      let code: string | null = null
      if (b.parentId) {
        const { rows } = await tx.query('SELECT parent_id FROM expense_categories WHERE id = $1', [b.parentId])
        if (!rows[0]) throw new HttpError(404, 'La categoría padre no existe')
        if (rows[0].parent_id) throw new HttpError(400, 'Solo se admiten dos niveles: categoría y subcategoría')
      } else {
        const { rows } = await tx.query(`SELECT COALESCE(MAX(substring(code from '5\\.3\\.(\\d+)')::int), 13) + 1 AS n FROM accounts WHERE code LIKE '5.3.%'`)
        code = `5.3.${String(rows[0].n).padStart(2, '0')}`
        await tx.query(`INSERT INTO accounts (code, name, type) VALUES ($1,$2,'expense')`, [code, b.name])
      }
      try {
        const { rows } = await tx.query('INSERT INTO expense_categories (parent_id, name, account_code, sort) VALUES ($1,$2,$3,200) RETURNING *', [b.parentId ?? null, b.name, code])
        await audit(tx, req.user!.id, 'expense_category.create', 'expense_category', rows[0].id, b)
        return rows[0]
      } catch (e: any) { if (e.code === '23505') throw new HttpError(409, 'Ya existe una categoría con ese nombre'); throw e }
    }))
  })
  app.put('/expense-categories/:id', async (req) => {
    requirePerm(req, 'expenses.write')
    const id = Number((req.params as any).id)
    const b = z.object({ name: z.string().min(2).max(80).optional(), active: z.boolean().optional() }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query('UPDATE expense_categories SET name = COALESCE($2, name), active = COALESCE($3, active) WHERE id = $1 RETURNING *', [id, b.name ?? null, b.active ?? null])
      if (!rows[0]) throw new HttpError(404, 'Categoría inexistente')
      if (b.name && rows[0].account_code) await tx.query('UPDATE accounts SET name = $2 WHERE code = $1', [rows[0].account_code, b.name])
      if (b.active === false) await tx.query('UPDATE expense_categories SET active = false WHERE parent_id = $1', [id])
      await audit(tx, req.user!.id, 'expense_category.update', 'expense_category', id, b)
      return rows[0]
    })
  })

  // ---- Gastos y obligaciones
  app.get('/expenses', async (req) => {
    anyPerm(req, ['expenses.write', 'reports.view'])
    const q = req.query as Record<string, string | undefined>
    const params: unknown[] = []
    const w: string[] = []
    const add = (sql: string, v: unknown) => { params.push(v); w.push(sql.split('$#').join('$' + params.length)) }
    if (q.from) add('e.expense_date >= $#::date', q.from)
    if (q.to) add('e.expense_date <= $#::date', q.to)
    if (q.status === 'open') w.push(`e.status IN ('pending','partial')`)
    else if (q.status) add('e.status = $#', q.status)
    if (q.categoryId) add('(e.category_id = $# OR c.parent_id = $#)', Number(q.categoryId))
    if (q.overdue === '1') w.push(`e.status IN ('pending','partial') AND e.due_date < current_date`)
    if (q.q) add('(e.concept ILIKE $# OR e.beneficiary ILIKE $# OR e.number ILIKE $#)', `%${q.q}%`)
    const sql = `SELECT e.*, (e.amount - e.paid_amount) AS remaining, CASE WHEN pc.id IS NOT NULL THEN pc.name || ' › ' || c.name ELSE c.name END AS category,
        (e.status IN ('pending','partial') AND e.due_date < current_date) AS overdue,
        (SELECT COUNT(*) FROM attachments a WHERE a.owner_type = 'expense' AND a.owner_id = e.id)::int AS attachments
      FROM expenses e JOIN expense_categories c ON c.id = e.category_id LEFT JOIN expense_categories pc ON pc.id = c.parent_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY e.expense_date DESC, e.id DESC LIMIT 500`
    return (await db.query(sql, params)).rows
  })
  app.get('/expenses/:id', async (req) => {
    anyPerm(req, ['expenses.write', 'reports.view'])
    const id = Number((req.params as any).id)
    const { rows } = await db.query(
      `SELECT e.*, CASE WHEN pc.id IS NOT NULL THEN pc.name || ' › ' || c.name ELSE c.name END AS category FROM expenses e
       JOIN expense_categories c ON c.id = e.category_id LEFT JOIN expense_categories pc ON pc.id = c.parent_id WHERE e.id = $1`, [id])
    if (!rows[0]) throw new HttpError(404, 'Gasto no encontrado')
    const { rows: payments } = await db.query('SELECT ep.*, u.name AS user_name FROM expense_payments ep LEFT JOIN users u ON u.id = ep.user_id WHERE expense_id = $1 ORDER BY ep.id', [id])
    const { rows: files } = await db.query('SELECT id, filename, mime, size, note, created_at FROM attachments WHERE owner_type = $1 AND owner_id = $2 ORDER BY id', ['expense', id])
    return { ...rows[0], payments, attachments: files }
  })
  app.post('/expenses', async (req, reply) => {
    requirePerm(req, 'expenses.write')
    const b = expenseBody.parse(req.body)
    const out = await withTx(db, async (tx) => {
      const e = await createExpense(tx, req.user!.id, b)
      if (b.payNow) await payExpense(tx, req.user!, e.id, { ...b.payNow })
      return e
    })
    return reply.code(201).send(out)
  })
  app.post('/expenses/:id/pay', async (req) => {
    requirePerm(req, 'expenses.write')
    const b = z.object({ amount: z.number().int().positive().optional(), method: z.enum(['cash', 'transfer', 'card', 'check']), accountId: z.number().int().nullish(), reference: z.string().nullish(), notes: z.string().nullish() }).parse(req.body)
    return withTx(db, (tx) => payExpense(tx, req.user!, Number((req.params as any).id), b))
  })
  app.post('/expenses/:id/void', async (req) => {
    requirePerm(req, 'expenses.write')
    const id = Number((req.params as any).id)
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [id])
      const e = rows[0]
      if (!e) throw new HttpError(404, 'Gasto no encontrado')
      if (e.status === 'void') throw new HttpError(409, 'El gasto ya está anulado')
      const { rows: pays } = await tx.query(
        `SELECT ep.*, cs.status AS session_status FROM expense_payments ep LEFT JOIN cash_sessions cs ON cs.id = ep.session_id WHERE ep.expense_id = $1 AND NOT ep.voided`, [id])
      if (pays.some((p) => p.session_status === 'closed')) throw new HttpError(409, 'Hay pagos en efectivo de una caja ya cerrada: reabrí la caja con autorización o registrá un ajuste')
      for (const p of pays) {
        await tx.query('UPDATE expense_payments SET voided = true WHERE id = $1', [p.id])
        await reverse(tx, 'expense_payment', p.id, `Anulación de pago del gasto ${e.number}`, req.user!.id)
      }
      await reverse(tx, 'expense', id, `Anulación del gasto ${e.number}: ${reason}`, req.user!.id)
      await tx.query(`UPDATE expenses SET status = 'void', void_reason = $2 WHERE id = $1`, [id, reason])
      await audit(tx, req.user!.id, 'expense.void', 'expense', id, { reason })
      return { status: 'void' }
    })
  })

  // ---- Gastos recurrentes
  app.get('/recurring-expenses', async (req) => {
    anyPerm(req, ['expenses.write', 'reports.view'])
    return (await db.query(`SELECT r.*, c.name AS category FROM recurring_expenses r JOIN expense_categories c ON c.id = r.category_id ORDER BY r.active DESC, r.next_date`)).rows
  })
  app.post('/recurring-expenses', async (req, reply) => {
    requirePerm(req, 'expenses.write')
    const b = z.object({ concept: z.string().min(3), categoryId: z.number().int(), beneficiary: z.string().nullish(), amount: z.number().int().positive(), frequency: z.enum(['weekly', 'monthly', 'yearly']).default('monthly'), nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body)
    await categoryAccount(db, b.categoryId)
    const { rows } = await db.query('INSERT INTO recurring_expenses (concept, category_id, beneficiary, amount, frequency, next_date, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [b.concept, b.categoryId, b.beneficiary, b.amount, b.frequency, b.nextDate, req.user!.id])
    return reply.code(201).send(rows[0])
  })
  app.put('/recurring-expenses/:id', async (req) => {
    requirePerm(req, 'expenses.write')
    const b = z.object({ amount: z.number().int().positive().optional(), active: z.boolean().optional(), nextDate: z.string().optional() }).parse(req.body)
    const { rows } = await db.query('UPDATE recurring_expenses SET amount = COALESCE($2, amount), active = COALESCE($3, active), next_date = COALESCE($4::date, next_date) WHERE id = $1 RETURNING *',
      [Number((req.params as any).id), b.amount ?? null, b.active ?? null, b.nextDate ?? null])
    if (!rows[0]) throw new HttpError(404, 'No encontrado')
    return rows[0]
  })
  app.post('/recurring-expenses/run', async (req) => {
    requirePerm(req, 'expenses.write')
    return { created: await runRecurringExpenses(db, req.user!.id) }
  })

  // ---- Transferencias, aportes y retiros del propietario, ajustes autorizados
  const mmBody = z.object({
    kind: z.enum(['transfer', 'owner_contribution', 'owner_withdrawal', 'adjustment_in', 'adjustment_out']),
    amount: z.number().int().positive(), accountId: z.number().int(), toAccountId: z.number().int().nullish(),
    concept: z.string().min(3).max(160), reference: z.string().max(80).nullish(), notes: z.string().max(500).nullish(),
  })
  app.post('/money-movements', async (req, reply) => {
    requirePerm(req, 'movements.write')
    const b = mmBody.parse(req.body)
    const user = req.user!
    return reply.code(201).send(await withTx(db, async (tx) => {
      const { rows: acc } = await tx.query('SELECT * FROM money_accounts WHERE id = ANY($1) AND active', [[b.accountId, b.toAccountId ?? b.accountId]])
      const from = acc.find((a) => a.id === b.accountId)
      const to = b.toAccountId ? acc.find((a) => a.id === b.toAccountId) : null
      if (!from) throw new HttpError(404, 'Cuenta de origen inexistente o inactiva')
      if (b.kind === 'transfer') {
        if (!to || to.id === from.id) throw new HttpError(400, 'Elegí una cuenta de destino distinta')
      } else if (b.toAccountId) throw new HttpError(400, 'Solo las transferencias llevan cuenta de destino')
      const touchesCash = from.kind === 'cash' || to?.kind === 'cash'
      let sessionId: number | null = null
      if (touchesCash) {
        const s = await openSession(tx, user.id)
        if (!s) throw new HttpError(409, 'Abrí tu caja para registrar movimientos de efectivo')
        sessionId = s.id
      }
      const outflow = ['transfer', 'owner_withdrawal', 'adjustment_out'].includes(b.kind)
      if (outflow) {
        const bal = (await accountBalances(tx as unknown as Db)).find((a) => a.id === from.id)!
        if (bal.balance < b.amount) throw new HttpError(409, `Saldo insuficiente en ${from.name} (${bal.balance})`)
      }
      const { rows: seq } = await tx.query(`SELECT nextval('money_movement_seq') AS n`)
      const number = `M-${String(seq[0].n).padStart(6, '0')}`
      const { rows } = await tx.query(
        `INSERT INTO money_movements (number, kind, amount, account_id, to_account_id, concept, reference, notes, session_id, user_id, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
        [number, b.kind, b.amount, b.accountId, b.toAccountId ?? null, b.concept, b.reference, b.notes, sessionId, user.id])
      const L = ledgerOf(from.kind)
      const lines = b.kind === 'transfer'
        ? (ledgerOf(to!.kind) === L ? [] : [{ code: ledgerOf(to!.kind), debit: b.amount }, { code: L, credit: b.amount }])
        : b.kind === 'owner_contribution' ? [{ code: L, debit: b.amount }, { code: ACC.capital, credit: b.amount }]
        : b.kind === 'owner_withdrawal' ? [{ code: ACC.ownerDraw, debit: b.amount }, { code: L, credit: b.amount }]
        : b.kind === 'adjustment_in' ? [{ code: L, debit: b.amount }, { code: ACC.otherIncome, credit: b.amount }]
        : [{ code: ACC.expenses, debit: b.amount }, { code: L, credit: b.amount }]
      await post(tx, { description: `${KIND_LABEL[b.kind]} ${number}: ${b.concept}`, refType: 'money_movement', refId: rows[0].id, userId: user.id, lines })
      await audit(tx, user.id, `money.${b.kind}`, 'money_movement', rows[0].id, { number, amount: b.amount })
      return rows[0]
    }))
  })
  app.post('/money-movements/:id/void', async (req) => {
    requirePerm(req, 'movements.write')
    const id = Number((req.params as any).id)
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query(
        `SELECT m.*, cs.status AS session_status FROM money_movements m LEFT JOIN cash_sessions cs ON cs.id = m.session_id WHERE m.id = $1 FOR UPDATE OF m`, [id])
      const m = rows[0]
      if (!m) throw new HttpError(404, 'Movimiento no encontrado')
      if (m.voided_at) throw new HttpError(409, 'El movimiento ya está anulado')
      if (m.session_status === 'closed') throw new HttpError(409, 'El movimiento pertenece a una caja cerrada: reabrila con autorización antes de anularlo')
      await tx.query('UPDATE money_movements SET voided_at = now(), void_reason = $2 WHERE id = $1', [id, reason])
      await reverse(tx, 'money_movement', id, `Anulación de ${m.number}: ${reason}`, req.user!.id)
      await audit(tx, req.user!.id, 'money.void', 'money_movement', id, { reason })
      return { voided: true }
    })
  })

  // ---- Comprobantes adjuntos
  const owners = ['expense', 'expense_payment', 'money_movement', 'purchase_order', 'payment', 'supplier_payment', 'sale', 'sale_return', 'cash_session', 'payment_proof', 'reception', 'purchase_invoice', 'supplier_credit_note', 'supplier_return'] as const
  app.post('/attachments', async (req, reply) => {
    anyPerm(req, ['attachments.write', 'expenses.write', 'movements.write'])
    const b = z.object({ ownerType: z.enum(owners), ownerId: z.number().int(), filename: z.string().min(1).max(160), mime: z.string(), dataBase64: z.string().min(4), note: z.string().max(300).nullish() }).parse(req.body)
    if (!/^(image\/(png|jpe?g|webp)|application\/pdf)$/.test(b.mime)) throw new HttpError(400, 'Solo se aceptan imágenes (PNG, JPG, WEBP) o PDF')
    const data = Buffer.from(b.dataBase64.replace(/^data:[^,]+,/, ''), 'base64')
    if (data.length > 5 * 1024 * 1024) throw new HttpError(413, 'El archivo supera los 5 MB')
    const { rows } = await db.query(
      'INSERT INTO attachments (owner_type, owner_id, filename, mime, size, data, note, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, filename, mime, size, note, created_at',
      [b.ownerType, b.ownerId, b.filename, b.mime, data.length, data, b.note, req.user!.id])
    return reply.code(201).send(rows[0])
  })
  app.get('/attachments', async (req) => {
    anyPerm(req, ['attachments.write', 'expenses.write', 'reports.view'])
    const { ownerType, ownerId } = req.query as Record<string, string>
    return (await db.query('SELECT id, filename, mime, size, note, created_at FROM attachments WHERE owner_type = $1 AND owner_id = $2 ORDER BY id', [ownerType, Number(ownerId)])).rows
  })
  app.get('/attachments/:id/file', async (req, reply) => {
    anyPerm(req, ['attachments.write', 'expenses.write', 'reports.view'])
    const { rows } = await db.query('SELECT filename, mime, data FROM attachments WHERE id = $1', [Number((req.params as any).id)])
    if (!rows[0]) throw new HttpError(404, 'Archivo no encontrado')
    return reply.header('content-type', rows[0].mime).header('content-disposition', `inline; filename="${encodeURIComponent(rows[0].filename)}"`).send(rows[0].data)
  })
  app.delete('/attachments/:id', async (req) => {
    requirePerm(req, 'movements.write')
    await db.query('DELETE FROM attachments WHERE id = $1', [Number((req.params as any).id)])
    return { ok: true }
  })

  // ---- Liquidaciones (tarjeta, QR, pasarela) y cheques
  app.get('/payments/pending-settlement', async (req) => {
    anyPerm(req, ['payments.settle', 'reports.view'])
    const { method } = req.query as { method?: string }
    const { rows } = await db.query(
      `SELECT p.id, p.at, p.kind, p.method, p.amount, p.fee, p.details, p.reference, p.settlement_status, s.number AS sale_number, c.name AS customer_name
       FROM payments p LEFT JOIN sales s ON s.id = p.sale_id LEFT JOIN customers c ON c.id = COALESCE(s.customer_id, p.customer_id)
       WHERE p.settlement_status = 'pending' AND ($1::text IS NULL OR p.method = $1) ORDER BY p.at`, [method ?? null])
    return rows
  })
  app.post('/payments/settle', async (req) => {
    requirePerm(req, 'payments.settle')
    const b = z.object({ ids: z.array(z.number().int()).min(1), accountId: z.number().int(), fee: z.number().int().min(0).optional(), date: z.string().optional() }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows: acc } = await tx.query(`SELECT * FROM money_accounts WHERE id = $1 AND kind = 'bank' AND active`, [b.accountId])
      if (!acc[0]) throw new HttpError(400, 'Elegí la cuenta bancaria donde se acredita')
      const { rows: pays } = await tx.query(`SELECT * FROM payments WHERE id = ANY($1) AND settlement_status = 'pending' FOR UPDATE`, [b.ids])
      if (pays.length !== b.ids.length) throw new HttpError(409, 'Alguno de los cobros ya fue liquidado o no existe')
      const checks = pays.filter((p) => p.method === 'check')
      if (checks.length && checks.length !== pays.length) throw new HttpError(400, 'Los cheques se depositan por separado de tarjetas y QR')
      const positive = pays.filter((p) => Number(p.amount) > 0)
      const estimated = positive.reduce((a, p) => a + Number(p.fee), 0)
      const fee = checks.length ? 0 : b.fee ?? estimated
      const gross = pays.reduce((a, p) => a + Number(p.amount), 0)
      if (fee > gross) throw new HttpError(400, 'La comisión no puede superar el importe liquidado')
      // la comisión real se reparte entre los cobros positivos en proporción a su importe
      const base = positive.reduce((a, p) => a + Number(p.amount), 0) || 1
      let left = fee
      for (const p of pays) {
        const share = Number(p.amount) > 0 ? (p === positive[positive.length - 1] ? left : Math.round((fee * Number(p.amount)) / base)) : 0
        left -= share
        await tx.query(`UPDATE payments SET settlement_status = 'settled', settled_at = $2, settled_account_id = $3, settled_fee = $4 WHERE id = $1`,
          [p.id, b.date ? `${b.date}T12:00:00-03:00` : new Date().toISOString(), b.accountId, share])
      }
      const byClearing = new Map<string, number>()
      for (const p of pays) byClearing.set(CLEARING[p.method] ?? ACC.cards, (byClearing.get(CLEARING[p.method] ?? ACC.cards) ?? 0) + Number(p.amount))
      await post(tx, { description: checks.length ? 'Depósito de cheques' : 'Liquidación de cobros electrónicos', refType: 'settlement', refId: pays[0].id, userId: req.user!.id,
        lines: [
          { code: ACC.bank, debit: gross - fee }, { code: ACC.bankFees, debit: fee },
          ...[...byClearing].map(([code, amount]) => ({ code, credit: amount })),
        ] })
      if (fee > 0) { // la comisión queda como gasto "ya pagado" (descontada en la acreditación) para los reportes de gastos
        const { rows: cat } = await tx.query(`SELECT id FROM expense_categories WHERE parent_id IS NULL AND account_code = '5.2.02'`)
        const e = await createExpense(tx, req.user!.id, { categoryId: cat[0].id, concept: `Comisiones de cobros electrónicos (${pays.length} cobros)`, beneficiary: acc[0].bank_name ?? acc[0].name, amount: fee } as any, { skipAccounting: true })
        await tx.query(`UPDATE expenses SET paid_amount = $2, status = 'paid' WHERE id = $1`, [e.id, fee])
        await tx.query(`INSERT INTO expense_payments (expense_id, amount, method, account_id, kind, notes, user_id) VALUES ($1,$2,'transfer',$3,'fee_deducted','Descontada en la acreditación',$4)`, [e.id, fee, b.accountId, req.user!.id])
      }
      await audit(tx, req.user!.id, checks.length ? 'cheque.deposit' : 'payments.settle', 'payment', pays[0].id, { ids: b.ids, gross, fee })
      return { settled: pays.length, gross, fee, net: gross - fee }
    })
  })
  app.post('/payments/:id/reject', async (req) => {
    requirePerm(req, 'payments.settle')
    const id = Number((req.params as any).id)
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM payments WHERE id = $1 AND settlement_status = 'pending' FOR UPDATE`, [id])
      const p = rows[0]
      if (!p) throw new HttpError(404, 'Cobro pendiente no encontrado')
      if (p.method !== 'check') throw new HttpError(400, 'Solo se rechazan cheques; las tarjetas y QR se corrigen con reembolsos')
      await tx.query(`UPDATE payments SET settlement_status = 'rejected', details = details || $2::jsonb WHERE id = $1`, [id, JSON.stringify({ status: 'rejected', rejectReason: reason })])
      const { rows: s } = p.sale_id ? await tx.query('SELECT customer_id FROM sales WHERE id = $1', [p.sale_id]) : { rows: [] as any[] }
      const customerId = s[0]?.customer_id ?? p.customer_id
      if (customerId) { // la deuda vuelve al cliente como una cuota a pagar hoy
        await tx.query('UPDATE customers SET balance = balance + $2 WHERE id = $1', [customerId, p.amount])
        await tx.query(`INSERT INTO customer_ledger (customer_id, type, amount, sale_id, note) VALUES ($1,'cheque_rejected',$2,$3,$4)`, [customerId, p.amount, p.sale_id, `Cheque rechazado: ${reason}`])
        await tx.query(`INSERT INTO installments (sale_id, customer_id, number, due_date, amount) VALUES ($1,$2,1,$3,$4)`, [p.sale_id, customerId, localToday(), p.amount])
      }
      await post(tx, { description: `Cheque rechazado (cobro #${id}): ${reason}`, refType: 'cheque_rejected', refId: id, userId: req.user!.id,
        lines: [{ code: customerId ? ACC.receivable : ACC.expenses, debit: Number(p.amount) }, { code: ACC.checks, credit: Number(p.amount) }] })
      await audit(tx, req.user!.id, 'cheque.reject', 'payment', id, { reason })
      return { status: 'rejected' }
    })
  })

  // ---- Registro unificado de movimientos
  app.get('/movements', async (req) => {
    anyPerm(req, ['reports.view'])
    const q = req.query as Record<string, string | undefined>
    const f: MovementFilters = {
      from: q.from, to: q.to, kinds: q.kinds ? q.kinds.split(',') : undefined, direction: q.direction, method: q.method,
      accountId: q.accountId ? Number(q.accountId) : undefined, sessionId: q.sessionId ? Number(q.sessionId) : undefined, userId: q.userId ? Number(q.userId) : undefined,
      partyType: q.partyType, partyId: q.partyId ? Number(q.partyId) : undefined, q: q.q, category: q.category, includeVoided: q.includeVoided === '1',
    }
    const page = Math.max(Number(q.page) || 1, 1)
    const pageSize = Math.min(Number(q.pageSize) || 50, 500)
    const params: unknown[] = []
    const where = movementsWhere(f, params)
    const base = `WITH mv AS (${MOVEMENTS_SQL}) SELECT mv.*, u.name AS user_name, a.name AS account_name,
        (SELECT COUNT(*) FROM attachments at WHERE at.owner_type = CASE mv.ref_type WHEN 'money_movement' THEN 'money_movement' WHEN 'expense' THEN 'expense' WHEN 'sale' THEN 'sale' ELSE '-' END AND at.owner_id = mv.ref_id)::int AS attachments
      FROM mv LEFT JOIN users u ON u.id = mv.user_id LEFT JOIN money_accounts a ON a.id = mv.account_id ${where}`
    const { rows: tot } = await db.query(
      `WITH mv AS (${MOVEMENTS_SQL}) SELECT COUNT(*)::int AS count,
         COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) AS income, COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0) AS expense
       FROM mv ${where}`, params)
    const { rows } = await db.query(`${base} ORDER BY mv.at DESC, mv.key DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params)
    return {
      page, pageSize, total: tot[0].count, income: Number(tot[0].income), expense: Number(tot[0].expense), net: Number(tot[0].income) - Number(tot[0].expense),
      rows: rows.map((r) => ({ ...r, kind_label: KIND_LABEL[r.kind] ?? r.kind })),
    }
  })
}
