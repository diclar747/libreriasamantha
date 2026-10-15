import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { HttpError, type Db } from './db/client.js'

export const ROLES = ['owner', 'admin', 'cashier', 'seller', 'buyer', 'warehouse', 'accountant', 'support'] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS: Record<Role, string[]> = {
  owner: ['*'],
  admin: ['*'],
  cashier: ['delivery.view', 'workorders.write', 'orders.manage', 'pos.sell', 'cash.manage', 'cash.withdraw', 'attachments.write', 'customers.read', 'customers.write', 'customers.collect', 'products.read', 'discount.limited'],
  seller: ['workorders.write', 'pos.sell', 'customers.read', 'products.read', 'discount.limited'],
  buyer: ['attachments.write', 'products.read', 'costs.view', 'purchases.write', 'purchases.view', 'suppliers.write', 'stock.read'],
  warehouse: ['delivery.view', 'orders.manage', 'products.read', 'stock.read', 'stock.adjust', 'purchases.receive', 'purchases.view'],
  accountant: ['expenses.write', 'purchases.view', 'purchases.invoice', 'suppliers.pay', 'reports.export', 'payments.settle', 'attachments.write', 'accounting.view', 'accounting.write', 'invoices.view', 'products.read', 'costs.view', 'reports.view', 'customers.read', 'stock.read'],
  support: ['delivery.view', 'orders.manage', 'workorders.write', 'products.read', 'customers.read', 'stock.read'],
}

export function can(role: string, perm: string) {
  const p = PERMISSIONS[role as Role] ?? []
  return p.includes('*') || p.includes(perm)
}

export interface AuthUser { id: number; username: string; name: string; role: string }
declare module 'fastify' {
  interface FastifyRequest { user?: AuthUser }
}

export function hashPassword(pw: string) {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 32).toString('hex')}`
}
export function verifyPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(':')
  if (!/^[0-9a-f]+$/.test(salt) || !/^[0-9a-f]{64}$/.test(hash ?? "")) return false
  const calc = scryptSync(pw, Buffer.from(salt, 'hex'), 32)
  return timingSafeEqual(calc, Buffer.from(hash, 'hex'))
}

export async function authenticate(db: Db, req: FastifyRequest) {
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  if (!token) throw new HttpError(401, 'No autenticado')
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.name, u.role, s.must_change FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND u.active`, [token])
  if (!rows[0]) throw new HttpError(401, 'Sesión inválida')
  // Ingresó con una clave por defecto: hasta que la cambie solo puede cambiarla o salir.
  if (rows[0].must_change && !/^\/api\/(me\/password|logout)(\?|$)/.test(req.url)) throw new HttpError(403, 'Tenés que cambiar tu contraseña antes de continuar')
  const { must_change: _m, ...user } = rows[0]
  req.user = user
}

export function requirePerm(req: FastifyRequest, perm: string) {
  if (!req.user || !can(req.user.role, perm)) throw new HttpError(403, 'Sin permiso')
}
export function anyPerm(req: FastifyRequest, perms: string[]) {
  if (!req.user || !perms.some((p) => can(req.user!.role, p))) throw new HttpError(403, 'Sin permiso')
}
export const newToken = () => randomBytes(32).toString('hex')

// Claves de fábrica / demasiado obvias: se aceptan para entrar pero obligan a cambiarlas, y no se pueden volver a elegir.
const DEFAULT_PASSWORDS = new Set(['admin1234', 'caja1234', 'compras1234', 'deposito1234', 'password', '12345678', '123456789', 'contraseña', 'samantha1234'])
export const isDefaultPassword = (pw: string) => DEFAULT_PASSWORDS.has(pw.toLowerCase())

// Límite de intentos fallidos de login (en memoria: una sola instancia). 6 por usuario+IP y 40 por IP cada 15 minutos.
const WINDOW_MS = 15 * 60_000
const fails = new Map<string, number[]>()
const recent = (k: string) => { const now = Date.now(); const l = (fails.get(k) ?? []).filter((t) => now - t < WINDOW_MS); if (l.length) fails.set(k, l); else fails.delete(k); return l }
export function clientIp(req: FastifyRequest) { return String(req.headers['cf-connecting-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ?? '') || req.ip }
export function loginBlocked(ip: string, username: string) {
  if (recent(`u:${ip}|${username.toLowerCase()}`).length >= 6 || recent(`ip:${ip}`).length >= 40) throw new HttpError(429, 'Demasiados intentos fallidos. Esperá 15 minutos e intentá de nuevo.')
}
export function loginFailed(ip: string, username: string) {
  for (const k of [`u:${ip}|${username.toLowerCase()}`, `ip:${ip}`]) fails.set(k, [...recent(k), Date.now()])
}
export function loginOk(ip: string, username: string) { fails.delete(`u:${ip}|${username.toLowerCase()}`) }
