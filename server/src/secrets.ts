import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Db } from './db/client.js'

// Los secretos (API de IA, clave privada VAPID) se guardan cifrados con AES-256-GCM.
// La llave maestra sale de APP_SECRET o, si no existe, de un archivo local `.app-secret` (fuera de git).
function masterKey(): Buffer {
  if (process.env.APP_SECRET) return createHash('sha256').update(process.env.APP_SECRET).digest()
  const file = fileURLToPath(new URL('../.app-secret', import.meta.url))
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 })
  return createHash('sha256').update(readFileSync(file, 'utf8').trim()).digest()
}

function encrypt(plain: string) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', masterKey(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.')
}
function decrypt(blob: string) {
  const [iv, tag, enc] = blob.split('.').map((p) => Buffer.from(p, 'base64'))
  const d = createDecipheriv('aes-256-gcm', masterKey(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
}

export async function setSecret(db: Db, key: string, value: string) {
  await db.query('INSERT INTO secrets (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()', [key, encrypt(value)])
}
export async function getSecret(db: Db, key: string): Promise<string | null> {
  const { rows } = await db.query('SELECT value FROM secrets WHERE key = $1', [key])
  if (!rows[0]) return null
  try { return decrypt(rows[0].value) } catch { return null }
}
export async function deleteSecret(db: Db, key: string) {
  await db.query('DELETE FROM secrets WHERE key = $1', [key])
}
