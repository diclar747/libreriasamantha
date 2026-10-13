import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import selfsigned from 'selfsigned'

// La cámara del teléfono solo funciona en páginas seguras (HTTPS). Para la red del local se genera un certificado
// autofirmado (hay que aceptarlo una vez en el teléfono). En producción conviene un certificado real: HTTPS_KEY / HTTPS_CERT.
export function lanAddresses() {
  return Object.values(networkInterfaces()).flat().filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
}

export async function loadHttpsOptions() {
  if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) return { key: readFileSync(process.env.HTTPS_KEY), cert: readFileSync(process.env.HTTPS_CERT) }
  const dir = fileURLToPath(new URL('../.certs/', import.meta.url))
  const keyFile = dir + 'dev-key.pem', certFile = dir + 'dev-cert.pem', ipsFile = dir + 'ips.json'
  const ips = lanAddresses()
  // Se regenera si cambió la dirección de la red local.
  if (existsSync(keyFile) && existsSync(certFile) && existsSync(ipsFile) && JSON.stringify(ips) === readFileSync(ipsFile, 'utf8')) return { key: readFileSync(keyFile), cert: readFileSync(certFile) }
  mkdirSync(dir, { recursive: true })
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'libreria.local' }], {
    algorithm: 'sha256', keySize: 2048, notAfterDate: new Date(Date.now() + 825 * 86400_000),
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7 as const, ip }))] }],
  })
  writeFileSync(keyFile, pems.private); writeFileSync(certFile, pems.cert); writeFileSync(ipsFile, JSON.stringify(ips))
  return { key: Buffer.from(pems.private), cert: Buffer.from(pems.cert) }
}
