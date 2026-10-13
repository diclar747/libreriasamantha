import type { Db, Tx } from './db/client.js'
import { getSetting } from './services.js'

type Q = Db | Tx

// Medios de cobro y su tratamiento
export const METHODS = ['cash', 'card', 'qr', 'transfer', 'check', 'online', 'advance'] as const
export const METHOD_LABEL: Record<string, string> = {
  cash: 'Efectivo', card: 'Tarjeta', qr: 'QR', transfer: 'Transferencia', check: 'Cheque', online: 'Pago en línea', advance: 'Anticipo',
}
// Estos medios no entran a una cuenta al cobrar: quedan pendientes de liquidar/depositar.
export const needsSettlement = (method: string) => ['card', 'qr', 'online', 'check'].includes(method)

export async function defaultAccount(q: Q, kind: 'cash' | 'bank'): Promise<number> {
  const { rows } = await q.query('SELECT id FROM money_accounts WHERE kind = $1 AND active ORDER BY id LIMIT 1', [kind])
  if (!rows[0]) throw new Error(`No hay una cuenta de tipo ${kind} configurada`)
  return rows[0].id
}

// Cuenta que recibe (o paga) según el medio: efectivo → caja; transferencia → banco elegido o el principal.
export async function accountForMethod(q: Q, method: string, accountId?: number | null): Promise<number | null> {
  if (accountId) return accountId
  if (method === 'cash') return defaultAccount(q, 'cash')
  if (method === 'transfer') return defaultAccount(q, 'bank')
  return null
}

// Comisión estimada al cobrar (se corrige con el valor real al liquidar).
export async function estimateFee(q: Q, method: string, details: any, amount: number): Promise<number> {
  const fees = (await getSetting(q, 'payments')).fees ?? {}
  const pct = method === 'card' ? (details?.type === 'debit' ? fees.card_debit : fees.card_credit) : method === 'qr' ? fees.qr : method === 'online' ? fees.online : 0
  return Math.round((amount * Number(pct ?? 0)) / 100)
}

// ---------------------------------------------------------------- Registro unificado de movimientos
const CASH = `(SELECT id FROM money_accounts WHERE kind = 'cash' ORDER BY id LIMIT 1)`
const BANK = `(SELECT id FROM money_accounts WHERE kind = 'bank' ORDER BY id LIMIT 1)`
const payAcct = `CASE WHEN p.method = 'cash' THEN COALESCE(p.account_id, ${CASH}) WHEN p.method = 'transfer' THEN COALESCE(p.account_id, ${BANK}) END`
const payDelta = `CASE WHEN p.method IN ('cash','transfer') THEN p.amount END`
const outAcct = (t: string) => `CASE WHEN ${t}.method = 'cash' THEN COALESCE(${t}.account_id, ${CASH}) ELSE COALESCE(${t}.account_id, ${BANK}) END`

// Columnas comunes: key, at, kind, direction, amount (efecto en ingresos/egresos), concept, category, method,
// account_id, account_delta (efecto en el saldo de la cuenta), session_id, party_*, user_id, ref_*, reference, notes,
// settlement_status, fee, voided
export const MOVEMENTS_SQL = `
  SELECT 'pay:' || p.id AS key, p.at, 'sale_payment'::text AS kind, 'in'::text AS direction, p.amount::bigint AS amount,
    ('Cobro de venta ' || s.number)::text AS concept, 'Ventas'::text AS category, p.method::text AS method,
    (${payAcct})::int AS account_id, (${payDelta})::bigint AS account_delta, p.session_id,
    'customer'::text AS party_type, s.customer_id AS party_id, c.name::text AS party_name, COALESCE(p.user_id, s.user_id) AS user_id,
    'sale'::text AS ref_type, s.id AS ref_id, s.number::text AS ref_number, p.reference::text AS reference, NULL::text AS notes,
    p.settlement_status::text AS settlement_status, p.fee::bigint AS fee, false AS voided
  FROM payments p JOIN sales s ON s.id = p.sale_id LEFT JOIN customers c ON c.id = s.customer_id
  WHERE p.kind = 'sale' AND p.method <> 'advance'
  UNION ALL
  SELECT 'pay:' || p.id, p.at, 'customer_payment', 'in', p.amount::bigint,
    CASE WHEN p.customer_id IS NULL THEN 'Anticipo de trabajo de impresión' ELSE 'Cobranza de cuotas — ' || c.name END,
    CASE WHEN p.customer_id IS NULL THEN 'Anticipos de clientes' ELSE 'Cobranza de crédito' END, p.method::text,
    (${payAcct})::int, (${payDelta})::bigint, p.session_id,
    'customer', p.customer_id, c.name::text, p.user_id, 'customer', p.customer_id, NULL::text, p.reference::text, NULL::text,
    p.settlement_status::text, p.fee::bigint, false
  FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
  WHERE p.kind = 'customer_payment' AND p.method <> 'advance'
  UNION ALL
  SELECT 'pay:' || p.id, p.at, CASE WHEN p.kind = 'return' THEN 'sale_return' ELSE 'refund' END, 'out', p.amount::bigint,
    CASE WHEN p.kind = 'return' THEN 'Devolución de venta ' || s.number ELSE 'Reembolso por anulación de ' || s.number END,
    'Devoluciones y reembolsos', p.method::text,
    (${payAcct})::int, (${payDelta})::bigint, p.session_id,
    'customer', s.customer_id, c.name::text, COALESCE(p.user_id, s.voided_by, s.user_id), 'sale', s.id, s.number::text, p.reference::text, NULL::text,
    p.settlement_status::text, p.fee::bigint, false
  FROM payments p JOIN sales s ON s.id = p.sale_id LEFT JOIN customers c ON c.id = s.customer_id
  WHERE p.kind IN ('refund','return') AND p.method <> 'advance'
  UNION ALL
  SELECT 'sp:' || sp.id, sp.at, 'supplier_payment', 'out', (-sp.amount)::bigint, 'Pago a proveedor ' || s.name, 'Proveedores', sp.method::text,
    (${outAcct('sp')})::int, (-sp.amount)::bigint, sp.session_id,
    'supplier', sp.supplier_id, s.name::text, sp.user_id,
    CASE WHEN sp.order_id IS NOT NULL THEN 'purchase_order' ELSE 'supplier' END, COALESCE(sp.order_id, sp.supplier_id),
    CASE WHEN sp.order_id IS NOT NULL THEN 'OC-' || sp.order_id END, sp.reference::text, sp.note::text, 'none', 0::bigint, sp.voided
  FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id WHERE sp.method <> 'credit'
  UNION ALL
  SELECT 'scn:' || n.id, n.created_at, 'supplier_refund', 'in', n.amount::bigint, ('Reembolso de proveedor ' || s.name)::text, 'Proveedores', COALESCE(n.refund_method, 'transfer')::text,
    (CASE WHEN n.refund_method = 'cash' THEN COALESCE(n.refund_account_id, ${CASH}) ELSE COALESCE(n.refund_account_id, ${BANK}) END)::int, n.amount::bigint, n.session_id,
    'supplier', n.supplier_id, s.name::text, n.user_id, 'supplier_credit_note', n.id, n.number::text, n.reference::text, n.notes::text, 'none', 0::bigint, n.status = 'void'
  FROM supplier_credit_notes n JOIN suppliers s ON s.id = n.supplier_id WHERE n.resolution = 'refund'
  UNION ALL
  SELECT 'ep:' || ep.id, ep.paid_at, CASE WHEN ep.kind = 'fee_deducted' THEN 'card_fee' ELSE 'expense_payment' END, 'out', (-ep.amount)::bigint,
    e.concept::text, CASE WHEN pc.id IS NOT NULL THEN pc.name || ' › ' || c.name ELSE c.name END, ep.method::text,
    CASE WHEN ep.kind = 'fee_deducted' THEN NULL ELSE (${outAcct('ep')})::int END,
    CASE WHEN ep.kind = 'fee_deducted' THEN NULL ELSE (-ep.amount)::bigint END, ep.session_id,
    'beneficiary', NULL::int, e.beneficiary::text, ep.user_id, 'expense', e.id, e.number::text, ep.reference::text, ep.notes::text, 'none', 0::bigint, ep.voided
  FROM expense_payments ep JOIN expenses e ON e.id = ep.expense_id
  JOIN expense_categories c ON c.id = e.category_id LEFT JOIN expense_categories pc ON pc.id = c.parent_id
  UNION ALL
  SELECT 'cm:' || m.id, m.at, CASE WHEN m.type = 'in' THEN 'cash_in' ELSE 'cash_out' END, m.type::text,
    CASE WHEN m.type = 'in' THEN m.amount ELSE -m.amount END::bigint, m.reason::text, 'Caja', 'cash',
    ${CASH}::int, CASE WHEN m.type = 'in' THEN m.amount ELSE -m.amount END::bigint, m.session_id,
    NULL::text, NULL::int, NULL::text, cs.user_id, 'cash_session', m.session_id, NULL::text, NULL::text, NULL::text, 'none', 0::bigint, false
  FROM cash_movements m JOIN cash_sessions cs ON cs.id = m.session_id
  WHERE m.kind <> 'supplier_payment'
  UNION ALL
  SELECT 'mm:' || m.id, m.created_at, m.kind::text,
    CASE WHEN m.kind IN ('owner_contribution','adjustment_in') THEN 'in' ELSE 'out' END,
    CASE WHEN m.kind IN ('owner_contribution','adjustment_in') THEN m.amount ELSE -m.amount END::bigint, m.concept::text,
    CASE m.kind WHEN 'owner_contribution' THEN 'Aporte del propietario' WHEN 'owner_withdrawal' THEN 'Retiro del propietario' ELSE 'Ajuste autorizado' END,
    CASE WHEN a.kind = 'cash' THEN 'cash' ELSE 'transfer' END, m.account_id,
    CASE WHEN m.kind IN ('owner_contribution','adjustment_in') THEN m.amount ELSE -m.amount END::bigint, CASE WHEN a.kind = 'cash' THEN m.session_id END,
    NULL::text, NULL::int, NULL::text, m.user_id, 'money_movement', m.id, m.number::text, m.reference::text, m.notes::text, 'none', 0::bigint, m.voided_at IS NOT NULL
  FROM money_movements m JOIN money_accounts a ON a.id = m.account_id WHERE m.kind <> 'transfer'
  UNION ALL
  SELECT 'mm:' || m.id || ':out', m.created_at, 'transfer', 'internal', 0::bigint, (m.concept || ' → ' || t.name)::text, 'Transferencia entre cuentas',
    CASE WHEN a.kind = 'cash' THEN 'cash' ELSE 'transfer' END, m.account_id, (-m.amount)::bigint, CASE WHEN a.kind = 'cash' THEN m.session_id END,
    NULL::text, NULL::int, NULL::text, m.user_id, 'money_movement', m.id, m.number::text, m.reference::text, m.notes::text, 'none', 0::bigint, m.voided_at IS NOT NULL
  FROM money_movements m JOIN money_accounts a ON a.id = m.account_id JOIN money_accounts t ON t.id = m.to_account_id WHERE m.kind = 'transfer'
  UNION ALL
  SELECT 'mm:' || m.id || ':in', m.created_at, 'transfer', 'internal', 0::bigint, (m.concept || ' ← ' || a.name)::text, 'Transferencia entre cuentas',
    CASE WHEN t.kind = 'cash' THEN 'cash' ELSE 'transfer' END, m.to_account_id, m.amount::bigint, CASE WHEN t.kind = 'cash' THEN m.session_id END,
    NULL::text, NULL::int, NULL::text, m.user_id, 'money_movement', m.id, m.number::text, m.reference::text, m.notes::text, 'none', 0::bigint, m.voided_at IS NOT NULL
  FROM money_movements m JOIN money_accounts a ON a.id = m.account_id JOIN money_accounts t ON t.id = m.to_account_id WHERE m.kind = 'transfer'
  UNION ALL
  SELECT 'set:' || p.id, p.settled_at, CASE WHEN p.method = 'check' THEN 'cheque_deposit' ELSE 'settlement' END, 'internal', 0::bigint,
    (CASE WHEN p.method = 'check' THEN 'Depósito de cheque' ELSE 'Liquidación de ' || p.method END || ' — ' || COALESCE(s.number, 'cobro #' || p.id))::text,
    'Liquidaciones', p.method::text, p.settled_account_id, (p.amount - COALESCE(p.settled_fee, 0))::bigint, NULL::int,
    'customer', s.customer_id, NULL::text, p.user_id, CASE WHEN s.id IS NOT NULL THEN 'sale' ELSE 'payment' END, COALESCE(s.id, p.id), s.number::text,
    p.reference::text, NULL::text, 'settled', COALESCE(p.settled_fee, 0)::bigint, false
  FROM payments p LEFT JOIN sales s ON s.id = p.sale_id WHERE p.settlement_status = 'settled'
  UNION ALL
  SELECT 'cd:' || cs.id, cs.closed_at, 'cash_difference', CASE WHEN cs.counted_cash >= cs.expected_cash THEN 'in' ELSE 'out' END,
    (cs.counted_cash - cs.expected_cash)::bigint, ('Diferencia de caja del turno #' || cs.id)::text, 'Diferencias de caja', 'cash',
    COALESCE(cs.account_id, ${CASH})::int, (cs.counted_cash - cs.expected_cash)::bigint, cs.id,
    NULL::text, NULL::int, NULL::text, cs.closed_by, 'cash_session', cs.id, NULL::text, NULL::text, cs.diff_note::text, 'none', 0::bigint, false
  FROM cash_sessions cs WHERE cs.status = 'closed' AND cs.counted_cash IS NOT NULL AND cs.counted_cash <> cs.expected_cash
`

export const KIND_LABEL: Record<string, string> = {
  sale_payment: 'Cobro de venta', customer_payment: 'Cobro de cuota/anticipo', refund: 'Reembolso', sale_return: 'Devolución',
  supplier_payment: 'Pago a proveedor', supplier_refund: 'Reembolso de proveedor', expense_payment: 'Pago de gasto', card_fee: 'Comisión descontada', cash_in: 'Ingreso de caja', cash_out: 'Retiro de caja',
  owner_contribution: 'Aporte del propietario', owner_withdrawal: 'Retiro del propietario', adjustment_in: 'Ajuste (+)', adjustment_out: 'Ajuste (−)',
  transfer: 'Transferencia', settlement: 'Liquidación', cheque_deposit: 'Depósito de cheque', cash_difference: 'Diferencia de caja',
}

export interface MovementFilters {
  from?: string; to?: string; kinds?: string[]; direction?: string; method?: string; accountId?: number
  sessionId?: number; userId?: number; partyType?: string; partyId?: number; q?: string; category?: string
  includeVoided?: boolean; refType?: string; refId?: number
}

export function movementsWhere(f: MovementFilters, params: unknown[], alias = 'mv') {
  const w: string[] = []
  const add = (sql: string, v: unknown) => { params.push(v); w.push(sql.replace('$#', '$' + params.length)) }
  if (!f.includeVoided) w.push(`NOT ${alias}.voided`)
  if (f.from) add(`local_date(${alias}.at) >= $#::date`, f.from)
  if (f.to) add(`local_date(${alias}.at) <= $#::date`, f.to)
  if (f.kinds?.length) add(`${alias}.kind = ANY($#)`, f.kinds)
  if (f.direction) add(`${alias}.direction = $#`, f.direction)
  if (f.method) add(`${alias}.method = $#`, f.method)
  if (f.accountId) add(`${alias}.account_id = $#`, f.accountId)
  if (f.sessionId) add(`${alias}.session_id = $#`, f.sessionId)
  if (f.userId) add(`${alias}.user_id = $#`, f.userId)
  if (f.partyType) add(`${alias}.party_type = $#`, f.partyType)
  if (f.partyId) add(`${alias}.party_id = $#`, f.partyId)
  if (f.category) add(`${alias}.category ILIKE $#`, `%${f.category}%`)
  if (f.refType) add(`${alias}.ref_type = $#`, f.refType)
  if (f.refId) add(`${alias}.ref_id = $#`, f.refId)
  if (f.q) {
    params.push(`%${f.q}%`)
    const n = '$' + params.length
    w.push(`(${alias}.concept ILIKE ${n} OR ${alias}.ref_number ILIKE ${n} OR ${alias}.reference ILIKE ${n} OR ${alias}.party_name ILIKE ${n})`)
  }
  return w.length ? 'WHERE ' + w.join(' AND ') : ''
}

// Efectivo físico esperado de un turno: fondo inicial + entradas en efectivo − salidas en efectivo.
// Tarjetas, QR, transferencias y cheques aparecen en el resumen pero no suman efectivo.
export async function sessionCash(q: Q, sessionId: number) {
  const { rows: s } = await q.query('SELECT * FROM cash_sessions WHERE id = $1', [sessionId])
  if (!s[0]) return null
  const { rows } = await q.query(
    `WITH mv AS (${MOVEMENTS_SQL})
     SELECT mv.* , a.kind AS account_kind FROM mv LEFT JOIN money_accounts a ON a.id = mv.account_id
     WHERE mv.session_id = $1 AND NOT mv.voided ORDER BY mv.at, mv.key`, [sessionId])
  const cashRows = rows.filter((r) => r.account_kind === 'cash' && r.kind !== 'cash_difference' && !String(r.reference ?? '').startsWith('close:') && r.account_delta !== null)
  const cashIn = cashRows.filter((r) => Number(r.account_delta) > 0).reduce((a, r) => a + Number(r.account_delta), 0)
  const cashOut = cashRows.filter((r) => Number(r.account_delta) < 0).reduce((a, r) => a - Number(r.account_delta), 0)
  const opening = Number(s[0].opening_float)
  const byMethod = new Map<string, { method: string; count: number; amount: number; fee: number }>()
  for (const r of rows) {
    if (!['sale_payment', 'customer_payment', 'refund', 'sale_return'].includes(r.kind)) continue
    const m = byMethod.get(r.method) ?? { method: r.method, count: 0, amount: 0, fee: 0 }
    m.count++; m.amount += Number(r.amount); m.fee += Number(r.fee)
    byMethod.set(r.method, m)
  }
  return {
    session: s[0], opening, cashIn, cashOut, expected: opening + cashIn - cashOut,
    byMethod: [...byMethod.values()].sort((a, b) => a.method.localeCompare(b.method)),
    movements: rows.filter((r) => ['cash_in', 'cash_out', 'owner_contribution', 'owner_withdrawal', 'adjustment_in', 'adjustment_out', 'expense_payment', 'supplier_payment', 'supplier_refund', 'transfer'].includes(r.kind)),
    refunds: rows.filter((r) => ['refund', 'sale_return'].includes(r.kind)),
  }
}

// Saldos por caja/cuenta bancaria a una fecha (por defecto, hoy).
export async function accountBalances(q: Q, asOf?: string) {
  const { rows } = await q.query(
    `WITH mv AS (${MOVEMENTS_SQL})
     SELECT a.id, a.kind, a.name, a.bank_name, a.account_number, a.currency, a.opening_balance, a.active,
       a.opening_balance + COALESCE(SUM(mv.account_delta) FILTER (WHERE NOT mv.voided AND ($1::date IS NULL OR local_date(mv.at) <= $1::date)), 0) AS balance
     FROM money_accounts a LEFT JOIN mv ON mv.account_id = a.id
     GROUP BY a.id ORDER BY a.kind, a.id`, [asOf ?? null])
  return rows.map((r) => ({ ...r, opening_balance: Number(r.opening_balance), balance: Number(r.balance) }))
}
