import type { FastifyInstance } from 'fastify'
import { anyPerm, can } from '../auth.js'
import { HttpError, type Db } from '../db/client.js'
import { getSetting } from '../services.js'
import { applyPermissions, parseFilters, type Ctx, type Filters, type ReportResult } from './core.js'
import { buildCsv, buildPdf, buildXlsx, pickColumns } from './export.js'
import { expensesReport } from './expenses.js'
import { cashSessionsReport, cashflowReport, movementsReport, paymentsReport } from './money.js'
import { onlineProductsReport, onlineReport } from './online.js'
import { overviewReport } from './overview.js'
import { customerStatementReport, receivablesReport } from './receivables.js'
import { balanceSheetReport, incomeStatementReport } from './results.js'
import { SALES_GROUPS, salesReport } from './sales.js'
import { payablesReport, purchaseInvoicesReport, purchaseOrdersReport, supplierReturnsReport } from './purchasing.js'
import { inventoryReport, lowStockReport, priceChangesReport, stockMovementsReport } from './products.js'

export interface ReportDef {
  id: string
  title: string
  group: string
  perms: string[]
  run: (ctx: Ctx) => Promise<ReportResult>
  groups?: Record<string, string>
  views?: boolean // admite resumen y detalle
  filters: string[]
  dateFields?: { key: string; label: string }[]
}

const G = (o: Record<string, string>) => o
export const REPORTS: ReportDef[] = [
  { id: 'sales', title: 'Ventas', group: 'Ventas y cobros', perms: ['reports.view'], run: salesReport, groups: SALES_GROUPS, views: true,
    filters: ['period', 'channel', 'seller', 'customer', 'product', 'category', 'brand', 'method', 'session', 'condition', 'state', 'collection', 'q'] },
  { id: 'payments', title: 'Cobros por medio de pago', group: 'Ventas y cobros', perms: ['reports.view'], run: paymentsReport, views: true,
    groups: G({ method: 'Medio de pago', day: 'Día', month: 'Mes', account: 'Cuenta', processor: 'Procesador / proveedor', card_type: 'Tipo de tarjeta' }),
    filters: ['period', 'method', 'account', 'settlement', 'session', 'q'], dateFields: [{ key: 'payment', label: 'Fecha de cobro' }, { key: 'settlement', label: 'Fecha de acreditación' }] },
  { id: 'receivables', title: 'Cuentas por cobrar (antigüedad)', group: 'Ventas y cobros', perms: ['reports.view'], run: receivablesReport, views: true, filters: ['asOf', 'customer', 'q'], dateFields: [{ key: 'asof', label: 'Deuda a una fecha' }, { key: 'due', label: 'Fecha de vencimiento' }] },
  { id: 'customer-statement', title: 'Estado de cuenta de un cliente', group: 'Ventas y cobros', perms: ['reports.view', 'customers.read'], run: customerStatementReport, filters: ['customer'] },
  { id: 'online', title: 'Tienda online', group: 'Ventas y cobros', perms: ['reports.view', 'orders.manage'], run: onlineReport,
    groups: G({ status: 'Estado del pedido', payment: 'Estado del pago', delivery: 'Estado de entrega', day: 'Día', month: 'Mes', coupon: 'Cupón', city: 'Ciudad / entrega' }),
    filters: ['period', 'orderStatus', 'paymentStatus', 'deliveryStatus', 'deliveryMethod', 'q'] },
  { id: 'online-products', title: 'Tienda online — productos vendidos', group: 'Ventas y cobros', perms: ['reports.view'], run: onlineProductsReport, filters: ['period'] },
  { id: 'movements', title: 'Movimientos de dinero', group: 'Dinero y caja', perms: ['reports.view'], run: movementsReport, views: true,
    groups: G({ day: 'Día', month: 'Mes', category: 'Categoría', kind: 'Tipo de movimiento', method: 'Medio de pago', account: 'Cuenta / caja', user: 'Responsable' }),
    filters: ['period', 'direction', 'method', 'account', 'session', 'user', 'category', 'q'] },
  { id: 'cashflow', title: 'Flujo de dinero', group: 'Dinero y caja', perms: ['reports.view'], run: cashflowReport, filters: ['period'] },
  { id: 'cash-sessions', title: 'Cajas y turnos', group: 'Dinero y caja', perms: ['reports.view'], run: cashSessionsReport, filters: ['period', 'user', 'cashStatus'] },
  { id: 'expenses', title: 'Gastos', group: 'Dinero y caja', perms: ['reports.view', 'expenses.write'], run: expensesReport, views: true,
    groups: G({ category: 'Categoría', subcategory: 'Subcategoría', month: 'Mes', day: 'Día', status: 'Estado', beneficiary: 'Beneficiario' }),
    filters: ['period', 'expenseCategory', 'expenseStatus', 'overdue', 'q'], dateFields: [{ key: 'expense', label: 'Fecha del gasto' }, { key: 'due', label: 'Fecha de vencimiento' }, { key: 'payment', label: 'Fecha de pago' }] },
  { id: 'purchase-orders', title: 'Órdenes de compra', group: 'Compras y proveedores', perms: ['purchases.view', 'purchases.write', 'reports.view'], run: purchaseOrdersReport, views: true,
    groups: G({ supplier: 'Proveedor', status: 'Estado', month: 'Mes', day: 'Día' }), filters: ['period', 'supplier', 'poStatus', 'q'] },
  { id: 'purchase-invoices', title: 'Compras facturadas', group: 'Compras y proveedores', perms: ['purchases.view', 'purchases.invoice', 'reports.view'], run: purchaseInvoicesReport, views: true,
    groups: G({ supplier: 'Proveedor', condition: 'Condición de pago', status: 'Estado', month: 'Mes', day: 'Día' }), filters: ['period', 'supplier', 'invStatus', 'condition', 'q'] },
  { id: 'payables', title: 'Cuentas por pagar (antigüedad)', group: 'Compras y proveedores', perms: ['purchases.view', 'suppliers.pay', 'reports.view'], run: payablesReport, views: true, filters: ['asOf', 'supplier', 'q'], dateFields: [{ key: 'asof', label: 'Deuda a una fecha' }, { key: 'due', label: 'Fecha de vencimiento' }] },
  { id: 'supplier-returns', title: 'Devoluciones a proveedores', group: 'Compras y proveedores', perms: ['purchases.view', 'reports.view'], run: supplierReturnsReport, filters: ['period', 'supplier'] },
  { id: 'inventory', title: 'Inventario valorizado', group: 'Productos e inventario', perms: ['stock.read', 'reports.view'], run: inventoryReport, views: true, groups: G({ category: 'Categoría', brand: 'Marca' }), filters: ['category', 'brand', 'supplier', 'stockState', 'q'] },
  { id: 'low-stock', title: 'Stock bajo y agotados', group: 'Productos e inventario', perms: ['stock.read', 'reports.view'], run: lowStockReport, filters: ['category', 'supplier'] },
  { id: 'stock-movements', title: 'Movimientos de stock', group: 'Productos e inventario', perms: ['stock.read', 'reports.view'], run: stockMovementsReport, filters: ['period', 'product', 'category', 'stockType', 'user', 'q'] },
  { id: 'price-changes', title: 'Cambios de precio y costo', group: 'Productos e inventario', perms: ['costs.view'], run: priceChangesReport, filters: ['period', 'product', 'category', 'q'] },
  { id: 'income-statement', title: 'Estado de resultados', group: 'Balances', perms: ['reports.view', 'accounting.view'], run: incomeStatementReport, filters: ['period'] },
  { id: 'balance-sheet', title: 'Balance general', group: 'Balances', perms: ['reports.view', 'accounting.view'], run: balanceSheetReport, filters: ['asOf'] },
]

const FILTER_LABEL: Record<string, string> = {
  channel: 'Canal', method: 'Medio', state: 'Estado', collection: 'Cobro', condition: 'Condición', category: 'Categoría', brand: 'Marca', q: 'Búsqueda', groupBy: 'Agrupado por', view: 'Vista', status: 'Estado', dateField: 'Fecha analizada',
}
const VALUE_LABEL: Record<string, string> = { pos: 'Mostrador', web: 'Tienda online', credit: 'Crédito', cash: 'Contado', valid: 'Vigente', void: 'Anulada', returned: 'Devuelta', partial_return: 'Devuelta parcial', paid: 'Cobrada', pending: 'Pendiente', partial: 'Parcial', detail: 'Detalle', summary: 'Resumen' }

function describeFilters(f: Filters, def: ReportDef) {
  const parts: string[] = []
  for (const [k, label] of Object.entries(FILTER_LABEL)) {
    const v = (f as any)[k]
    if (v) parts.push(`${label}: ${k === 'groupBy' ? def.groups?.[v] ?? v : VALUE_LABEL[v] ?? v}`)
  }
  if (f.sellerId) parts.push(`Vendedor/usuario #${f.sellerId}`)
  if (f.customerId) parts.push(`Cliente #${f.customerId}`)
  if (f.productId) parts.push(`Producto #${f.productId}`)
  if (f.sessionId) parts.push(`Turno #${f.sessionId}`)
  if (f.accountId) parts.push(`Cuenta #${f.accountId}`)
  return parts.join(' · ')
}

async function run(db: Db, user: { id: number; name: string; role: string }, def: ReportDef, query: Record<string, string | undefined>) {
  const filters = parseFilters(query)
  const result = await def.run({ db, user, filters })
  return { filters, result: applyPermissions(result, user.role) }
}

export function reportRoutes(app: FastifyInstance, db: Db) {
  app.get('/reports/catalog', async (req) => {
    const role = req.user!.role
    return REPORTS.filter((d) => d.perms.some((p) => can(role, p))).map(({ run: _r, perms: _p, ...d }) => d)
  })

  app.get('/reports/overview', async (req) => {
    anyPerm(req, ['reports.view'])
    return overviewReport({ db, user: req.user!, filters: parseFilters(req.query as any) })
  })

  app.get('/reports/:id', async (req) => {
    const def = REPORTS.find((d) => d.id === (req.params as any).id)
    if (!def) throw new HttpError(404, 'Reporte inexistente')
    anyPerm(req, def.perms)
    const q = req.query as Record<string, string | undefined>
    const { filters, result } = await run(db, req.user!, def, q)
    // Paginación (15 por defecto); los totales siempre son los de todos los registros filtrados
    const size = q.pageSize === 'all' ? 0 : [15, 30, 50, 100].includes(Number(q.pageSize)) ? Number(q.pageSize) : 15
    const page = Math.max(Number(q.page) || 1, 1)
    const total = result.rows.length
    const rows = size ? result.rows.slice((page - 1) * size, page * size) : result.rows
    return { ...result, rows, pagination: { page, pageSize: size || total, total, pages: size ? Math.max(Math.ceil(total / size), 1) : 1 }, filters, filtersText: describeFilters(filters, def), canExport: can(req.user!.role, 'reports.export') }
  })

  // Exporta TODOS los registros filtrados (no solo la página visible) con encabezado, filtros y totales.
  app.get('/reports/:id/export', async (req, reply) => {
    const def = REPORTS.find((d) => d.id === (req.params as any).id)
    if (!def) throw new HttpError(404, 'Reporte inexistente')
    anyPerm(req, def.perms)
    anyPerm(req, ['reports.export'])
    const q = req.query as Record<string, string | undefined>
    const { filters, result } = await run(db, req.user!, def, q)
    const picked = pickColumns(result, q.cols?.split(','))
    const shop = await getSetting(db, 'shop')
    const meta = { shopName: shop.name ?? 'Librería Samantha', address: shop.address, user: req.user!.name, generatedAt: new Date(), filtersText: describeFilters(filters, def) }
    const base = `${def.id}-${filters.from ?? ''}_${filters.to ?? ''}`.replace(/[^\w.-]/g, '')
    await db.query(`INSERT INTO audit_log (user_id, action, entity, detail) VALUES ($1,'report.export','report',$2)`, [req.user!.id, JSON.stringify({ id: def.id, format: q.format, rows: result.rows.length })])
    if (q.format === 'pdf') return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${base}.pdf"`).send(await buildPdf(picked, meta, { charts: q.charts === '1' }))
    if (q.format === 'csv') return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${base}.csv"`).send(buildCsv(picked))
    return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="${base}.xlsx"`).send(await buildXlsx(picked, meta))
  })
}
